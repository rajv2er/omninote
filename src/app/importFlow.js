import {
  decomposePdf,
  decomposeStoredPdfPage,
  renderPdfPageThumbnails,
  IMPORT_SCHEMA_VERSION,
  IMPORTED_OBJECT_VERSION,
} from "../pdf/decomposer.js";
import { composePageSizedFallback, PDF_IMPORT_SCALE } from "../pdf/importModel.js";
import { deleteAssets, putAsset } from "../storage/assets.js";
import { icon } from "../ui/icons.js";
import {
  showImportReport,
  showImportPagePicker,
  summarizeImport,
  showToast,
} from "../ui/dialogs.js";
import { isTauriApp } from "../updater.js";

/**
 * Creates the PDF import and page-promotion flow.
 *
 * The app shell keeps ownership of the notebook array, the canvas engines and
 * the loading overlay; this module owns the pipeline that turns a PDF into
 * pages and turns an annotated raster back into native objects. Dependencies
 * are injected so the flow can read the live state without importing it.
 *
 * @param {object} options
 * @param {() => object[]} options.getNotes
 * @param {(id: string) => void} options.setActiveId
 * @param {(note: object) => void} options.registerNote
 * @param {() => object|null} options.getActiveNote
 * @param {() => object[]} options.getCanvasEngines
 * @param {() => void} options.saveNotes
 * @param {(engine: object) => void} options.saveEngineToPage
 * @param {() => void} options.render
 * @param {(message: string) => void} options.setLoading
 * @param {() => void} options.clearLoading
 */
export function createImportFlow({
  getNotes,
  setActiveId,
  registerNote,
  getActiveNote,
  getCanvasEngines,
  saveNotes,
  saveEngineToPage,
  render,
  setLoading,
  clearLoading,
}) {
  async function persistPageAssets(page, createdAssetIds) {
    const ids = {};

    // When the only unrecovered content is the page's own backdrop, the extracted
    // backdrop image replaces the whole-page render. The render also contains the
    // content we recovered, so using it would paint everything twice — visibly,
    // because the raster's substituted font and the text object's font do not
    // share advance widths.
    let fallbackBlob = page.backgroundBlob;
    let fallbackFromImage = false;

    if (page.fallbackImage?.blob) {
      const composed = await composePageSizedFallback(
        page.fallbackImage.blob,
        page.fallbackImage,
        page.width,
        page.height,
      );
      if (composed) {
        fallbackBlob = composed;
        fallbackFromImage = true;
      }
    }

    if (fallbackBlob) {
      ids.backgroundAssetId = `bg-${crypto.randomUUID()}`;
      await putAsset(ids.backgroundAssetId, fallbackBlob);
      createdAssetIds.push(ids.backgroundAssetId);
    }

    if (page.thumbnailBlob) {
      ids.thumbnailAssetId = `thumb-${crypto.randomUUID()}`;
      await putAsset(ids.thumbnailAssetId, page.thumbnailBlob);
      createdAssetIds.push(ids.thumbnailAssetId);
    }

    // Embedded images are often the heaviest part of an export, so they go to the
    // asset store as real blobs rather than inline base64.
    for (const obj of page.objects || []) {
      if (obj.omniType === "image" && obj.blob) {
        const assetId = `img-${crypto.randomUUID()}`;
        await putAsset(assetId, obj.blob);
        createdAssetIds.push(assetId);
        obj.assetId = assetId;
        // The blob is binary and must never reach localStorage.
        delete obj.blob;
      }
    }

    // Drop the page-level blobs so nothing binary ends up persisted.
    return {
      ...page,
      ...ids,
      fallbackFromImage,
      backgroundBlob: undefined,
      thumbnailBlob: undefined,
    };
  }

  /**
   * True when an asset id is still the background of some *other* page, in any
   * notebook. Promotion replaces a page's raster, and deleting the old one
   * without this check would blank the pages that share it — a page copy shares
   * its source's asset ids by design.
   */
  function isBackgroundAssetShared(assetId, exceptPage) {
    if (!assetId) return false;
    for (const note of getNotes()) {
      for (const page of note.pages || []) {
        // A lazy page has not rendered its background yet; its null id is not a
        // shareable reference and must not pin anything.
        if (page === exceptPage) continue;
        if (page.backgroundAssetId === assetId) return true;
      }
    }
    return false;
  }

  /** Deletes a raster a promoted page no longer uses, unless a page copy needs it. */
  function releaseReplacedBackground(previousAssetId, page) {
    if (!previousAssetId || previousAssetId === page.backgroundAssetId) return;
    if (isBackgroundAssetShared(previousAssetId, page)) return;
    deleteAssets([previousAssetId]).catch(() => {});
  }

  /** True when a page still has an annotate-mode raster that could be rebuilt. */
  function isPromotablePage(page, note) {
    return Boolean(
      note?.pdfAssetId &&
        page &&
        Number.isInteger(page.pdfPageIndex) &&
        page.editMode !== "notes",
    );
  }

  /**
   * Promotion controls for the floating status pill.
   *
   * "Make editable" rebuilds the current page's content as native objects.
   * "Make all" is deliberately the cheap half only: it extracts the remaining
   * pages and stores the handoff, and each page's objects appear when it is
   * opened. Instantiating every page up front would stall a long notebook for no
   * benefit, since only the pages near the viewport are ever shown.
   */
  function promoteControlsHtml(note, page) {
    const promotable = (note?.pages || []).filter((p) => isPromotablePage(p, note));
    if (promotable.length === 0) return "";

    const busy = page?.conversionState === "converting";
    const currentIndex = note.currentPageIndex || 0;

    const pageButton = isPromotablePage(page, note)
      ? `<button class="page-promote-btn" id="make-editable-btn" data-promote-page="${currentIndex}" title="Rebuild this page's content as native objects you can select, move and edit. Anything that cannot be recovered stays visible underneath." ${busy ? "disabled" : ""}>${icon("sparkle", 13)}<span>${busy ? "Rebuilding…" : "Make editable"}</span></button>`
      : "";

    const allButton =
      promotable.length > 1
        ? `<button class="page-promote-btn is-quiet" id="make-all-editable-btn" data-promote-all="1" title="Rebuild all ${promotable.length} remaining annotated pages. Each page's content appears when you open it." ${busy ? "disabled" : ""}>${icon("sparkle", 13)}<span>All ${promotable.length}</span></button>`
        : "";

    return `<span class="promote-controls" id="promote-controls">${pageButton}${allButton}</span>`;
  }

  /**
   * Repaints the promotion controls in place.
   *
   * Deliberately not `render()`: rendering rebuilds every canvas engine and
   * resets the zoom, which is both wasteful and destructive mid-promotion.
   */
  function refreshPromoteControls(note) {
    const host = document.querySelector("#promote-controls");
    if (!host) return;

    const page = note?.pages?.[note.currentPageIndex || 0];
    const html = promoteControlsHtml(note, page);
    if (html) host.outerHTML = html;
    else host.remove();
  }

  /**
   * The extraction half of promotion for one page: rebuild its content, store the
   * binaries, and record the result on the page record.
   *
   * `instantiate` additionally swaps the live canvas over now, which is what the
   * single-page action does — the user asked for this page specifically and should
   * see it happen. Batch leaves it off: instantiation is already lazy, so forcing
   * it for pages nobody is looking at would only stall a long notebook.
   *
   * @returns {Promise<{status: "rebuilt"|"failed", restored: number}>}
   */
  async function rebuildPageAsEditable(note, page, { instantiate = false } = {}) {
    const createdAssetIds = [];

    try {
      const record = await decomposeStoredPdfPage(
        note.pdfAssetId,
        page.pdfPageIndex,
        PDF_IMPORT_SCALE,
      );

      // A scan or a flattened export decomposes to nothing. Replacing a perfectly
      // good raster with an empty page would be a visible regression, so this is
      // reported and the page stays in annotate mode.
      if (!record || !(record.objects || []).length) return { status: "failed", restored: 0 };

      const persisted = await persistPageAssets(record, createdAssetIds);
      const previousBackgroundId = page.backgroundAssetId;
      const engine = instantiate ? getCanvasEngines()[note.pages.indexOf(page)] : null;
      // Capture the page's own content before the reload replaces the canvas.
      const inkObjects = engine ? engine.serialize().objects || [] : null;

      page.backgroundAssetId = persisted.backgroundAssetId || null;
      page.thumbnailAssetId = persisted.thumbnailAssetId || page.thumbnailAssetId;
      page.fallbackVisible = persisted.fallbackVisible !== false;
      page.fallbackFromImage = persisted.fallbackFromImage === true;
      page.importReport = persisted.report || page.importReport;
      page.pendingImportData = {
        objects: persisted.objects || [],
        report: persisted.report || null,
      };
      page.pendingDecomposedData = null;
      page.editMode = "notes";
      page.decomposedObjects = true;

      let restored = 0;

      if (engine) {
        // `loadPage` restores canvasJson first, then the recovered handoff. The
        // user's ink is being re-applied below, so leaving it in canvasJson would
        // paint it twice. Drop it here; it comes back through addObjectsFromJson.
        page.canvasJson = null;
        await engine.loadPage(page);
        restored = await engine.addObjectsFromJson(inkObjects);
        // The live canvas is the authority from here on. Leaving the handoff in
        // place would make the next open prefer it and drop the restored ink.
        page.pendingImportData = null;
        page.canvasJson = engine.toJSON();
        engine.recordHistory();
      }

      page.conversionState = "idle";
      releaseReplacedBackground(previousBackgroundId, page);
      return { status: "rebuilt", restored };
    } catch (err) {
      await deleteAssets(createdAssetIds).catch(() => {});
      throw err;
    }
  }

  /**
   * Promotes one annotate-mode page to native objects — the "Make editable"
   * action.
   *
   * The page keeps its source PDF, so this re-runs extraction for that single page
   * and swaps the locked raster for real objects. Whatever the user already drew
   * on the raster is captured first and put back afterwards: promoting a page must
   * never cost the user their own annotations.
   */
  async function promotePageToEditable(pageIndex) {
    const note = getActiveNote();
    const page = note?.pages?.[pageIndex];
    if (!note || !page || page.conversionState === "converting") return;
    if (!isPromotablePage(page, note)) return;
    if (!getCanvasEngines()[pageIndex]) return;

    page.conversionState = "converting";
    refreshPromoteControls(note);

    try {
      const { status, restored } = await rebuildPageAsEditable(note, page, {
        instantiate: true,
      });

      if (status === "failed") {
        page.conversionState = "failed";
        refreshPromoteControls(note);
        showToast(
          "This page could not be rebuilt",
          "Its content is a scan or a flattened image, so it stays as an annotated PDF — you can still write on it.",
          "warn",
        );
        return;
      }

      saveNotes();
      refreshPromoteControls(note);
      showToast(
        "Page rebuilt",
        restored > 0
          ? `Its content is editable now, and the ${restored} object${restored === 1 ? "" : "s"} you had drawn are still here.`
          : "Its content is editable now — pick the Select tool to move things around.",
        "ok",
      );
    } catch (err) {
      page.conversionState = "failed";
      refreshPromoteControls(note);
      console.error("Could not make this page editable:", err);
      showToast("Could not rebuild this page", String(err?.message || err), "error");
    }
  }

  /**
   * Rebuilds every remaining annotated page.
   *
   * Sequential on purpose: pdf.js decoding is not free, and the app should stay
   * responsive through a long notebook. The page on screen is instantiated now so
   * the user sees the result; the rest are stored as handoffs and materialise when
   * opened.
   */
  async function makeAllPagesEditable() {
    const note = getActiveNote();
    if (!note) return;

    // Flush ALL live engines before the conversion loop so no engine is left
    // holding stale annotate-mode canvas data that would race with the handoff.
    for (const engine of getCanvasEngines()) {
      if (engine) saveEngineToPage(engine);
    }
    saveNotes();

    const targets = (note.pages || [])
      .map((page, index) => ({ page, index }))
      .filter(({ page }) => isPromotablePage(page, note));

    if (targets.length === 0) return;

    let rebuilt = 0;
    let failed = 0;

    for (const { page, index } of targets) {
      page.conversionState = "converting";
      refreshPromoteControls(note);

      try {
        const { status } = await rebuildPageAsEditable(note, page, {
          instantiate: !!getCanvasEngines()[index],
        });
        if (status === "rebuilt") {
          rebuilt++;
        } else {
          // Nothing recoverable (a scan, a flattened export): leave the raster
          // in place and say so, instead of leaving the page marked converting.
          page.conversionState = "failed";
          failed++;
        }
      } catch (err) {
        page.conversionState = "failed";
        failed++;
        console.error("Could not make a page editable:", err);
      }
    }

    saveNotes();
    refreshPromoteControls(note);
    showToast(
      failed === 0
        ? `${rebuilt} page${rebuilt === 1 ? "" : "s"} rebuilt`
        : "Some pages could not be rebuilt",
      failed === 0
        ? "Each page's content becomes editable when you open it."
        : `${rebuilt} rebuilt, ${failed} left as annotated PDF${failed === 1 ? "" : "s"}.`,
      failed === 0 ? "ok" : "warn",
    );
  }

  async function importPdfFile(file, importMode, promoteIndices = null) {
    setLoading(`Reading '${file.name}'...`);

    // Every asset this import creates, so a failure can clean up after itself
    // without touching anything an existing notebook owns.
    const createdAssetIds = [];

    try {
      const buffer = await file.arrayBuffer();

      // Persist each page's binary assets as soon as it is decomposed instead of
      // holding every page's background in memory until the document finishes.
      const pages = await decomposePdf(
        buffer,
        PDF_IMPORT_SCALE,
        async (page, index) => {
          setLoading(
            importMode === "annotations"
              ? `Rendering page ${index + 1}...`
              : `Recovering page ${index + 1}...`,
          );

          return persistPageAssets(page, createdAssetIds);
        },
        {
          mode: importMode,
          // Annotate-first import is the default, and the per-page snapshot is
          // the expensive half of it. Page 1 keeps its snapshot so the notebook
          // opens instantly; the rest are rendered from the source PDF by the
          // canvas engine the first time each page is opened.
          lazyBackgrounds: importMode === "annotations",
        },
      );

      if (pages.length === 0) {
        throw new Error("No pages found in this PDF.");
      }

      const baseName = file.name.replace(/\.pdf$/i, "");

      // Keep the original file. The per-page snapshot taken at import is only
      // ~1600px, which turns to mush once you zoom in; holding on to the source
      // lets the visible page be re-rendered at the current zoom.
      const pdfAssetId = `pdf-${crypto.randomUUID()}`;
      await putAsset(pdfAssetId, file);
      createdAssetIds.push(pdfAssetId);

      const report = summarizeImport(pages);

      // Built in memory first and committed only once every page succeeded.
      const newNotebook = {
        id: crypto.randomUUID(),
        title: baseName,
        createdAt: Date.now(),
        isPdf: true,
        pdfAssetId,
        importSchemaVersion: IMPORT_SCHEMA_VERSION,
        importReport: report,
        defaultFont: pages.mostUsedFont || "DM Sans",
        detectedFonts: pages.detectedFonts || [],
        currentPageIndex: 0,
        pages: pages.map((page, idx) => ({
          id: crypto.randomUUID(),
          pageNumber: idx + 1,
          pdfPageIndex: idx,
          width: page.width, // Exact native PDF page dimensions
          height: page.height,
          paperStyle: "plain",
          pageSize: "custom",
          thumbnail: null,
          backgroundAssetId: page.backgroundAssetId || null,
          thumbnailAssetId: page.thumbnailAssetId || null,
          canvasJson: null,
          importSchemaVersion: IMPORT_SCHEMA_VERSION,
          importedObjectVersion: page.importedObjectVersion ?? IMPORTED_OBJECT_VERSION,
          importReport: page.report || null,
          fallbackVisible: page.fallbackVisible !== false,
          // The fallback is the extracted backdrop, not a page render, so it must
          // not be replaced by a full-page re-rasterization on zoom — that would
          // reintroduce the very doubling it exists to avoid.
          fallbackFromImage: page.fallbackFromImage === true,
          // "Make editable" has already run for every page, so the notebook opens
          // with native objects. The annotate path leaves each page as a locked
          // raster the user promotes one at a time.
          editMode: importMode === "annotations" ? "annotate" : "notes",
          decomposedObjects: importMode !== "annotations",
          conversionState: "idle",
          // An annotate page carries no native objects, so there is nothing to
          // hand off — the locked raster loads straight from its asset id.
          pendingImportData:
            importMode === "annotations"
              ? null
              : {
                  objects: page.objects || [],
                  report: page.report || null,
                },
          tags: [],
        })),
      };

      registerNote(newNotebook);
      getNotes().unshift(newNotebook);
      setActiveId(newNotebook.id);
      saveNotes();

      // A subset import promotes only the pages the user chose; the rest stay
      // annotate-mode and are rebuilt on demand.
      if (Array.isArray(promoteIndices) && promoteIndices.length > 0) {
        await promotePagesByIndex(newNotebook, promoteIndices);
      }

      showImportReport(report);
    } catch (err) {
      // Nothing was committed, so delete only what this attempt created and leave
      // every existing notebook exactly as it was.
      await deleteAssets(createdAssetIds).catch(() => {});
      showToast("Could not import this PDF", String(err?.message || err), "error");
      console.error(err);
    } finally {
      clearLoading();
      render();
    }
  }

  /**
   * The "Choose pages…" flow: render thumbnails, ask which pages to decompose,
   * then import annotate-first and promote only that subset.
   */
  async function importPdfChoosePages(file) {
    setLoading(`Preparing pages from '${file.name}'...`);

    let thumbnails = [];
    try {
      const buffer = await file.arrayBuffer();
      thumbnails = await renderPdfPageThumbnails(buffer);
    } catch (err) {
      clearLoading();
      render();
      showToast("Could not read this PDF", String(err?.message || err), "error");
      console.error(err);
      return;
    } finally {
      clearLoading();
      render();
    }

    showImportPagePicker({
      fileName: file.name,
      thumbnails,
      onDone: (indices) => {
        for (const url of thumbnails) {
          if (url) URL.revokeObjectURL(url);
        }
        // null = the user chose "Annotate only" (or closed the picker): import
        // without promoting anything. An array promotes exactly those pages.
        importPdfFile(file, "annotations", indices);
      },
    });
  }


  /**
   * Shared entry point for importing a picked PDF, regardless of whether it came
   * from the hidden file input or the native dialog.
   */
  async function handlePdfImport(file) {
    if (!file) return;

    // Read the mode once, before any await, so a change mid-import cannot
    // produce a notebook that is half one thing and half the other.
    const modeValue = document.querySelector("#import-mode")?.value;
    const importMode =
      modeValue === "editable"
        ? "editable"
        : modeValue === "choose"
          ? "choose"
          : "annotations";

    // "Choose pages…" first asks which pages to decompose, then imports as
    // annotate-first and promotes only the chosen subset. Everything else
    // imports straight away.
    if (importMode === "choose") {
      await importPdfChoosePages(file);
      return;
    }

    await importPdfFile(file, importMode);
  }

  /**
   * Opens a PDF through the native dialog when running inside Tauri.
   * Returns a File, or null when the dialog is unavailable/cancelled.
   */
  async function pickPdfFileNative() {
    if (!isTauriApp()) return null;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const selected = await open({
        multiple: false,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!selected || Array.isArray(selected)) return null;
      const bytes = await readFile(selected);
      const name = String(selected).split("/").pop() || "imported.pdf";
      return new File([bytes], name, { type: "application/pdf" });
    } catch (err) {
      console.warn("Native PDF pick failed, falling back to file input:", err);
      return null;
    }
  }

  /**
   * Decomposes a chosen subset of pages right after an annotate-first import.
   * Reuses the same single-page extraction as "Make editable", but runs while the
   * notebook is still closed, so the recovered objects are stored as a handoff
   * and materialise when each page is first opened.
   */
  async function promotePagesByIndex(note, indices) {
    const targets = (note.pages || [])
      .map((page, index) => ({ page, index }))
      .filter(({ index }) => indices.includes(index))
      .filter(({ page }) => isPromotablePage(page, note));

    if (targets.length === 0) return;

    let rebuilt = 0;
    let failed = 0;

    for (const { page } of targets) {
      page.conversionState = "converting";
      try {
        const { status } = await rebuildPageAsEditable(note, page, {
          instantiate: false,
        });
        if (status === "rebuilt") rebuilt++;
        else failed++;
      } catch (err) {
        page.conversionState = "failed";
        failed++;
        console.error("Could not make a page editable:", err);
      }
    }

    saveNotes();
    if (failed > 0) {
      showToast(
        "Some pages could not be rebuilt",
        `${rebuilt} rebuilt, ${failed} left as annotated PDF${failed === 1 ? "" : "s"}.`,
        "warn",
      );
    }
  }

  return {
    releaseReplacedBackground,
    isPromotablePage,
    promoteControlsHtml,
    refreshPromoteControls,
    rebuildPageAsEditable,
    promotePageToEditable,
    makeAllPagesEditable,
    handlePdfImport,
    pickPdfFileNative,
  };
}
