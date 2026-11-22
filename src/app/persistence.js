import {
  canvasKeyForPage,
  deleteAssets,
  getPagePayload,
  pendingKeyForPage,
  putPagePayload,
} from "../storage/assets.js";

/**
 * Creates the notebook persistence layer.
 *
 * State stays owned by the app shell: callers pass the live `notes` array, the
 * normalization/hydration WeakSets, and the storage-warning callbacks. What
 * lives here is the format itself — the localStorage record, the IndexedDB
 * payload cache, lazy hydration, and the drain-before-unload bookkeeping.
 *
 * @param {object} options
 * @param {string} options.storeKey localStorage key for the notebook record
 * @param {() => object[]} options.getNotes live notebook array
 * @param {WeakSet<object>} options.normalizedNotes notebooks already normalized
 * @param {WeakSet<object>} options.hydratedPages pages whose payloads are loaded
 * @param {(err: unknown) => void} options.showStorageWarning
 * @param {() => void} options.clearStorageWarning
 * @param {() => void} [options.onSaved] called after a successful record write
 */
export function createPersistence({
  storeKey,
  getNotes,
  getFolders,
  getCustomColors,
  normalizedNotes,
  hydratedPages,
  showStorageWarning,
  clearStorageWarning,
  onSaved = () => {},
}) {
  function normalizeNote(n) {
    if (!n) return n;
    if (normalizedNotes.has(n)) return n;
    // Legacy cleanup. Before the asset store, imported pages kept full-size
    // dataURLs inline, which blows the localStorage quota. Drop them on load.
    for (const p of n.pages || []) {
      if (p.pendingDecomposedData?.backgroundDataUrl) {
        delete p.pendingDecomposedData.backgroundDataUrl;
      }
      if (typeof p.thumbnail === "string" && p.thumbnail.length > 20000) {
        p.thumbnail = null;
      }
      if (p.backgroundAssetId === undefined) p.backgroundAssetId = null;
      if (p.thumbnailAssetId === undefined) p.thumbnailAssetId = null;

      // Import schema v2 backfills. Every field is optional and additive: a
      // record written by any earlier version must still open, and a malformed
      // report must never block it.
      if (!Array.isArray(p.tags)) p.tags = [];
      if (p.importSchemaVersion === undefined) p.importSchemaVersion = 1;

      // `pendingDecomposedData` is the pre-v2 name for the same one-shot
      // handoff. Alias it forward rather than rewriting the record, so the
      // original asset ids are never discarded.
      if (!p.pendingImportData && p.pendingDecomposedData) {
        p.pendingImportData = p.pendingDecomposedData;
      }
      if (p.fallbackVisible === undefined) {
        // Records written before the flag existed predate the completeness
        // decision; keeping the fallback is the appearance-preserving default.
        p.fallbackVisible = true;
      }
      // Older records always used a whole-page render as their fallback, so
      // defaulting to false keeps their re-rasterization behaviour unchanged.
      if (p.fallbackFromImage === undefined) p.fallbackFromImage = false;

      // Which document owns this page. An imported page starts as a locked raster
      // the user writes on top of ("annotate") and can be promoted in place to
      // native objects ("notes"). A page that never came from a PDF is always
      // native, so it never offers promotion.
      if (p.pdfPageIndex == null) {
        p.editMode = "notes";
        p.decomposedObjects = true;
      } else if (p.editMode !== "annotate" && p.editMode !== "notes") {
        // Records written before the flag existed: anything already holding
        // decomposed objects, or an unconsumed import handoff, was an editable
        // import. Everything else was a raster-only import.
        p.decomposedObjects =
          p.decomposedObjects === true ||
          Boolean(p.pendingImportData || p.pendingDecomposedData);
        p.editMode = p.decomposedObjects ? "notes" : "annotate";
      }
      // A conversion in flight cannot survive a reload, so only a recorded
      // failure is restored; any other value means the page is idle.
      if (p.conversionState !== "failed") p.conversionState = "idle";

      const report = p.importReport;
      p.importReport =
        report && typeof report === "object" && typeof report.status === "string"
          ? {
              status: report.status,
              textObjects: Number(report.textObjects) || 0,
              vectorGroups: Number(report.vectorGroups) || 0,
              imageObjects: Number(report.imageObjects) || 0,
              fallbackRegions: Number(report.fallbackRegions) || 0,
              backdropImages: Number(report.backdropImages) || 0,
              fallbackFromImage: report.fallbackFromImage === true,
              unsupportedOperators: Number(report.unsupportedOperators) || 0,
              unsupportedAnnotations: Array.isArray(report.unsupportedAnnotations)
                ? report.unsupportedAnnotations
                : [],
              nonVisualAnnotations: Array.isArray(report.nonVisualAnnotations)
                ? report.nonVisualAnnotations
                : [],
              warnings: Array.isArray(report.warnings) ? report.warnings : [],
              errors: Array.isArray(report.errors) ? report.errors : [],
            }
          : null;
    }

    if (n.pinned === undefined) n.pinned = false;
    if (n.trashed === undefined) n.trashed = false;
    if (n.folderId === undefined) n.folderId = null;
    if (typeof n.scrollPosition !== "number") n.scrollPosition = 0;

    if (!Array.isArray(n.pages) || n.pages.length === 0) {
      n.pages = [
        {
          id: crypto.randomUUID(),
          pageNumber: 1,
          width: n.width || 800,
          height: n.height || 1130,
          paperStyle: n.paperStyle || "plain",
          pageSize: n.pageSize || "custom",
          thumbnail: n.thumbnail || null,
          canvasJson: n.canvasJson,
          pendingDecomposedData: n.pendingDecomposedData || null,
          pendingImportData: n.pendingImportData || null,
          importSchemaVersion: 1,
          fallbackVisible: true,
          importReport: null,
          // A page invented for a notebook that has none is native, never an
          // imported raster, so it is never a promotion candidate.
          editMode: "notes",
          conversionState: "idle",
          decomposedObjects: true,
          tags: [],
        },
      ];
    }
    if (
      n.currentPageIndex === undefined ||
      n.currentPageIndex >= n.pages.length
    ) {
      n.currentPageIndex = 0;
    }
    if (!n.defaultFont) {
      n.defaultFont = "DM Sans";
    }
    if (!Array.isArray(n.detectedFonts)) {
      n.detectedFonts = [];
    }
    if (n.detectedFonts.length === 0 && n.pages) {
      const detected = new Set();
      let mostUsed = null;
      for (const p of n.pages) {
        const pending = p.pendingImportData || p.pendingDecomposedData;
        if (pending?.detectedFonts) {
          pending.detectedFonts.forEach((f) => detected.add(f));
        }
        if (!mostUsed && pending?.mostUsedFont) {
          mostUsed = pending.mostUsedFont;
        }
      }
      if (detected.size > 0) {
        n.detectedFonts = Array.from(detected);
        if (n.defaultFont === "DM Sans" && mostUsed) {
          n.defaultFont = mostUsed;
        }
      }
    }
    normalizedNotes.add(n);
    return n;
  }

  function loadNotes() {
    try {
      const saved = JSON.parse(localStorage.getItem(storeKey));
      if (Array.isArray(saved) && saved.length > 0) {
        return saved.map(normalizeNote);
      }
      return null;
    } catch (e) {
      console.error('[loadNotes] Error:', e);
      return null;
    }
  }

  /**
   * The last JSON written to IndexedDB for each page payload, keyed by storage
   * key. Editing one page must not rewrite the other thirteen.
   * @type {Map<string, string>}
   */
  const persistedPayloads = new Map();

  /**
   * Payload writes that have not settled yet.
   *
   * The notebook record in localStorage is written synchronously, but the object
   * graph it refers to lands in IndexedDB asynchronously. A quit during that gap
   * leaves a page whose graph never arrived — it comes back blank, with no error.
   * These are tracked so the app can drain them before it goes away.
   * @type {Set<Promise<void>>}
   */
  const inFlightPayloads = new Set();

  /** Registers a payload write so it can be drained on unload. */
  function trackPayload(promise) {
    const tracked = promise
      .catch(() => {})
      .finally(() => inFlightPayloads.delete(tracked));
    inFlightPayloads.add(tracked);
    return tracked;
  }

  /**
   * Settles every payload write still in flight.
   *
   * Best-effort by nature: unload handlers get no time to await. It is still worth
   * doing, because backgrounding the app (visibilitychange) leaves the process
   * alive, and an already-open IndexedDB transaction usually completes.
   */
  function flushPayloads() {
    return Promise.all([...inFlightPayloads]);
  }

  /**
   * Writes a page payload, skipping the write when it has not changed.
   *
   * `null` means the payload was cleared, which deletes the stored copy. That
   * matters for the import handoff: leaving it behind would let a later load
   * rebuild the page from its original import data and silently discard every
   * edit the user has since made.
   */
  function persistPayload(key, value) {
    if (!key) return Promise.resolve();

    if (value == null) {
      if (persistedPayloads.get(key) === null) return Promise.resolve();
      persistedPayloads.set(key, null);
      return trackPayload(deleteAssets([key]).catch(() => {}));
    }

    let json;
    try {
      json = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
      return Promise.resolve();
    }
    if (persistedPayloads.get(key) === json) return Promise.resolve();

    persistedPayloads.set(key, json);
    return trackPayload(
      putPagePayload(key, json).catch((err) => {
        // Drop the cached value so the next save retries rather than believing
        // this payload is already stored.
        persistedPayloads.delete(key);
        console.warn("Could not store page data:", err);
      }),
    );
  }

  /**
   * Makes sure every page payload that is currently in memory has been written.
   *
   * `saveNotes` strips these payloads from the localStorage record, so anything
   * not yet in IndexedDB would be dropped on the floor — this is the safety net
   * for payloads that arrived some other way (a legacy record, or a page whose
   * graph was assigned directly).
   */
  function ensurePayloadsPersisted() {
    for (const note of getNotes()) {
      for (const page of note.pages || []) {
        // Missing means "not loaded yet" for notebooks outside the active one;
        // null means "explicitly cleared" (e.g. an import handoff consumed on
        // first open). Never turn an unloaded payload into a delete request:
        // saving notebook A must not erase notebook B's IndexedDB data.
        if (page.canvasJson !== undefined) {
          persistPayload(canvasKeyForPage(page), page.canvasJson);
        }
        if (
          page.pendingImportData !== undefined ||
          page.pendingDecomposedData !== undefined
        ) {
          persistPayload(
            pendingKeyForPage(page),
            page.pendingImportData ?? page.pendingDecomposedData ?? null,
          );
        }
      }
    }
  }

  /**
   * The localStorage shape of the notebooks: everything except the object graph
   * and the import handoff, which are far too large to live here.
   */
  function projectNotesForStorage() {
    return getNotes().map((note) => ({
      ...note,
      pages: (note.pages || []).map((page) => {
        const {
          canvasJson: _canvasJson,
          pendingImportData: _pendingImportData,
          pendingDecomposedData: _pendingDecomposedData,
          ...rest
        } = page;
        return rest;
      }),
    }));
  }

  /**
   * Loads every page's object graph back out of IndexedDB.
   *
   * Modern notebooks keep only the payload keys in localStorage, so the graph
   * must be loaded before a notebook can render. To keep the library fast, this
   * is now done lazily per-notebook instead of eagerly parsing every page in the
   * library at startup. Legacy notebooks that still have an inline canvasJson or
   * pendingImportData are migrated on first load.
   */
  async function hydratePage(page) {
    if (!page || hydratedPages.has(page)) return;

    const canvasKey = canvasKeyForPage(page);
    if (canvasKey && !page.canvasJson) {
      try {
        const json = await getPagePayload(canvasKey);
        if (typeof json === "string") {
          page.canvasJson = JSON.parse(json);
          persistedPayloads.set(canvasKey, json);
        }
      } catch (err) {
        console.error("[hydratePage] Error loading canvas for page", page.id, err);
      }
    }

    const pendingKey = pendingKeyForPage(page);
    // Load the handoff whenever it is not already in memory — even when a
    // canvas graph is present. A teardown save can persist an empty graph for
    // a page whose handoff was never consumed; skipping the handoff then
    // strands it in IndexedDB while the page reopens blank forever. loadPage
    // already layers both sources, so loading both is always safe.
    if (pendingKey && !page.pendingImportData && !page.pendingDecomposedData) {
      try {
        const json = await getPagePayload(pendingKey);
        if (typeof json === "string") {
          page.pendingImportData = JSON.parse(json);
          persistedPayloads.set(pendingKey, json);
        }
      } catch (err) {
        console.error("[hydratePage] Error loading pending for page", page.id, err);
      }
    }

    hydratedPages.add(page);
  }

  async function hydrateNote(note, indexes = null) {
    if (!note || !Array.isArray(note.pages)) return;

    const targetIndexes =
      Array.isArray(indexes)
        ? new Set(indexes)
        : new Set(
            Array.from(
              { length: Math.min(note.pages.length, 3) },
              (_, i) => Math.max(0, (note.currentPageIndex || 0) - 1 + i),
            ).filter((i) => i >= 0 && i < note.pages.length),
          );

    await Promise.all([...targetIndexes].map((i) => hydratePage(note.pages[i])));
  }

  /**
   * One-shot migration path for legacy notebooks that still store the object
   * graph inline in localStorage. Modern notebooks keep only payload keys, so
   * this is a no-op. The migration was removed when the storage format changed;
   * this stub is kept so the startup sequence doesn't need to change.
   */
  async function hydrateNotes() {
    // No-op: modern notebooks store payloads in IndexedDB, not localStorage.
  }

  /** True when the notebook's currently relevant page payloads are loaded. */
  function isNoteHydrated(note) {
    if (!note || !Array.isArray(note.pages)) return true;
    const idx = note.currentPageIndex || 0;
    for (let i = Math.max(0, idx - 1); i <= Math.min(note.pages.length - 1, idx + 1); i++) {
      if (!hydratedPages.has(note.pages[i])) return false;
    }
    return true;
  }

  function saveNotes() {
    // Nothing may be stripped from the record until it is safely stored.
    ensurePayloadsPersisted();

    try {
      localStorage.setItem(storeKey, JSON.stringify(projectNotesForStorage()));
      clearStorageWarning();
      onSaved();
      return true;
    } catch (e) {
      console.warn("Storage quota exceeded, stripping thumbnails:", e);
      // If local storage is full, strip heavy thumbnails to allow note save
      try {
        const stripped = projectNotesForStorage().map((n) => ({
          ...n,
          pages: n.pages.map((p) => ({ ...p, thumbnail: null })),
        }));
        localStorage.setItem(storeKey, JSON.stringify(stripped));
        onSaved();
        return true;
      } catch (err2) {
        console.error("Critical storage failure:", err2);
        // Losing the notebook silently is the worst possible outcome, so say so.
        showStorageWarning(err2);
        return false;
      }
    }
  }

  let lastSnapshotTime = 0;
  let snapshotTimer = null;

  async function snapshotNotes() {
    try {
      const payload = JSON.stringify({
        notes: projectNotesForStorage(),
        folders: JSON.parse(JSON.stringify(getFolders())),
        customColors: JSON.parse(JSON.stringify(getCustomColors())),
        exportedAt: Date.now(),
      });
      await putPagePayload("snapshot", payload);
      lastSnapshotTime = Date.now();
    } catch (err) {
      console.warn("Could not write recovery snapshot:", err);
    }
  }

  async function restoreFromSnapshot() {
    try {
      const raw = await getPagePayload("snapshot");
      if (typeof raw !== "string") return null;
      const data = JSON.parse(raw);
      if (!Array.isArray(data?.notes) || data.notes.length === 0) return null;
      return data.notes.map(normalizeNote);
    } catch (err) {
      console.warn("Could not restore from snapshot:", err);
      return null;
    }
  }

  function scheduleSnapshot() {
    if (snapshotTimer) return;
    const delay = Math.max(0, 5 * 60 * 1000 - (Date.now() - lastSnapshotTime));
    snapshotTimer = setTimeout(async () => {
      snapshotTimer = null;
      await snapshotNotes();
    }, delay);
  }

  return {
    normalizeNote,
    loadNotes,
    saveNotes,
    hydratePage,
    hydrateNote,
    hydrateNotes,
    isNoteHydrated,
    flushPayloads,
    projectNotesForStorage,
    pendingWrites: () => inFlightPayloads.size,
    snapshotNotes,
    restoreFromSnapshot,
    scheduleSnapshot,
  };
}
