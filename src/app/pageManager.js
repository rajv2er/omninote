import { Point } from "fabric";
import { canvasToBlob } from "../canvas/canvasBlob.js";
import { getCurrentZoom } from "../canvas/viewport.js";
import { exportNotebookToPdf, renderPageThumbnail } from "../pdf/exporter.js";
import { renderPdfPageBlob } from "../pdf/raster.js";
import {
  collectPageAssetIdsDeep,
  deleteAssets,
  getAssetUrl,
  putAsset,
} from "../storage/assets.js";
import { showConfirm, showPrompt, showToast } from "../ui/dialogs.js";
import {
  pageManagerTilesHtml as renderPageManagerTilesHtml,
  pageManagerOverlay as renderPageManagerOverlay,
} from "../ui/pageManagerView.js";

/**
 * Creates the Page Manager: the Noteful-style selection grid that reorders,
 * rotates, extracts, tags, copies, deletes, exports and promotes pages.
 *
 * The overlay owns its own transient state (open/closed, selection, drag,
 * clipboard, thumbnails, zoom to restore). Shared notebook state is read
 * through injected getters, and operations that rebuild the editor go through
 * the callbacks the app shell provides.
 *
 * @param {object} options
 * @param {() => object[]} options.getNotes
 * @param {() => object|null} options.getActiveNote
 * @param {() => object[]} options.getCanvasEngines
 * @param {() => object|null} options.getActiveCanvasEngine
 * @param {(id: string|null) => void} options.setActiveId
 * @param {() => void} options.saveNotes
 * @param {() => void} options.render
 * @param {() => void} options.saveActiveCanvasPage
 * @param {(engine: object) => void} options.saveEngineToPage
 * @param {(page: object) => void} options.forgetPageCaches
 * @param {(canvasEl: HTMLCanvasElement, page: object, note: object, index: number) => Promise<{engine: object}>} options.createPageEngine
 * @param {(imgEl: HTMLImageElement, page: object, note: object) => Promise<void>} options.setStaticPageThumbnail
 * @param {(note: object, indexes?: number[]) => Promise<void>} options.hydrateNote
 * @param {(message: string) => void} options.setLoading
 * @param {() => void} options.clearLoading
 * @param {() => void} options.refreshLoading
 * @param {(bytes: Uint8Array, filename: string, filters?: object[]|null) => Promise<boolean>} options.saveBytes
 * @param {(page: object, note: object) => boolean} options.isPromotablePage
 * @param {(note: object, page: object, opts?: object) => Promise<{status: string}>} options.rebuildPageAsEditable
 * @param {(note: object) => void} options.refreshPromoteControls
 * @param {(assetId: string, page: object) => void} options.releaseReplacedBackground
 * @param {(note: object) => void} options.forgetNoteNormalization
 * @param {(page: object) => void} options.markPageHydrated
 */
export function createPageManager({
  getNotes,
  getActiveNote,
  getCanvasEngines,
  getActiveCanvasEngine,
  setActiveId,
  saveNotes,
  render,
  saveActiveCanvasPage,
  saveEngineToPage,
  forgetPageCaches,
  createPageEngine,
  setStaticPageThumbnail,
  hydrateNote,
  setLoading,
  clearLoading,
  refreshLoading,
  saveBytes,
  isPromotablePage,
  rebuildPageAsEditable,
  refreshPromoteControls,
  releaseReplacedBackground,
  forgetNoteNormalization,
  markPageHydrated,
}) {
  // Page Manager (Noteful-style "Select" grid) state
  let showPageManager = false;
  let pageManagerSelection = new Set();
  let pageManagerAnchor = null;
  let pageManagerThumbs = [];
  let pageManagerPriorZoom = 1;
  let zoomRestoreTarget = null;
  // Live drag-to-reorder gesture in the Page Manager grid. Null when idle.
  let pageManagerDrag = null;
  // A completed drag also emits a click; that click must not toggle selection.
  // Cleared on the next pointerdown so it can never stay latched.
  let pageManagerSuppressClick = false;
  // Pointer travel before a press counts as a drag rather than a click.
  const PM_DRAG_THRESHOLD = 6;
  // Page-level clipboard for the Page Manager Copy / Cut / Paste ops. Each entry
  // is a fully cloned page object (new id, cloned canvasJson, shared asset ids).
  let pageClipboard = [];

  function pageManagerTilesHtml(note) {
    return renderPageManagerTilesHtml(note, pageManagerSelection, pageManagerThumbs);
  }

  function pageManagerOverlay(note) {
    if (!showPageManager) return "";
    // How many pages could still be rebuilt as editable objects. The op only
    // appears for a PDF notebook that has annotate-mode pages left.
    const promotableCount = (note?.pages || []).filter((p) =>
      isPromotablePage(p, note),
    ).length;
    return renderPageManagerOverlay(
      note,
      pageManagerSelection,
      pageManagerThumbs,
      pageClipboard.length,
      promotableCount,
    );
  }

  function updatePageManagerSelectionUI() {
    document.querySelectorAll("#page-manager-grid .pm-tile").forEach((t) => {
      const i = Number(t.dataset.index);
      t.classList.toggle("selected", pageManagerSelection.has(i));
    });
    const note = getActiveNote();
    const sub = document.querySelector(".pm-sub");
    if (sub) {
      sub.textContent = `${note.pages.length} page${note.pages.length !== 1 ? "s" : ""}${
        pageManagerSelection.size
          ? ` · ${pageManagerSelection.size} selected`
          : ""
      }`;
    }
    const hasSel = pageManagerSelection.size > 0;
    [
      "pm-rotate",
      "pm-delete",
      "pm-extract",
      "pm-share",
      "pm-copy",
      "pm-cut",
      "pm-tag",
      "pm-make-editable",
    ].forEach((id) => {
      const b = document.querySelector("#" + id);
      if (b) b.disabled = !hasSel;
    });
    const pasteBtn = document.querySelector("#pm-paste");
    if (pasteBtn) pasteBtn.disabled = pageClipboard.length === 0;
  }

  function clearPageManagerDropMarkers() {
    document
      .querySelectorAll("#page-manager-grid .pm-tile.pm-drop-target")
      .forEach((t) => t.classList.remove("pm-drop-target"));
  }

  /**
   * Where an index lands after `from` is spliced out and re-inserted at `to`.
   * Reordering shifts everything between the two, so the selection, the shift
   * anchor, the thumbnails and the active page all have to be remapped or they
   * end up pointing at the wrong pages.
   */
  function remapIndexForMove(index, from, to) {
    if (index === from) return to;
    if (from < to && index > from && index <= to) return index - 1;
    if (to < from && index >= to && index < from) return index + 1;
    return index;
  }

  function reorderPages(from, to) {
    const note = getActiveNote();
    if (!note || !Array.isArray(note.pages)) return;
    if (from === to) return;
    if (from < 0 || to < 0 || from >= note.pages.length || to >= note.pages.length) {
      return;
    }

    forgetNoteNormalization(note);
    const [moved] = note.pages.splice(from, 1);
    note.pages.splice(to, 0, moved);

    // Thumbnails are index-aligned with pages. Moving them together means the
    // grid can be repainted from the existing images instead of re-rendering
    // every page after a drop.
    pageManagerThumbs.splice(to, 0, pageManagerThumbs.splice(from, 1)[0]);

    note.pages.forEach((p, i) => {
      p.pageNumber = i + 1;
    });

    pageManagerSelection = new Set(
      Array.from(pageManagerSelection, (i) => remapIndexForMove(i, from, to)),
    );
    if (pageManagerAnchor !== null) {
      pageManagerAnchor = remapIndexForMove(pageManagerAnchor, from, to);
    }
    note.currentPageIndex = remapIndexForMove(note.currentPageIndex, from, to);

    saveNotes();
    // The editor's page stack is rendered from `note.pages`, so it has to be
    // rebuilt for the new order to take effect. Hold the zoom across it.
    zoomRestoreTarget = getCurrentZoom();
    render();
  }

  function bindPageManagerGrid() {
    document.querySelectorAll("#page-manager-grid .pm-tile").forEach((tile) => {
      const i = Number(tile.dataset.index);

      tile.addEventListener("click", (e) => {
        if (pageManagerSuppressClick) {
          pageManagerSuppressClick = false;
          return;
        }
        if (e.shiftKey && pageManagerAnchor !== null) {
          const a = Math.min(pageManagerAnchor, i);
          const b = Math.max(pageManagerAnchor, i);
          for (let k = a; k <= b; k++) pageManagerSelection.add(k);
        } else {
          if (pageManagerSelection.has(i)) pageManagerSelection.delete(i);
          else pageManagerSelection.add(i);
          pageManagerAnchor = i;
        }
        updatePageManagerSelectionUI();
      });

      // Drag-to-reorder.
      //
      // Pointer events rather than HTML5 drag-and-drop: the same gesture then
      // works with a mouse, trackpad and stylus, and click-to-select keeps
      // working because a press only becomes a drag past a small threshold.
      tile.addEventListener("pointerdown", (e) => {
        pageManagerSuppressClick = false;
        // A touch drag should scroll the grid, not start a reorder.
        if (e.button !== 0 || e.pointerType === "touch") return;
        pageManagerDrag = {
          index: i,
          startX: e.clientX,
          startY: e.clientY,
          active: false,
          over: null,
        };
        tile.setPointerCapture?.(e.pointerId);
      });

      tile.addEventListener("pointermove", (e) => {
        const drag = pageManagerDrag;
        if (!drag || drag.index !== i) return;

        if (!drag.active) {
          const travelled = Math.hypot(
            e.clientX - drag.startX,
            e.clientY - drag.startY,
          );
          if (travelled < PM_DRAG_THRESHOLD) return;
          drag.active = true;
          tile.classList.add("pm-dragging");
        }

        // Pointer capture routes events to this tile, so hit-test explicitly to
        // find which tile is actually under the cursor.
        const under = document.elementFromPoint(e.clientX, e.clientY);
        const target = under && under.closest ? under.closest(".pm-tile") : null;
        const over = target && target !== tile ? Number(target.dataset.index) : null;

        if (over !== drag.over) {
          clearPageManagerDropMarkers();
          drag.over = over;
          if (over !== null) target.classList.add("pm-drop-target");
        }
      });

      const finishDrag = (e) => {
        const drag = pageManagerDrag;
        if (!drag || drag.index !== i) return;
        pageManagerDrag = null;
        tile.releasePointerCapture?.(e.pointerId);
        tile.classList.remove("pm-dragging");
        clearPageManagerDropMarkers();

        // An ordinary click falls through to the click handler above.
        if (!drag.active) return;
        pageManagerSuppressClick = true;
        if (drag.over !== null && drag.over !== i) reorderPages(i, drag.over);
      };

      tile.addEventListener("pointerup", finishDrag);
      tile.addEventListener("pointercancel", finishDrag);
    });
  }

  function bindPageManagerControls() {
    document
      .querySelector("#pm-close")
      ?.addEventListener("click", closePageManager);
    document.querySelector("#pm-select-all")?.addEventListener("click", () => {
      const note = getActiveNote();
      pageManagerSelection = new Set(note.pages.map((_, i) => i));
      updatePageManagerSelectionUI();
    });
    document.querySelector("#pm-clear")?.addEventListener("click", () => {
      pageManagerSelection = new Set();
      updatePageManagerSelectionUI();
    });
    document.querySelector("#pm-insert")?.addEventListener("click", pmInsert);
    document.querySelector("#pm-rotate")?.addEventListener("click", pmRotate);
    document.querySelector("#pm-delete")?.addEventListener("click", pmDelete);
    document.querySelector("#pm-extract")?.addEventListener("click", pmExtract);
    document.querySelector("#pm-share")?.addEventListener("click", pmShare);
    document.querySelector("#pm-copy")?.addEventListener("click", pmCopy);
    document.querySelector("#pm-cut")?.addEventListener("click", pmCut);
    document.querySelector("#pm-paste")?.addEventListener("click", pmPaste);
    document.querySelector("#pm-tag")?.addEventListener("click", pmTag);
    document
      .querySelector("#pm-make-editable")
      ?.addEventListener("click", pmMakeEditable);
  }

  async function regeneratePageManagerThumbs() {
    const note = getActiveNote();
    pageManagerThumbs = [];
    for (let i = 0; i < note.pages.length; i++) {
      try {
        pageManagerThumbs[i] = await renderPageThumbnail(note.pages[i], 260, {
          pdfAssetId: note.pdfAssetId,
        });
      } catch {
        pageManagerThumbs[i] = null;
      }
    }
  }

  async function openPageManager() {
    if (showPageManager) return;
    const note = getActiveNote();
    if (!note) return;
    saveActiveCanvasPage();
    pageManagerPriorZoom = getCurrentZoom();
    await regeneratePageManagerThumbs();
    pageManagerSelection = new Set();
    pageManagerAnchor = null;
    showPageManager = true;
    zoomRestoreTarget = pageManagerPriorZoom;
    render();
  }

  function closePageManager() {
    showPageManager = false;
    pageManagerSelection = new Set();
    pageManagerAnchor = null;
    zoomRestoreTarget = pageManagerPriorZoom;
    render();
  }

  function clonePageForExtract(page) {
    return {
      id: crypto.randomUUID(),
      pageNumber: 1,
      width: page.width,
      height: page.height,
      paperStyle: page.paperStyle || "plain",
      pageSize: page.pageSize || "custom",
      thumbnail: null,
      backgroundAssetId: page.backgroundAssetId || null,
      thumbnailAssetId: null,
      tags: Array.isArray(page.tags) ? page.tags.slice() : [],
      canvasJson: page.canvasJson
        ? JSON.parse(JSON.stringify(page.canvasJson))
        : null,
      pendingImportData: null,
      pendingDecomposedData: null,
      pdfPageIndex:
        typeof page.pdfPageIndex === "number" ? page.pdfPageIndex : null,
      editMode: page.editMode === "annotate" ? "annotate" : "notes",
      fallbackVisible: page.fallbackVisible !== false,
      fallbackFromImage: page.fallbackFromImage === true,
      conversionState: "idle",
      decomposedObjects: page.decomposedObjects === true,
      importReport: page.importReport
        ? JSON.parse(JSON.stringify(page.importReport))
        : null,
      pdfBackgroundRotated: page.pdfBackgroundRotated === true,
      pdfRotation: page.pdfRotation || 0,
    };
  }

  function rotateObjectAbout(obj, oldW, oldH, newW, newH) {
    const c = obj.getCenterPoint();
    const dx = c.x - oldW / 2;
    const dy = c.y - oldH / 2;
    // Clockwise 90° about the page centre, then map into the swapped page.
    const nx = newW / 2 + -dy;
    const ny = newH / 2 + dx;
    obj.set({ angle: (obj.angle || 0) + 90 });
    if (typeof obj.setPositionByOrigin === "function") {
      obj.setPositionByOrigin(new Point(nx, ny), "center", "center");
    } else {
      obj.set({ left: nx, top: ny });
    }
    obj.setCoords();
  }

  async function rotateBackground90(page, note, oldW) {
    if (page.fallbackVisible === false) return null;

    // A PDF page imported as annotations may have no saved raster yet. Rasterize
    // it on demand before rotating; otherwise the dimensions change but the
    // unrotated source gets stretched over the new page on the next mount.
    let url = page.backgroundAssetId
      ? await getAssetUrl(page.backgroundAssetId)
      : null;
    let transient = false;
    if (!url && note?.pdfAssetId && Number.isInteger(page.pdfPageIndex)) {
      const source = await renderPdfPageBlob(
        note.pdfAssetId,
        page.pdfPageIndex,
        Math.min(1600, Math.round(oldW)),
      );
      if (!source?.blob) throw new Error("Could not render PDF page before rotation");
      url = URL.createObjectURL(source.blob);
      transient = true;
    }
    if (!url) return null;

    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const rotated = document.createElement("canvas");
      rotated.width = img.naturalHeight;
      rotated.height = img.naturalWidth;
      const ctx = rotated.getContext("2d");
      ctx.translate(rotated.width, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(img, 0, 0);
      const blob = await canvasToBlob(rotated);
      if (!blob) throw new Error("Could not encode rotated PDF page");
      const assetId = `bg-${crypto.randomUUID()}`;
      await putAsset(assetId, blob);
      return assetId;
    } finally {
      if (transient) URL.revokeObjectURL(url);
    }
  }

  async function rotateEnginePage90(engine, page, note) {
    const canvas = engine.canvas;
    const oldW = engine.width;
    const oldH = engine.height;
    const newW = oldH;
    const newH = oldW;
    // Prepare and store the rotated raster *before* changing page geometry, so
    // an encode/store failure leaves the original page untouched.
    const previousBackgroundId = page.backgroundAssetId;
    const rotatedBackgroundId = await rotateBackground90(page, note, oldW);
    canvas.discardActiveObject();
    canvas
      .getObjects()
      .slice()
      .forEach((o) => rotateObjectAbout(o, oldW, oldH, newW, newH));
    if (canvas.backgroundImage)
      rotateObjectAbout(canvas.backgroundImage, oldW, oldH, newW, newH);
    engine.width = newW;
    engine.height = newH;
    page.width = newW;
    page.height = newH;
    canvas.setDimensions({ width: newW, height: newH });
    // Rotated pages need a durable raster, not just a transformed in-memory
    // Fabric image. The PDF source still has its original orientation and must
    // never replace this raster when the engine is mounted again.
    if (rotatedBackgroundId) {
      page.backgroundAssetId = rotatedBackgroundId;
      page.pdfBackgroundRotated = true;
      page.pdfRotation = ((page.pdfRotation || 0) + 90) % 360;
      engine.setPdfBackgroundSource(null);
      engine._bgRasterToken++;
      await engine.loadBackgroundAsset(rotatedBackgroundId);
      releaseReplacedBackground(previousBackgroundId, page);
    }
    engine.setZoom(engine.currentZoom, { force: true, resetPan: true });
    canvas.requestRenderAll();
    engine.recordHistory();
  }

  async function pmInsert() {
    const note = getActiveNote();
    if (!note.pages.length) return;
    const idx = pageManagerSelection.size
      ? Math.max(...pageManagerSelection)
      : note.currentPageIndex;
    const ref = note.pages[Math.min(idx, note.pages.length - 1)] || note.pages[0];
    const insertedPage = {
      id: crypto.randomUUID(),
      pageNumber: idx + 2,
      width: ref.width || 800,
      height: ref.height || 1130,
      paperStyle: ref.paperStyle || "lined",
      pageSize: "custom",
      thumbnail: null,
      canvasJson: null,
      pendingDecomposedData: null,
    };
    forgetNoteNormalization(note);
    markPageHydrated(insertedPage);
    note.pages.splice(idx + 1, 0, insertedPage);
    pageManagerSelection = new Set();
    saveNotes();
    await regeneratePageManagerThumbs();
    zoomRestoreTarget = pageManagerPriorZoom;
    render();
  }

  async function pmDelete() {
    const note = getActiveNote();
    if (note.pages.length <= 1) return;
    if (
      !(await showConfirm(
        `Delete ${pageManagerSelection.size} selected page(s)? This cannot be undone.`,
        "Delete",
        "Cancel",
      ))
    )
      return;
    const indices = Array.from(pageManagerSelection).sort((a, b) => b - a);
    for (const i of indices) {
      if (note.pages.length <= 1) break;
      forgetNoteNormalization(note);
      const [removed] = note.pages.splice(i, 1);
      forgetPageCaches(removed);
      // Don't delete assets still referenced by other (e.g. copied) pages.
      // The deep form matters here: a copy shares the source's embedded images
      // through its object graph, not through the notebook record.
      // Assets can be shared across notebooks (extracted/copied pages), so the
      // "still used" set must cover every notebook, not just this one.
      const remainingIds = new Set();
      for (const otherNote of getNotes()) {
        for (const p of otherNote.pages || []) {
          for (const id of await collectPageAssetIdsDeep(p)) remainingIds.add(id);
        }
      }
      const ids = (await collectPageAssetIdsDeep(removed)).filter(
        (id) => id && !remainingIds.has(id),
      );
      if (ids.length) await deleteAssets(ids);
    }
    if (note.currentPageIndex >= note.pages.length)
      note.currentPageIndex = note.pages.length - 1;
    pageManagerSelection = new Set();
    saveNotes();
    await regeneratePageManagerThumbs();
    zoomRestoreTarget = pageManagerPriorZoom;
    render();
  }

  /**
   * Runs `fn(engine)` against a page that currently has no live engine.
   *
   * The Page Manager acts on pages the user is not looking at, so the sliding
   * window holds no engine for most of them. Rather than duplicating every
   * object-graph transform in JSON space, the page is briefly mounted on its own
   * (hidden) canvas, transformed, written back and torn down again — which keeps
   * the transform on exactly the same code path as the on-screen case.
   */
  async function withTemporaryEngine(page, index, fn) {
    const note = getActiveNote();
    if (!note || !page) return;

    const existing = getCanvasEngines()[index];
    if (existing) {
      await fn(existing);
      saveEngineToPage(existing);
      return;
    }

    const canvasEl = document.querySelector(`#omni-canvas-${index}`);
    const thumbEl = document.querySelector(`#omni-thumb-${index}`);
    if (!canvasEl) return;

    const hadJson = Boolean(page.canvasJson);
    const canvasWasHidden = canvasEl.hidden;
    canvasEl.hidden = false;
    if (thumbEl) thumbEl.hidden = true;

    const { engine } = await createPageEngine(canvasEl, page, note, index);
    try {
      await fn(engine);
    } finally {
      // Only write back when there is something to write. An annotate-only page
      // has no object graph, and inventing an empty one would make the Page
      // Manager prefer it over the source-PDF preview.
      if (hadJson || engine.canvas.getObjects().length > 0) {
        saveEngineToPage(engine);
      }
      engine.destroy();
      canvasEl.hidden = canvasWasHidden;
      if (thumbEl && !canvasWasHidden) {
        thumbEl.hidden = false;
        setStaticPageThumbnail(thumbEl, page, note);
      }
    }
  }

  async function pmRotate() {
    const note = getActiveNote();
    const indices = Array.from(pageManagerSelection).sort((a, b) => a - b);
    if (!indices.length) return;
    for (const i of indices) {
      const page = note.pages[i];
      if (!page) continue;
      // Pages outside the sliding window have no engine; mount one for the
      // rotation so selecting any page in the grid actually rotates it.
      await withTemporaryEngine(page, i, (engine) =>
        rotateEnginePage90(engine, page, note),
      );
    }
    saveActiveCanvasPage();
    pageManagerSelection = new Set();
    saveNotes();
    await regeneratePageManagerThumbs();
    zoomRestoreTarget = pageManagerPriorZoom;
    render();
  }

  async function pmExtract() {
    const note = getActiveNote();
    const indices = Array.from(pageManagerSelection).sort((a, b) => a - b);
    if (!indices.length) return;
    saveActiveCanvasPage();
    const pages = indices.map((i) => clonePageForExtract(note.pages[i]));
    pages.forEach((p, idx) => {
      p.pageNumber = idx + 1;
      markPageHydrated(p);
    });
    const newNote = {
      id: crypto.randomUUID(),
      title: `${note.title} (extracted)`,
      createdAt: Date.now(),
      isPdf: note.isPdf || false,
      pdfAssetId: note.pdfAssetId || null,
      defaultFont: note.defaultFont || "DM Sans",
      detectedFonts: note.detectedFonts || [],
      currentPageIndex: 0,
      pages,
    };
    getNotes().unshift(newNote);
    saveNotes();
    showPageManager = false;
    setActiveId(null);
    render();
  }

  async function pmShare() {
    const note = getActiveNote();
    const indices = Array.from(pageManagerSelection).sort((a, b) => a - b);
    if (!indices.length) return;
    setLoading("Exporting selected pages...");
    try {
      await hydrateNote(note);
      const pdfBytes = await exportNotebookToPdf(
        note,
        getActiveCanvasEngine(),
        (curr, total) => {
          setLoading(`Exporting page ${curr} of ${total}...`);
        },
        indices,
      );
      const cleanTitle = (note.title || "OmniNote_Document").replace(/[/\\?%*:|"<>]/g, "-");
      await saveBytes(pdfBytes, `${cleanTitle}.pdf`, [
        { name: "PDF", extensions: ["pdf"] },
      ]);
    } catch (err) {
      showToast("Export failed", String(err?.message || err), "error");
      console.error(err);
    } finally {
      clearLoading();
      refreshLoading();
    }
  }

  // Deep-clone a page for the clipboard / paste / extract flows. A fresh id is
  // assigned; asset ids are intentionally shared (read-only) so copying a page
  // that uses an imported background does not duplicate the blob.
  function clonePageData(page) {
    return {
      id: crypto.randomUUID(),
      pageNumber: 1,
      width: page.width,
      height: page.height,
      paperStyle: page.paperStyle || "plain",
      pageSize: page.pageSize || "custom",
      thumbnail: page.thumbnail || null,
      backgroundAssetId: page.backgroundAssetId || null,
      thumbnailAssetId: page.thumbnailAssetId || null,
      pdfAssetId: page.pdfAssetId || null,
      pdfPageIndex:
        typeof page.pdfPageIndex === "number" ? page.pdfPageIndex : null,
      canvasJson: page.canvasJson
        ? JSON.parse(JSON.stringify(page.canvasJson))
        : null,
      pendingImportData: null,
      pendingDecomposedData: null,
      tags: Array.isArray(page.tags) ? page.tags.slice() : [],
      editMode: page.editMode === "annotate" ? "annotate" : "notes",
      fallbackVisible: page.fallbackVisible !== false,
      fallbackFromImage: page.fallbackFromImage === true,
      conversionState: "idle",
      decomposedObjects: page.decomposedObjects === true,
      importReport: page.importReport
        ? JSON.parse(JSON.stringify(page.importReport))
        : null,
      pdfBackgroundRotated: page.pdfBackgroundRotated === true,
      pdfRotation: page.pdfRotation || 0,
    };
  }

  // Re-render just the thumbnail grid (used after Tag so we don't rebuild engines).
  function refreshPageManagerGrid() {
    const note = getActiveNote();
    const grid = document.querySelector("#page-manager-grid");
    if (grid) {
      grid.innerHTML = pageManagerTilesHtml(note);
      bindPageManagerGrid();
    }
    updatePageManagerSelectionUI();
  }

  /**
   * Rebuilds the selected annotate-mode pages as editable objects, in place.
   *
   * The Page Manager stays open and the user keeps annotating; the current page
   * is instantiated so the result is visible immediately, the rest are stored as
   * handoffs that materialise when each page is opened. This is the in-editor
   * counterpart to the import-time "Choose pages…" picker.
   */
  async function pmMakeEditable() {
    const note = getActiveNote();
    if (!note || !pageManagerSelection.size) return;

    // Persist any in-flight edits before records are rewritten.
    saveActiveCanvasPage();

    const indices = Array.from(pageManagerSelection).sort((a, b) => a - b);
    const currentIndex = note.currentPageIndex || 0;

    const btn = document.querySelector("#pm-make-editable");
    if (btn) {
      btn.disabled = true;
      btn.querySelector("span").textContent = "Rebuilding…";
    }

    let rebuilt = 0;
    let failed = 0;

    for (const index of indices) {
      const page = note.pages[index];
      if (!isPromotablePage(page, note)) continue;

      page.conversionState = "converting";
      try {
        const { status } = await rebuildPageAsEditable(note, page, {
          instantiate: index === currentIndex,
        });
        if (status === "rebuilt") {
          rebuilt++;
        } else {
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
    await regeneratePageManagerThumbs();
    // Full render so the toolbar's promotable count and button state update; the
    // overlay stays open because `showPageManager` is module-level state.
    zoomRestoreTarget = pageManagerPriorZoom;
    render();
    refreshPromoteControls(note);

    showToast(
      failed === 0
        ? `${rebuilt} page${rebuilt === 1 ? "" : "s"} rebuilt`
        : "Some pages could not be rebuilt",
      failed === 0
        ? "Each page's content is editable when you open it."
        : `${rebuilt} rebuilt, ${failed} left as annotated PDF${failed === 1 ? "" : "s"}.`,
      failed === 0 ? "ok" : "warn",
    );
  }

  function pmCopy() {
    const note = getActiveNote();
    if (!pageManagerSelection.size) return;
    const indices = Array.from(pageManagerSelection).sort((a, b) => a - b);
    pageClipboard = indices.map((i) => clonePageData(note.pages[i]));
    updatePageManagerSelectionUI();
  }

  async function pmCut() {
    const note = getActiveNote();
    if (note.pages.length <= 1 || !pageManagerSelection.size) return;
    const indices = Array.from(pageManagerSelection).sort((a, b) => b - a);
    const clones = [];
    for (const i of indices) {
      if (note.pages.length <= 1) break;
      clones.unshift(clonePageData(note.pages[i]));
      const [removed] = note.pages.splice(i, 1);
      forgetPageCaches(removed);
    }
    pageClipboard = clones;
    if (note.currentPageIndex >= note.pages.length)
      note.currentPageIndex = note.pages.length - 1;
    pageManagerSelection = new Set();
    saveNotes();
    await regeneratePageManagerThumbs();
    zoomRestoreTarget = pageManagerPriorZoom;
    render();
  }

  async function pmPaste() {
    const note = getActiveNote();
    if (!pageClipboard.length) return;
    const clones = pageClipboard.map((p) => clonePageData(p));
    const target = pageManagerSelection.size
      ? Math.max(...pageManagerSelection)
      : note.pages.length - 1;
    forgetNoteNormalization(note);
    for (const page of clones) markPageHydrated(page);
    note.pages.splice(target + 1, 0, ...clones);
    pageManagerSelection = new Set();
    saveNotes();
    await regeneratePageManagerThumbs();
    zoomRestoreTarget = pageManagerPriorZoom;
    render();
  }

  async function pmTag() {
    const note = getActiveNote();
    if (!pageManagerSelection.size) return;
    const tag = (await showPrompt("Tag the selected pages (single tag):", ""))?.trim();
    if (!tag) return;
    for (const i of pageManagerSelection) {
      const p = note.pages[i];
      p.tags = Array.isArray(p.tags) ? p.tags : [];
      if (!p.tags.includes(tag)) p.tags.push(tag);
    }
    saveNotes();
    refreshPageManagerGrid();
  }

  /**
   * Writes one page's binary assets to IndexedDB and returns the page record with
   * asset ids in place of blobs.
   *
   * Shared by the importer and by single-page promotion, so a promoted page ends
   * up exactly the shape the importer produces. `createdAssetIds` collects
   * everything written, so a failed operation can clean up after itself without
   * touching an asset an existing notebook owns.
   */

  /**
   * Returns the zoom to restore on the next editor mount, if one is pending.
   * Reading consumes it: the Page Manager sets it for exactly one transition.
   */
  function consumeZoomRestoreTarget() {
    const target = zoomRestoreTarget;
    zoomRestoreTarget = null;
    return target;
  }

  return {
    pageManagerOverlay,
    openPageManager,
    closePageManager,
    isPageManagerOpen: () => showPageManager,
    bindPageManagerGrid,
    bindPageManagerControls,
    consumeZoomRestoreTarget,
  };
}
