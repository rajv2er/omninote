import "./style.css";
import { OmniCanvas, MIN_ZOOM, MAX_ZOOM } from "./canvas/engine.js";
import { Point } from "fabric";
import { ZoomWindow } from "./canvas/zoomWindow.js";
import {
  decomposePdf,
  IMPORT_SCHEMA_VERSION,
  IMPORTED_OBJECT_VERSION,
} from "./pdf/decomposer.js";
import { invalidatePdfDoc } from "./pdf/raster.js";
import { exportNotebookToPdf, renderPageThumbnail } from "./pdf/exporter.js";
import {
  putAsset,
  deleteAssets,
  getAssetUrl,
  collectNoteAssetIds,
  collectPageAssetIds,
  canvasKeyForPage,
  pendingKeyForPage,
  putPagePayload,
  getPagePayload,
} from "./storage/assets.js";
import { composePageSizedFallback } from "./pdf/importModel.js";

const STORE_KEY = "omninote-notes-v2";
const FOLDERS_KEY = "omninote-folders";

const PAGE_SIZES = {
  a4: { label: "A4 (Standard)", width: 800, height: 1130 },
  letter: { label: "US Letter", width: 800, height: 1035 },
  slide: { label: "16:9 Slide", width: 1200, height: 675 },
  square: { label: "Square (1:1)", width: 800, height: 800 },
};

const FOLDER_PREFIX = "folder:";

function loadFolders() {
  try {
    const arr = JSON.parse(localStorage.getItem(FOLDERS_KEY));
    if (Array.isArray(arr)) {
      return arr.filter((f) => f && typeof f.id === "string" && typeof f.name === "string");
    }
  } catch {}
  return [];
}

function saveFolders() {
  try {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
  } catch {
    // Best-effort; the folder list is never worth losing the page over.
  }
}

let folders = loadFolders();

const sampleNote = {
  id: "welcome-note",
  title: "Welcome to OmniNote",
  createdAt: Date.now(),
  isPdf: false,
  currentPageIndex: 0,
  pages: [
    {
      id: "page-1",
      pageNumber: 1,
      width: 800,
      height: 1130,
      paperStyle: "lined",
      pageSize: "a4",
      thumbnail: null,
      canvasJson: null,
      pendingDecomposedData: null,
    },
  ],
};

let notes = loadNotes();
let activeId = notes[0]?.id || null;
let canvasEngines = [];
let currentTool = "select";
let currentColor = "#176a72";
let currentWidth = 4;
let currentPenStyle = "ballpoint";
/** Every palette starts from this, so there is always at least one colour. */
const DEFAULT_COLOR = "#176a72";
/** Two-column rail: eleven swatches plus the add button. */
const MAX_SWATCHES = 11;

let customColors = [];
try {
  customColors =
    JSON.parse(localStorage.getItem("omninote-custom-colors")) || [];
} catch {}
if (!Array.isArray(customColors) || customColors.length === 0) {
  customColors = [DEFAULT_COLOR];
}

/**
 * Colour picker state.
 *
 * There is exactly one native colour input in the app and it is inert (see
 * `.swatch-edit-input`). Previously every swatch owned a hidden input inside
 * its own <label>, so the browser forwarded clicks into it and decided when
 * the picker opened: after the first pick the input kept focus, a repeat click
 * was swallowed, and no `change` fired when the value was unchanged — the
 * picker appeared to work once and then go dead.
 *
 * Opening is now explicit and the open/closed state is tracked here rather
 * than inferred from the browser.
 */
let colorPickerOpen = false;
/** Called once with the chosen colour when the picker commits. */
let colorPickerApply = null;

function saveCustomColors() {
  // The palette can never be emptied — there is always one colour to draw with.
  if (!Array.isArray(customColors) || customColors.length === 0) {
    customColors = [DEFAULT_COLOR];
  }
  try {
    localStorage.setItem("omninote-custom-colors", JSON.stringify(customColors));
  } catch {
    // A colour preference is never worth failing an edit over.
  }
}

/** Dims the add button once the rail is full. */
function refreshAddColorButton() {
  const btn = document.querySelector("#add-color-btn");
  if (!btn) return;
  const full = customColors.length >= MAX_SWATCHES;
  btn.disabled = full;
  btn.title = full ? "Colour limit reached" : "Add a new color";
}

/**
 * Opens the shared colour picker on `seed`.
 *
 * `showPicker()` is the only API that opens a colour input deterministically,
 * and it throws `NotAllowedError` unless called from inside a user gesture —
 * so this must stay synchronous with the click that triggered it.
 *
 * @param {string} seed colour the picker starts on (the one currently applied)
 * @param {(hex: string) => void} apply called with the committed colour
 */
function openColorPicker(seed, apply) {
  const input = document.querySelector("#color-picker-input");
  if (!input) return;
  // Ignore re-entry: a second request while the picker is up would dismiss it
  // the moment it appears.
  if (colorPickerOpen) return;

  colorPickerOpen = true;
  colorPickerApply = typeof apply === "function" ? apply : null;
  // Start from the applied colour so re-opening shows the current value.
  input.value = seed || currentColor;

  try {
    if (typeof input.showPicker === "function") {
      input.showPicker();
    } else {
      // A focused colour input ignores a programmatic click — dropping focus
      // first is what makes a repeat click work.
      input.blur();
      input.click();
    }
  } catch {
    colorPickerOpen = false;
    colorPickerApply = null;
    try {
      input.click();
    } catch {
      /* No picker available in this browser. */
    }
  }
}

/**
 * Ends a picker session. `value` is null when the user cancelled, in which
 * case nothing is applied and the previously selected colour stays as it was.
 */
function commitColorPicker(value) {
  if (!colorPickerOpen) return;
  colorPickerOpen = false;
  const apply = colorPickerApply;
  colorPickerApply = null;
  if (apply && value) apply(value);
}
let isLoading = false;
let loadingMessage = "";
let showShapesFlyout = false;
let showPageSetup = false;
let activeFolder = "unfiled";
let currentZoom = 1;

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

function normalizeNote(n) {
  if (!n) return n;
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
        canvasJson: n.canvasJson || null,
        pendingDecomposedData: n.pendingDecomposedData || null,
        pendingImportData: n.pendingImportData || null,
        importSchemaVersion: 1,
        fallbackVisible: true,
        importReport: null,
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
  return n;
}

function loadNotes() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (Array.isArray(saved) && saved.length > 0) {
      return saved.map(normalizeNote);
    }
    return [normalizeNote(sampleNote)];
  } catch {
    return [normalizeNote(sampleNote)];
  }
}

/**
 * The last JSON written to IndexedDB for each page payload, keyed by storage
 * key. Editing one page must not rewrite the other thirteen.
 * @type {Map<string, string>}
 */
const persistedPayloads = new Map();

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
    return deleteAssets([key]).catch(() => {});
  }

  let json;
  try {
    json = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return Promise.resolve();
  }
  if (persistedPayloads.get(key) === json) return Promise.resolve();

  persistedPayloads.set(key, json);
  return putPagePayload(key, json).catch((err) => {
    // Drop the cached value so the next save retries rather than believing
    // this payload is already stored.
    persistedPayloads.delete(key);
    console.warn("Could not store page data:", err);
  });
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
  for (const note of notes) {
    for (const page of note.pages || []) {
      // Pass null rather than skipping, so a cleared payload is deleted
      // instead of being left to resurrect on the next load.
      persistPayload(canvasKeyForPage(page), page.canvasJson ?? null);
      persistPayload(
        pendingKeyForPage(page),
        page.pendingImportData ?? page.pendingDecomposedData ?? null,
      );
    }
  }
}

/**
 * The localStorage shape of the notebooks: everything except the object graph
 * and the import handoff, which are far too large to live here.
 */
function projectNotesForStorage() {
  return notes.map((note) => ({
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
 * Must finish before the first render, otherwise every imported page would
 * come up blank.
 */
async function hydrateNotes() {
  const jobs = [];

  for (const note of notes) {
    for (const page of note.pages || []) {
      const canvasKey = canvasKeyForPage(page);
      if (canvasKey && !page.canvasJson) {
        jobs.push(
          getPagePayload(canvasKey)
            .then((json) => {
              if (typeof json === "string") {
                page.canvasJson = JSON.parse(json);
                // Seed the cache so the first save does not rewrite it.
                persistedPayloads.set(canvasKey, json);
              }
            })
            .catch(() => {}),
        );
      } else if (canvasKey && page.canvasJson) {
        // Legacy inline graph: keep it, and let the next save move it across.
        jobs.push(Promise.resolve());
      }

      // The import handoff is only a fallback for a page that has no persisted
      // graph yet. Once one exists it is authoritative, so restoring the
      // handoff would rebuild the page and throw away the user's edits.
      const pendingKey = pendingKeyForPage(page);
      if (
        pendingKey &&
        !page.canvasJson &&
        !page.pendingImportData &&
        !page.pendingDecomposedData
      ) {
        jobs.push(
          getPagePayload(pendingKey)
            .then((json) => {
              if (typeof json === "string") {
                page.pendingImportData = JSON.parse(json);
                persistedPayloads.set(pendingKey, json);
              }
            })
            .catch(() => {}),
        );
      }
    }
  }

  await Promise.all(jobs);
}

function saveNotes() {
  // Nothing may be stripped from the record until it is safely stored.
  ensurePayloadsPersisted();

  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(projectNotesForStorage()));
    clearStorageWarning();
    return true;
  } catch (e) {
    console.warn("Storage quota exceeded, stripping thumbnails:", e);
    // If local storage is full, strip heavy thumbnails to allow note save
    try {
      const stripped = projectNotesForStorage().map((n) => ({
        ...n,
        pages: n.pages.map((p) => ({ ...p, thumbnail: null })),
      }));
      localStorage.setItem(STORE_KEY, JSON.stringify(stripped));
      return true;
    } catch (err2) {
      console.error("Critical storage failure:", err2);
      // Losing the notebook silently is the worst possible outcome, so say so.
      showStorageWarning(err2);
      return false;
    }
  }
}

/**
 * Tells the user their notebook could not be saved.
 *
 * The object graph is JSON in localStorage, which has a ~5 MB ceiling — a real
 * multi-page handwriting import blows past it, and without this the only
 * symptom is that the notebook is missing after a reload.
 */
function showStorageWarning(error) {
  // Dedupe on presence rather than a flag: the import report toast removes
  // itself from the DOM, and a flag would then suppress the warning forever.
  if (document.querySelector(".storage-warning")) return;

  const card = document.createElement("div");
  // Its own class, deliberately NOT `.import-report` — the completion toast
  // clears anything with that class and would wipe this warning out.
  card.className = "storage-warning";
  card.setAttribute("role", "alert");

  const title = document.createElement("strong");
  title.textContent = "This notebook is too large to save";
  card.appendChild(title);

  const detail = document.createElement("span");
  detail.textContent =
    "It is open and editable, but changes will be lost when you reload. " +
    "Export it to PDF to keep a copy, or split it into smaller notebooks.";
  card.appendChild(detail);

  const reason = document.createElement("em");
  reason.textContent = String(error?.name || error?.message || "Storage is full");
  card.appendChild(reason);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "import-report-close";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => card.remove());
  card.appendChild(close);

  document.body.appendChild(card);
  // Deliberately not auto-dismissed: this one matters.
}

/** Clears the warning once a save finally succeeds. */
function clearStorageWarning() {
  document.querySelector(".storage-warning")?.remove();
}

function getActiveNote() {
  const note = notes.find((n) => n.id === activeId);
  return normalizeNote(note);
}

function getCurrentPage() {
  const note = getActiveNote();
  if (!note || !note.pages) return null;
  return note.pages[note.currentPageIndex] || note.pages[0];
}

function getActiveCanvasEngine() {
  const note = getActiveNote();
  if (!note || canvasEngines.length === 0) return null;
  return canvasEngines[note.currentPageIndex] || canvasEngines[0];
}

const ZOOM_MIN = MIN_ZOOM;
const ZOOM_MAX = MAX_ZOOM;
const ZOOM_STEP = 1.25;
// Freezes every zoom path. Guards against a stray pinch while writing.
let zoomLocked = false;
// Noteful-style magnified writing strip. Created once, re-pointed per page.
let zoomWindow = null;

/** Single place that keeps the label, the slider and `currentZoom` in sync. */
function updateZoomUI(z) {
  currentZoom = z;
  const pct = Math.round(z * 100);
  const value = document.querySelector("#zoom-value");
  // Never overwrite the field while the user is typing into it.
  if (value && document.activeElement !== value) value.value = pct;
  const slider = document.querySelector("#zoom-slider");
  if (slider) slider.value = pct;
}

/** Content-space box of a page wrapper, independent of the current scroll. */
function pageContentBox(wrap, contRect, container) {
  const r = wrap.getBoundingClientRect();
  return {
    left: r.left - contRect.left + container.scrollLeft,
    top: r.top - contRect.top + container.scrollTop,
    width: r.width,
    height: r.height,
  };
}

/**
 * Remembers which spot of the document a given screen point is showing.
 *
 * Zooming resizes every page, which shifts all the following ones and used to
 * throw the reader's place away. The anchor is stored as *fractions* of the
 * page box it lands on, so it is zoom-invariant: restoring re-measures the page
 * at its new size and puts the same fraction back under the same screen point.
 * Storing raw pixel offsets instead is what made a long pinch drift — every
 * step re-measured its own output and locked in the previous step's error.
 *
 * @param {number|null} clientX screen point to hold still (pinch cursor);
 *   defaults to the middle of the viewport, which is what the slider uses.
 */
function captureZoomAnchor(clientX = null, clientY = null) {
  const container = document.querySelector("#canvas-scroll-container");
  if (!container) return null;

  const contRect = container.getBoundingClientRect();
  let ox = container.clientWidth / 2;
  let oy = container.clientHeight / 2;
  if (clientX !== null && clientY !== null) {
    const px = clientX - contRect.left;
    const py = clientY - contRect.top;
    // Only trust the cursor when it is actually over the page area; synthetic
    // or off-window events would otherwise anchor to a nonsense point.
    if (px >= 0 && px <= contRect.width && py >= 0 && py <= contRect.height) {
      ox = px;
      oy = py;
    }
  }

  const wraps = Array.from(container.querySelectorAll(".page-container"));
  if (wraps.length === 0) return null;

  const contentX = container.scrollLeft + ox;
  const contentY = container.scrollTop + oy;

  // The page the anchor point is actually over — not necessarily the "active"
  // page, which is only the one the observer last reported.
  let best = null;
  let bestDist = Infinity;
  for (const wrap of wraps) {
    const box = pageContentBox(wrap, contRect, container);
    const overshoot =
      contentY < box.top
        ? box.top - contentY
        : contentY > box.top + box.height
          ? contentY - (box.top + box.height)
          : 0;
    if (overshoot < bestDist) {
      bestDist = overshoot;
      best = { index: Number(wrap.dataset.index ?? 0), box };
    }
  }
  if (!best) return null;

  return {
    container,
    index: best.index,
    fx: best.box.width > 0 ? (contentX - best.box.left) / best.box.width : 0,
    fy: best.box.height > 0 ? (contentY - best.box.top) / best.box.height : 0,
    ox,
    oy,
  };
}

/** Puts the spot captured by `captureZoomAnchor` back under the same screen point. */
function restoreZoomAnchor(anchor) {
  if (!anchor) return;
  try {
    const { container, index, fx, fy, ox, oy } = anchor;
    const wrap =
      document.querySelector(`#page-wrapper-${index}`) ||
      document.querySelector(".page-container");
    if (!wrap) return;
    const contRect = container.getBoundingClientRect();
    const box = pageContentBox(wrap, contRect, container);

    // The workspace scrolls smoothly, which is lovely for page-to-page jumps
    // but poisonous here: a smooth scroll is an animation, so reading the
    // offset back returns the *old* value and the next event of a pinch
    // restarts it from there. Anchoring has to land in one frame.
    const prevBehavior = container.style.scrollBehavior;
    container.style.scrollBehavior = "auto";
    container.scrollLeft = box.left + fx * box.width - ox;
    container.scrollTop = box.top + fy * box.height - oy;
    container.style.scrollBehavior = prevBehavior;
  } catch {
    // Anchoring is a comfort feature; a bad measurement must never break zoom.
  }
}

/**
 * A pinch is one continuous gesture, so its anchor is measured once when the
 * fingers land and held for the duration. Re-measuring per event made the
 * target drift, because each step anchored to the previous step's result.
 */
let zoomGestureAnchor = null;
function beginZoomGesture(clientX, clientY) {
  zoomGestureAnchor = captureZoomAnchor(clientX, clientY);
}
function endZoomGesture() {
  zoomGestureAnchor = null;
  // The gesture was tracked by scaling the existing bitmap so it could keep up
  // with the fingers; now that it has settled, re-render every page at the
  // final resolution so ink and text are crisp again.
  for (const engine of canvasEngines) engine.commitZoomPreview();
}

/**
 * Turns off the browser's own page zoom.
 *
 * By default a trackpad pinch (or Ctrl+scroll, or Cmd +/-) scales the *entire
 * tab* — toolbar, tool rail and panels included — which both wrecks the layout
 * and double-scales the canvas. Only the page should ever zoom, and only via
 * `setZoom`, so every route the browser offers is swallowed here.
 */
function disableBrowserZoom() {
  // Chrome, Edge and Firefox deliver a trackpad pinch as a burst of ctrl+wheel.
  // `wheel` defaults to passive on window/document/body, so `passive: false`
  // is required for preventDefault to do anything at all.
  window.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    },
    { passive: false },
  );

  // Safari uses real gesture events for a pinch and bypasses wheel entirely.
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    window.addEventListener(type, (e) => e.preventDefault(), {
      passive: false,
    });
  }

  // Two-finger pinch on a touchscreen.
  window.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length > 1) e.preventDefault();
    },
    { passive: false },
  );

  // Keyboard page zoom. This only suppresses the browser default — our own
  // Cmd/Ctrl +/-/0 shortcuts are separate listeners and still fire.
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (
      e.key === "+" ||
      e.key === "=" ||
      e.key === "-" ||
      e.key === "_" ||
      e.key === "0"
    ) {
      e.preventDefault();
    }
  });

  // Belt and braces: browsers that honour the viewport meta will refuse to
  // pinch-zoom the document at all.
  const meta = document.querySelector('meta[name="viewport"]');
  if (meta) {
    meta.setAttribute(
      "content",
      "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no",
    );
  }
}

function setZoom(
  zoom,
  { reset = false, resetPan = true, force = false, preview = false } = {},
) {
  if (zoomLocked && !force) return;
  const next = reset ? 1 : Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
  // A pinch holds one anchor for the whole gesture; everything else measures
  // fresh each time, which is stable because the anchor is zoom-invariant.
  const anchor = zoomGestureAnchor || captureZoomAnchor();
  updateZoomUI(next);
  for (const engine of canvasEngines) {
    engine.setZoom(next, { resetPan, force, preview });
  }
  restoreZoomAnchor(anchor);
}

/** Toggles the zoom freeze and pushes the state down to every engine. */
function toggleZoomLock() {
  zoomLocked = !zoomLocked;
  for (const engine of canvasEngines) engine.zoomLocked = zoomLocked;
  const btn = document.querySelector("#zoom-lock-btn");
  if (btn) {
    btn.innerHTML = icon(zoomLocked ? "lockClosed" : "lockOpen", 14);
    btn.title = zoomLocked ? "Zoom locked — click to unlock" : "Lock zoom";
    btn.classList.toggle("is-locked", zoomLocked);
  }
}

/**
 * Opening zoom. Wide imported pages are the common case, so pull back to fit
 * width — but never zoom past 100%, since magnifying a small page on open is
 * more surprising than helpful.
 */
function applyDefaultZoom() {
  const engine = getActiveCanvasEngine();
  const avail = getAvailableViewport();
  if (!engine || !avail || !engine.width) return;
  const fit = avail.width / engine.width;
  const z = Math.min(1, Math.max(ZOOM_MIN, fit));
  if (z < 1) setZoom(z, { force: true });
}

// --------------------------------------------------------------- zoom window

/** Points the zoom window at whichever page is currently active. */
function attachZoomWindow() {
  if (!zoomWindow) return;
  const note = getActiveNote();
  if (!note) return;
  const engine = getActiveCanvasEngine();
  const pageEl = document.querySelector(
    `#page-wrapper-${note.currentPageIndex}`,
  );
  if (!engine || !pageEl) return;
  zoomWindow.attach(engine, pageEl);
}

function initZoomWindow() {
  const stripEl = document.querySelector("#zw-canvas");
  const boxEl = document.querySelector("#zw-box");
  if (!stripEl || !boxEl) return;
  if (!zoomWindow) zoomWindow = new ZoomWindow({ stripEl, boxEl });
  attachZoomWindow();
}

function toggleZoomWindow(force) {
  if (!zoomWindow) return;
  const next = force === undefined ? !zoomWindow.visible : force;
  const wrap = document.querySelector("#zoom-window");
  if (next) {
    attachZoomWindow();
    zoomWindow.show();
    if (wrap) wrap.hidden = false;
  } else {
    zoomWindow.hide();
    if (wrap) wrap.hidden = true;
  }
  document.querySelector("#zw-toggle")?.classList.toggle("is-active", next);
}

function zoomIn() {
  setZoom(currentZoom * ZOOM_STEP);
}
function zoomOut() {
  setZoom(currentZoom / ZOOM_STEP);
}
function zoomReset() {
  setZoom(1, { reset: true });
}

/**
 * Usable drawing area inside the scroll viewport, excluding its padding.
 * Returns null if the editor is not mounted.
 */
function getAvailableViewport() {
  const container = document.querySelector("#canvas-scroll-container");
  if (!container) return null;
  const style = getComputedStyle(container);
  const padX =
    (parseFloat(style.paddingLeft) || 0) +
    (parseFloat(style.paddingRight) || 0);
  const padY =
    (parseFloat(style.paddingTop) || 0) +
    (parseFloat(style.paddingBottom) || 0);
  return {
    width: container.clientWidth - padX,
    height: container.clientHeight - padY,
  };
}

/**
 * Fits the active page to the viewport. `"width"` fills the width and lets
 * you scroll vertically; `"page"` fits the whole page on screen at once.
 */
function zoomFit(mode = "width") {
  const engine = getActiveCanvasEngine();
  const avail = getAvailableViewport();
  if (!engine || !avail || !engine.width || !engine.height) return;
  const ratioW = avail.width / engine.width;
  const ratioH = avail.height / engine.height;
  setZoom(mode === "page" ? Math.min(ratioW, ratioH) : ratioW, {
    resetPan: true,
  });
}

// Crisp, professional SVG icons
function icon(name, size = 18) {
  const s = size;
  const icons = {
    back: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
    chevronRight: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
    pen: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`,
    marker: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><line x1="2" y1="22" x2="22" y2="22" stroke-width="4" stroke-linecap="round"/></svg>`,
    eraser: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>`,
    select: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 7 18 3-7 7-3L3 3z"/></svg>`,
    text: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`,
    shapes: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="10" height="10" x="3" y="3" rx="1.5"/><circle cx="16" cy="16" r="6"/></svg>`,
    image: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
    delete: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`,
    undo: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>`,
    redo: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>`,
    upload: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M12 19v-7"/><polyline points="9 15 12 12 15 15"/></svg>`,
    download: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M12 12v7"/><polyline points="9 16 12 19 15 16"/></svg>`,
    zoomIn: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`,
    zoomOut: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`,
    zoomWindow: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="14" x2="21" y2="14"/><line x1="7" y1="18.5" x2="17" y2="18.5"/></svg>`,
    chevronLeft: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
    close: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    lockClosed: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
    lockOpen: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`,
    fitWidth: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 12h8"/><polyline points="11 9.5 8 12 11 14.5"/><polyline points="13 9.5 16 12 13 14.5"/></svg>`,
    fitPage: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 9 4 4 9 4"/><polyline points="15 4 20 4 20 9"/><polyline points="20 15 20 20 15 20"/><polyline points="9 20 4 20 4 15"/></svg>`,
    grid: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>`,
    folder: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`,
    pin: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>`,
    trash: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`,
    search: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
    plus: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    chevronDown: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
    pages: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/><path d="M21 7v12a2 2 0 0 1-2 2h-1V9a2 2 0 0 0-2-2h-3"/></svg>`,
    rotate: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`,
    copy: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    cut: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>`,
    paste: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>`,
    tag: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`,
    star: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
    starFilled: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
    restore: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>`,
  };
  return icons[name] || "";
}

function render() {
  const app = document.querySelector("#app");
  const note = getActiveNote();

  if (note) {
    currentZoom = 1;
    app.innerHTML = editorView(note);
    initEditor(note);
  } else {
    if (zoomWindow) zoomWindow.hide();
    canvasEngines.forEach((engine) => engine.destroy());
    canvasEngines = [];
    app.innerHTML = libraryView();
    bindLibraryEvents();
  }

  renderLoading();
}

function renderLoading() {
  const existing = document.querySelector(".loading-overlay");
  if (existing) existing.remove();

  if (isLoading) {
    const overlay = document.createElement("div");
    overlay.className = "loading-overlay";
    overlay.innerHTML = `
      <div class="spinner"></div>
      <div>${loadingMessage || "Processing..."}</div>
    `;
    document.body.appendChild(overlay);
  }
}

function notesInCurrentView() {
  // What the library should show right now, given `activeFolder`.
  // activeFolder is "unfiled" | "pinned" | "trashed" | "folder:<id>".
  if (activeFolder === "pinned") {
    return notes.filter((n) => n.pinned && !n.trashed);
  }
  if (activeFolder === "trashed") {
    return notes.filter((n) => n.trashed);
  }
  if (activeFolder && activeFolder.startsWith(FOLDER_PREFIX)) {
    const id = activeFolder.slice(FOLDER_PREFIX.length);
    return notes.filter((n) => !n.trashed && n.folderId === id);
  }
  // Unfiled: not trashed, not pinned, no folder.
  return notes.filter((n) => !n.trashed && !n.pinned && !n.folderId);
}

function noteCount(bucket) {
  if (bucket === "unfiled") {
    return notes.filter((n) => !n.trashed && !n.pinned && !n.folderId).length;
  }
  if (bucket === "pinned") {
    return notes.filter((n) => n.pinned && !n.trashed).length;
  }
  if (bucket === "trashed") {
    return notes.filter((n) => n.trashed).length;
  }
  return 0;
}

function libraryHeading() {
  if (activeFolder === "pinned") return "Pinned";
  if (activeFolder === "trashed") return "Trash";
  if (activeFolder && activeFolder.startsWith(FOLDER_PREFIX)) {
    return folderById(activeFolder.slice(FOLDER_PREFIX.length))?.name || "Folder";
  }
  return "Unfiled";
}

function emptyMessage() {
  if (activeFolder === "pinned") return "No pinned notebooks yet. Pin one from a card.";
  if (activeFolder === "trashed") return "Trash is empty.";
  if (activeFolder && activeFolder.startsWith(FOLDER_PREFIX)) {
    return "No notebooks in this folder.";
  }
  return "No notebooks yet. Create one or import a PDF.";
}

function folderById(id) {
  return folders.find((f) => f.id === id) || null;
}

function libraryView() {
  const visibleNotes = notesInCurrentView();
  const folderList = folders
    .map(
      (f) => `
      <button class="side ${activeFolder === FOLDER_PREFIX + f.id ? "active" : ""}" data-folder="${FOLDER_PREFIX}${escapeHtml(f.id)}">
        ${icon("folder", 16)}
        <span>${escapeHtml(f.name)}</span>
        <span class="side-badge">${notes.filter((n) => !n.trashed && n.folderId === f.id).length}</span>
        <button class="side-remove" data-remove-folder="${escapeHtml(f.id)}" title="Delete folder">${icon("close", 12)}</button>
      </button>`,
    )
    .join("");

  return `
    <div class="shell">
      <aside>${sidebar()}</aside>
      <section class="library">
        <header class="library-top">
          <div class="library-top-title">
            ${icon("folder", 22)}
            <h1>${escapeHtml(libraryHeading())}</h1>
          </div>
          <div class="library-actions">
            <div class="search-bar">
              ${icon("search", 15)}
              <input type="text" placeholder="Search notes..." id="search-input" />
            </div>
            <label class="import-pdf-btn">
              ${icon("upload", 15)}
              Import PDF
              <input type="file" accept="application/pdf,.pdf" id="pdf-input" />
            </label>
            <select
              id="import-mode"
              class="import-mode-select"
              title="Make editable rebuilds the PDF's content as native objects, so it costs several times the file size and takes longer. Annotate PDF keeps the original and draws on top of it."
            >
              <option value="editable">Make editable</option>
              <option value="annotations">Annotate PDF</option>
            </select>
            <button class="new-note-btn" id="new-note-btn">
              ${icon("plus", 16)}
              New Note
            </button>
          </div>
        </header>

        <p class="library-section-label">${escapeHtml(libraryHeading())} (${visibleNotes.length})</p>
        <div class="note-grid">
          ${visibleNotes.length ? visibleNotes.map((n) => noteCard(n, activeFolder)).join("") : `<div class="library-empty">${emptyMessage()}</div>`}
        </div>

        <button class="fab" id="fab-new-note" title="Create New Note">
          ${icon("plus", 22)}
        </button>
      </section>
    </div>
  `;
}

function sidebar() {
  const folderList = folders
    .map(
      (f) => `
      <button class="side ${activeFolder === FOLDER_PREFIX + f.id ? "active" : ""}" data-folder="${FOLDER_PREFIX}${escapeHtml(f.id)}">
        ${icon("folder", 16)}
        <span>${escapeHtml(f.name)}</span>
        <span class="side-badge">${notes.filter((n) => !n.trashed && n.folderId === f.id).length}</span>
        <button class="side-remove" data-remove-folder="${escapeHtml(f.id)}" title="Delete folder">${icon("close", 12)}</button>
      </button>`,
    )
    .join("");

  return `
    <div class="profile">
      <div class="profile-avatar">O</div>
      <span class="profile-name">OmniNote</span>
      <span class="profile-chevron">${icon("chevronDown", 14)}</span>
    </div>

    <div class="nav-section-title">
      <span>Notebooks</span>
      ${icon("chevronDown", 12)}
    </div>

    <nav>
      <button class="side ${activeFolder === "unfiled" ? "active" : ""}" data-folder="unfiled">
        ${icon("folder", 16)}
        <span>Unfiled</span>
        <span class="side-badge">${noteCount("unfiled")}</span>
      </button>
      <button class="side ${activeFolder === "pinned" ? "active" : ""}" data-folder="pinned">
        ${icon("star", 16)}
        <span>Pinned</span>
        <span class="side-badge">${noteCount("pinned")}</span>
      </button>
      <button class="side ${activeFolder === "trashed" ? "active" : ""}" data-folder="trashed">
        ${icon("trash", 16)}
        <span>Trashed</span>
        <span class="side-badge">${noteCount("trashed")}</span>
      </button>
    </nav>

    <div class="side-divider"></div>

    <div class="nav-section-title">
      <span>Folders</span>
    </div>
    <nav>
      ${folders.length === 0 ? `<button class="side side-disabled" disabled>${icon("folder", 16)}<span>No folders yet</span></button>` : folderList}
      <button class="side side-add" id="new-folder-btn" title="Create a new folder">
        ${icon("plus", 16)}
        <span>New folder</span>
      </button>
    </nav>
  `;
}

function noteCard(note, view) {
  const firstPage = note.pages?.[0];
  const pageCount = note.pages?.length || 1;
  const thumbAssetId = firstPage?.thumbnailAssetId || note.thumbnailAssetId;
  // Legacy notes may still carry an inline dataURL thumbnail.
  const legacyThumb =
    typeof firstPage?.thumbnail === "string" ? firstPage.thumbnail : null;

  let thumbMarkup = `<span style="font-size: 28px; opacity: 0.3;">✦</span>`;
  if (thumbAssetId) {
    thumbMarkup = `<img data-thumb="${escapeHtml(thumbAssetId)}" alt="" />`;
  } else if (legacyThumb) {
    thumbMarkup = `<img src="${legacyThumb}" alt="" />`;
  }

  const inTrash = view === "trashed";
  const folderOptions = [
    `<option value="__none__"${!note.folderId ? " selected" : ""}>No folder</option>`,
    ...folders.map(
      (f) =>
        `<option value="${escapeHtml(f.id)}"${note.folderId === f.id ? " selected" : ""}>${escapeHtml(f.name)}</option>`,
    ),
  ].join("");

  // The trash icon doubles as "Move to trash" outside trash, "Delete forever"
  // inside it (with confirm). "Restore" only appears in trash.
  const trashTitle = inTrash ? "Delete forever" : "Move to trash";
  const pinTitle = note.pinned ? "Unpin" : "Pin";
  const folderSelect = inTrash
    ? ""
    : `<select class="card-folder-select" data-folder-select="${escapeHtml(note.id)}" title="Move to folder" aria-label="Move to folder">${folderOptions}</select>`;

  return `
    <div class="note-card-wrapper">
      <button class="note-card" data-open="${escapeHtml(note.id)}">
        <div class="preview ${firstPage?.paperStyle ? `paper-${firstPage.paperStyle}` : ""}">
          ${note.isPdf ? `<span class="preview-badge">${pageCount} ${pageCount === 1 ? "Page" : "Pages"}</span>` : ""}
          ${thumbMarkup}
        </div>
        <strong>${escapeHtml(note.title)}</strong>
        <small>${pageCount} ${pageCount === 1 ? "page" : "pages"} · ${note.isPdf ? "PDF Document" : "Notebook"}</small>
        ${folderSelect}
      </button>
      <div class="card-actions">
        ${inTrash
          ? `<button class="card-restore-btn" data-restore="${escapeHtml(note.id)}" title="Restore">${icon("restore", 14)}</button>`
          : `<button class="card-pin-btn ${note.pinned ? "is-pinned" : ""}" data-pin="${escapeHtml(note.id)}" title="${pinTitle}">${icon(note.pinned ? "starFilled" : "star", 14)}</button>`}
        <button class="card-delete-btn" data-delete-note="${escapeHtml(note.id)}" title="${trashTitle}">${icon("trash", 14)}</button>
      </div>
    </div>
  `;
}

const STANDARD_FONTS = [
  "DM Sans",
  "Inter",
  "Helvetica",
  "Arial",
  "Times New Roman",
  "Georgia",
  "Courier New",
  "Fira Code",
  "Caveat",
];

function renderFontOptions(note) {
  const detected = note.detectedFonts || [];
  const engine = getActiveCanvasEngine();
  const selectedFont = engine?.currentFont || note.defaultFont || "DM Sans";

  let html = "";
  if (detected.length > 0) {
    html += `<optgroup label="Detected in Document">`;
    for (const font of detected) {
      const isSelected = font === selectedFont;
      const isDefault = font === note.defaultFont;
      html += `<option value="${escapeHtml(font)}" ${isSelected ? "selected" : ""}>${escapeHtml(font)}${isDefault ? " (Default)" : ""}</option>`;
    }
    html += `</optgroup>`;
  }

  html += `<optgroup label="Standard Fonts">`;
  for (const font of STANDARD_FONTS) {
    if (!detected.includes(font)) {
      const isSelected = font === selectedFont;
      html += `<option value="${escapeHtml(font)}" ${isSelected ? "selected" : ""}>${escapeHtml(font)}</option>`;
    }
  }
  html += `</optgroup>`;

  if (
    !detected.includes(selectedFont) &&
    !STANDARD_FONTS.includes(selectedFont)
  ) {
    html =
      `<option value="${escapeHtml(selectedFont)}" selected>${escapeHtml(selectedFont)}</option>` +
      html;
  }

  return html;
}

function updateFontToolbarState(selected) {
  const textObj = selected?.find(
    (o) => o.type === "i-text" || o.text !== undefined,
  );

  const engine = getActiveCanvasEngine();
  const fontControlsBar = document.querySelector("#font-controls-bar");
  const fontSelect = document.querySelector("#font-family-select");
  const sizeLabel = document.querySelector("#font-size-label");
  const boldBtn = document.querySelector("#font-bold-btn");
  const italicBtn = document.querySelector("#font-italic-btn");
  const underlineBtn = document.querySelector("#font-underline-btn");
  const strikethroughBtn = document.querySelector("#font-strikethrough-btn");

  const hasTextSelection = !!textObj;
  const isTextTool = currentTool === "text";

  if (fontControlsBar) {
    const shouldShow = hasTextSelection || isTextTool;
    fontControlsBar.classList.toggle("visible", shouldShow);
  }

  if (!hasTextSelection && !isTextTool) {
    return;
  }

  if (textObj) {
    const font = textObj.fontFamily || engine?.currentFont || "DM Sans";
    if (fontSelect) {
      const exists = Array.from(fontSelect.options).some(
        (o) => o.value === font,
      );
      if (!exists) {
        fontSelect.add(new Option(font, font, true, true));
      }
      fontSelect.value = font;
    }
    if (sizeLabel) {
      sizeLabel.textContent = Math.round(textObj.fontSize || 22);
    }
    const isBold = textObj.fontWeight === "bold" || textObj.fontWeight === 700;
    boldBtn?.classList.toggle("active", isBold);

    const isItalic = textObj.fontStyle === "italic";
    italicBtn?.classList.toggle("active", isItalic);

    const isUnderline = textObj.underline === true;
    underlineBtn?.classList.toggle("active", isUnderline);

    const isStrikethrough = textObj.linethrough === true;
    strikethroughBtn?.classList.toggle("active", isStrikethrough);
  } else if (engine) {
    if (fontSelect) {
      fontSelect.value = engine.currentFont;
    }
    if (sizeLabel) {
      sizeLabel.textContent = Math.round(engine.currentFontSize || 22);
    }
    boldBtn?.classList.toggle("active", !!engine.isBold);
    italicBtn?.classList.toggle("active", !!engine.isItalic);
    underlineBtn?.classList.toggle("active", !!engine.isUnderline);
    strikethroughBtn?.classList.toggle("active", !!engine.isStrikethrough);
  }
}

function editorView(note) {
  const allColors = Array.from(
    new Set(customColors.length ? customColors : [DEFAULT_COLOR]),
  );

  const page = getCurrentPage();
  const pageIndex = note.currentPageIndex || 0;
  const totalPages = note.pages.length;

  const engine = getActiveCanvasEngine();

  return `
    <div class="editor">
      <header class="editor-top">
        <button class="icon-btn" id="back-btn" title="Back to Library">${icon("back", 18)}</button>

        <button class="icon-btn" id="page-manager-btn" title="Page Manager — select, insert, rotate, extract, share pages">${icon("pages", 18)}</button>

        <button class="title-pill" id="rename-btn" title="Click to rename">
          <span>${escapeHtml(note.title)}</span>
          ${icon("chevronDown", 13)}
        </button>

        <div class="top-bar-divider"></div>

        <button class="icon-btn" id="undo-btn" title="Undo (Cmd+Z)" disabled>${icon("undo", 16)}</button>
        <button class="icon-btn" id="redo-btn" title="Redo (Cmd+Shift+Z)" disabled>${icon("redo", 16)}</button>

        <div class="top-bar-divider"></div>

        <button class="page-setup-btn" id="page-setup-toggle-btn" title="Change page size or paper pattern">
          ${icon("grid", 14)}
          <span>Page Style (${page.width} × ${page.height})</span>
        </button>

        <div class="top-bar-divider"></div>

        <div class="zoom-controls" title="Zoom">
          <button class="icon-btn zoom-btn" id="zoom-out-btn" title="Zoom Out (Cmd/Ctrl + -)">${icon("zoomOut", 14)}</button>
          <input type="range" class="zoom-slider" id="zoom-slider" min="${Math.round(ZOOM_MIN * 100)}" max="${Math.round(ZOOM_MAX * 100)}" step="1" value="${Math.round(currentZoom * 100)}" title="Drag to zoom" aria-label="Zoom level" />
          <span class="zoom-label-btn" id="zoom-reset-btn" title="Reset to 100% (Cmd/Ctrl + 0) — or type an exact level">
            <input class="zoom-value" id="zoom-value" type="text" inputmode="numeric" value="${Math.round(currentZoom * 100)}" aria-label="Zoom percentage" title="Type a zoom level and press Enter" />
            <span class="zoom-pct">%</span>
          </span>
          <button class="icon-btn zoom-btn" id="zoom-in-btn" title="Zoom In (Cmd/Ctrl + =)">${icon("zoomIn", 14)}</button>
          <button class="icon-btn zoom-btn" id="zoom-fit-width-btn" title="Fit Width (Cmd/Ctrl + 9)">${icon("fitWidth", 14)}</button>
          <button class="icon-btn zoom-btn" id="zoom-fit-page-btn" title="Fit Whole Page (Cmd/Ctrl + 8)">${icon("fitPage", 14)}</button>
          <button class="icon-btn zoom-btn" id="zoom-lock-btn" title="Lock zoom">${icon(zoomLocked ? "lockClosed" : "lockOpen", 14)}</button>
        </div>

        <button class="icon-btn zw-toggle" id="zw-toggle" title="Zoom window — write magnified, ink lands on the page">${icon("zoomWindow", 14)}</button>

        <div class="top-bar-divider"></div>

        <!-- Font and Typography Controls -->
        <div class="font-controls-bar" id="font-controls-bar" title="Font & Typography Settings">
          <select class="font-family-select" id="font-family-select" title="Font Family">
            ${renderFontOptions(note)}
          </select>
          <div class="font-size-control" title="Font Size">
            <button class="font-size-btn" id="font-size-dec" title="Decrease font size">-</button>
            <span id="font-size-label">${engine?.currentFontSize || 22}</span>
            <button class="font-size-btn" id="font-size-inc" title="Increase font size">+</button>
          </div>
          <button class="font-style-btn" id="font-bold-btn" title="Toggle Bold"><b>B</b></button>
          <button class="font-style-btn" id="font-italic-btn" title="Toggle Italic"><i>I</i></button>
          <button class="font-style-btn" id="font-underline-btn" title="Toggle Underline"><u>U</u></button>
          <button class="font-style-btn" id="font-strikethrough-btn" title="Toggle Strikethrough"><s>S</s></button>
        </div>

        <div class="top-actions-right">
          <button class="icon-btn" id="export-pdf-btn" title="Export as PDF / Print">${icon("download", 16)}</button>
          <button class="icon-btn delete-notebook-btn" id="delete-notebook-btn" title="Delete Entire Notebook">${icon("trash", 16)}</button>
        </div>
      </header>

      <div class="workspace">
        <!-- Page Setup Modal -->
        <div class="page-setup-modal" id="page-setup-modal" style="display: ${showPageSetup ? "flex" : "none"}">
          <div class="page-setup-row">
            <label>Paper Template</label>
            <div class="paper-style-grid" id="paper-style-grid">
              <button class="paper-btn ${page.paperStyle === "plain" ? "active" : ""}" data-paper="plain" title="Plain White">
                <div class="paper-preview p-plain"></div>
              </button>
              <button class="paper-btn ${page.paperStyle === "lined" ? "active" : ""}" data-paper="lined" title="Ruled / Lined">
                <div class="paper-preview p-lined"></div>
              </button>
              <button class="paper-btn ${page.paperStyle === "grid" ? "active" : ""}" data-paper="grid" title="Graph Grid">
                <div class="paper-preview p-grid"></div>
              </button>
              <button class="paper-btn ${page.paperStyle === "dotted" ? "active" : ""}" data-paper="dotted" title="Dotted">
                <div class="paper-preview p-dotted"></div>
              </button>
            </div>
          </div>
          <div class="page-setup-row">
            <label>Page Size</label>
            <select id="page-size-select">
              <option value="custom" selected>Current (${page.width} × ${page.height} px)</option>
              <option value="a4">A4 (800 × 1130)</option>
              <option value="letter">US Letter (800 × 1035)</option>
              <option value="slide">16:9 Slide (1200 × 675)</option>
              <option value="square">Square (800 × 800)</option>
            </select>
          </div>
        </div>

        <!-- Shapes Flyout Menu -->
        <div class="shapes-flyout" id="shapes-flyout" style="display: ${showShapesFlyout ? "grid" : "none"}">
          <button class="shape-opt-btn" data-shape="rect" title="Rectangle">▭</button>
          <button class="shape-opt-btn" data-shape="circle" title="Circle">○</button>
          <button class="shape-opt-btn" data-shape="triangle" title="Triangle">△</button>
          <button class="shape-opt-btn" data-shape="line" title="Line">―</button>
        </div>

        <!-- Tools Rail -->
        <nav class="tools-rail">
          <button class="tool-item ${currentTool === "select" ? "selected" : ""}" data-tool="select" title="Select & Move (V)">
            ${icon("select", 17)}
          </button>
          <div class="pen-tool-wrap">
            <button class="tool-item ${currentTool === "pen" ? "selected" : ""}" data-tool="pen" title="Pen (P)">
              ${icon("pen", 17)}
            </button>
            <button class="pen-style-toggle" id="pen-style-toggle" title="Change pen style">▾</button>
            <div class="pen-styles-flyout" id="pen-styles-flyout" style="display:none">
              <button class="pen-style-opt ${(currentPenStyle || "ballpoint") === "ballpoint" ? "active" : ""}" data-pen-style="ballpoint" title="Ballpoint">
                <svg width="20" height="14"><line x1="2" y1="12" x2="18" y2="2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                <span>Ballpoint</span>
              </button>
              <button class="pen-style-opt ${currentPenStyle === "fountain" ? "active" : ""}" data-pen-style="fountain" title="Fountain">
                <svg width="20" height="14"><line x1="2" y1="12" x2="10" y2="7" stroke="currentColor" stroke-width="1"/><line x1="10" y1="7" x2="18" y2="2" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>
                <span>Fountain</span>
              </button>
              <button class="pen-style-opt ${currentPenStyle === "felt" ? "active" : ""}" data-pen-style="felt" title="Felt Tip">
                <svg width="20" height="14"><line x1="2" y1="12" x2="18" y2="2" stroke="currentColor" stroke-width="3" stroke-linecap="square"/></svg>
                <span>Felt Tip</span>
              </button>
              <button class="pen-style-opt ${currentPenStyle === "dashed" ? "active" : ""}" data-pen-style="dashed" title="Dashed">
                <svg width="20" height="14"><line x1="2" y1="8" x2="18" y2="8" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 3" stroke-linecap="round"/></svg>
                <span>Dashed</span>
              </button>
            </div>
          </div>
          <button class="tool-item ${currentTool === "marker" ? "selected" : ""}" data-tool="marker" title="Highlighter (H)">
            ${icon("marker", 17)}
          </button>
          <button class="tool-item ${currentTool === "eraser" ? "selected" : ""}" data-tool="eraser" title="Eraser (E)">
            ${icon("eraser", 17)}
          </button>
          <button class="tool-item ${currentTool === "text" ? "selected" : ""}" data-tool="text" title="Add Text (T)">
            ${icon("text", 17)}
          </button>
          <button class="tool-item ${showShapesFlyout ? "selected" : ""}" id="shapes-btn" title="Add Shape">
            ${icon("shapes", 17)}
          </button>
          <label class="tool-item image-tool" title="Insert Image">
            ${icon("image", 17)}
            <input type="file" accept="image/*" id="image-input" />
          </label>

          <div class="rail-divider"></div>

          <!-- Thickness Slider -->
          <div class="thickness-slider-wrap" title="Stroke Width">
            <input type="range" id="stroke-width-slider" min="1" max="8" value="${currentWidth}" orient="vertical" />
            <div class="thickness-preview-container">
              <div class="thickness-preview" id="thickness-preview" style="width: ${Math.min(currentWidth, 16)}px; height: ${Math.min(currentWidth, 16)}px; background: ${currentColor}; border-radius: 50%;"></div>
            </div>
          </div>

          <div class="rail-divider"></div>

          <!-- Swatches & Custom Picker -->
          <div class="swatches-stack">
            ${allColors
              .slice(0, MAX_SWATCHES)
              .map(
                (c, idx) => `
              <label class="swatch-dot ${c === currentColor ? "chosen" : ""}" data-color="${c}" data-swatch-idx="${idx}" style="--swatch:${c}" title="Click to use · click again to change · right-click to remove"></label>
            `,
              )
              .join("")}
            <button type="button" class="swatch-add-btn" id="add-color-btn" title="Add a new color">+</button>
            <input type="color" id="color-picker-input" class="swatch-edit-input" value="${currentColor}" tabindex="-1" aria-hidden="true" />
          </div>
        </nav>

        <!-- Canvas Viewport -->
        <section class="canvas-wrap" id="canvas-scroll-container">
          ${note.pages
            .map(
              (p, i) => `
            <div class="page-container" id="page-wrapper-${i}" data-index="${i}">
              <canvas id="omni-canvas-${i}"></canvas>
            </div>
          `,
            )
            .join("")}
        </section>

        <!-- Noteful-style zoom window: write magnified, ink lands on the page -->
        <div class="zoom-window" id="zoom-window" hidden>
          <canvas class="zoom-window-strip" id="zw-canvas"></canvas>
          <div class="zoom-window-controls">
            <button class="zw-btn" id="zw-left" title="Move box left">${icon("chevronLeft", 14)}</button>
            <button class="zw-btn" id="zw-right" title="Advance box right">${icon("chevronRight", 14)}</button>
            <button class="zw-btn" id="zw-down" title="Drop to next line">${icon("chevronDown", 14)}</button>
            <button class="zw-btn" id="zw-close" title="Close zoom window">${icon("close", 14)}</button>
          </div>
        </div>
        <div class="zw-target-box" id="zw-box" hidden></div>

        <!-- Interactive Multi-Page Floating Status Pill -->
        <div class="floating-status-pill">
          <button class="page-nav-btn" id="prev-page-btn" title="Previous Page" ${pageIndex === 0 ? "disabled" : ""}>
            ${icon("back", 14)}
          </button>
          <span class="page-counter-text">Page ${pageIndex + 1} of ${totalPages}</span>
          <button class="page-nav-btn" id="next-page-btn" title="Next Page" ${pageIndex === totalPages - 1 ? "disabled" : ""}>
            ${icon("chevronRight", 14)}
          </button>
          <button class="page-add-btn" id="add-page-btn" title="Add Page">
            ${icon("plus", 14)}
          </button>
          <button class="page-delete-btn" id="delete-page-btn" title="Delete Current Page" ${totalPages <= 1 ? "disabled" : ""}>
            ${icon("delete", 13)}
          </button>
        </div>
      </div>
      ${showPageManager ? pageManagerOverlay(note) : ""}
    </div>
  `;
}

/* ==========================================================================
   PAGE MANAGER (Noteful-style "Select" page grid)
   ========================================================================== */

function pageManagerTilesHtml(note) {
  return note.pages
    .map((p, i) => {
      const selected = pageManagerSelection.has(i);
      const thumb = pageManagerThumbs[i] || "";
      const thumbEl = thumb
        ? `<img class="pm-thumb" src="${thumb}" alt="Page ${i + 1}" draggable="false" />`
        : `<div class="pm-thumb pm-thumb-empty"></div>`;
      const tags =
        Array.isArray(p.tags) && p.tags.length
          ? `<span class="pm-tags">${p.tags.map((t) => `<span class="pm-tag">${escapeHtml(t)}</span>`).join("")}</span>`
          : "";
      return `
        <div class="pm-cell">
          <span class="pm-num">Page ${i + 1}</span>
          <button class="pm-tile ${selected ? "selected" : ""}" data-index="${i}" title="Page ${i + 1} — click to toggle, shift-click for a range, drag to reorder">
            <span class="pm-check">✓</span>
            ${thumbEl}
            ${tags}
          </button>
        </div>`;
    })
    .join("");
}

function pageManagerOverlay(note) {
  const total = note.pages.length;
  const sel = pageManagerSelection.size;
  return `
    <div class="page-manager-overlay" id="page-manager-overlay" role="dialog" aria-label="Page Manager">
      <header class="pm-header">
        <div class="pm-title">
          <strong>Pages</strong>
          <span class="pm-sub">${total} page${total !== 1 ? "s" : ""}${sel ? ` · ${sel} selected` : ""}</span>
        </div>
        <div class="pm-header-actions">
          <button class="pm-text-btn" id="pm-select-all">Select all</button>
          <button class="pm-text-btn" id="pm-clear">Clear</button>
          <button class="icon-btn" id="pm-close" title="Close (Esc)">${icon("close", 18)}</button>
        </div>
      </header>
      <div class="pm-grid" id="page-manager-grid">${pageManagerTilesHtml(note)}</div>
      <footer class="pm-toolbar">
        <button class="pm-op" id="pm-insert" title="Insert a blank page after the selection">${icon("plus", 16)}<span>Insert</span></button>
        <button class="pm-op" id="pm-rotate" ${sel ? "" : "disabled"} title="Rotate selected pages 90°">${icon("rotate", 16)}<span>Rotate</span></button>
        <span class="pm-sep"></span>
        <button class="pm-op" id="pm-copy" ${sel ? "" : "disabled"} title="Copy selected pages">${icon("copy", 16)}<span>Copy</span></button>
        <button class="pm-op" id="pm-cut" ${sel ? "" : "disabled"} title="Cut selected pages">${icon("cut", 16)}<span>Cut</span></button>
        <button class="pm-op" id="pm-paste" ${pageClipboard.length ? "" : "disabled"} title="Paste copied/cut pages">${icon("paste", 16)}<span>Paste</span></button>
        <button class="pm-op" id="pm-tag" ${sel ? "" : "disabled"} title="Tag selected pages">${icon("tag", 16)}<span>Tag</span></button>
        <span class="pm-sep"></span>
        <button class="pm-op pm-danger" id="pm-delete" ${sel ? "" : "disabled"} title="Delete selected pages">${icon("trash", 16)}<span>Delete</span></button>
        <span class="pm-spacer"></span>
        <button class="pm-op" id="pm-extract" ${sel ? "" : "disabled"} title="New notebook from selected pages">${icon("folder", 16)}<span>Extract</span></button>
        <button class="pm-op" id="pm-share" ${sel ? "" : "disabled"} title="Export selected pages as PDF">${icon("download", 16)}<span>Share</span></button>
      </footer>
    </div>`;
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
  zoomRestoreTarget = currentZoom;
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
}

async function regeneratePageManagerThumbs() {
  const note = getActiveNote();
  pageManagerThumbs = [];
  for (let i = 0; i < note.pages.length; i++) {
    try {
      pageManagerThumbs[i] = await renderPageThumbnail(note.pages[i], 260);
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
  pageManagerPriorZoom = currentZoom;
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
    pendingDecomposedData: null,
    pdfPageIndex:
      typeof page.pdfPageIndex === "number" ? page.pdfPageIndex : null,
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

async function rotateEnginePage90(engine, page) {
  const canvas = engine.canvas;
  const oldW = engine.width;
  const oldH = engine.height;
  const newW = oldH;
  const newH = oldW;
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
  // Keep the rotated snapshot instead of re-rasterizing the source PDF at the
  // original (now wrong) orientation.
  try {
    engine.pdfSource = null;
  } catch {}
  engine.setZoom(engine.currentZoom, { force: true, resetPan: true });
  canvas.requestRenderAll();
}

async function pmInsert() {
  const note = getActiveNote();
  if (!note.pages.length) return;
  const idx = pageManagerSelection.size
    ? Math.max(...pageManagerSelection)
    : note.currentPageIndex;
  const ref = note.pages[Math.min(idx, note.pages.length - 1)] || note.pages[0];
  note.pages.splice(idx + 1, 0, {
    id: crypto.randomUUID(),
    pageNumber: idx + 2,
    width: ref.width || 800,
    height: ref.height || 1130,
    paperStyle: ref.paperStyle || "lined",
    pageSize: "custom",
    thumbnail: null,
    canvasJson: null,
    pendingDecomposedData: null,
  });
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
    !confirm(
      `Delete ${pageManagerSelection.size} selected page(s)? This cannot be undone.`,
    )
  )
    return;
  const indices = Array.from(pageManagerSelection).sort((a, b) => b - a);
  for (const i of indices) {
    if (note.pages.length <= 1) break;
    const [removed] = note.pages.splice(i, 1);
    // Don't delete assets still referenced by other (e.g. copied) pages.
    const remainingIds = new Set();
    for (const p of note.pages) {
      for (const id of collectPageAssetIds(p)) remainingIds.add(id);
    }
    const ids = collectPageAssetIds(removed).filter(
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

async function pmRotate() {
  const note = getActiveNote();
  const indices = Array.from(pageManagerSelection).sort((a, b) => a - b);
  if (!indices.length) return;
  for (const i of indices) {
    const engine = canvasEngines[i];
    const page = note.pages[i];
    if (engine && page) await rotateEnginePage90(engine, page);
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
  notes.unshift(newNote);
  saveNotes();
  showPageManager = false;
  activeId = null;
  render();
}

async function pmShare() {
  const note = getActiveNote();
  const indices = Array.from(pageManagerSelection).sort((a, b) => a - b);
  if (!indices.length) return;
  isLoading = true;
  loadingMessage = "Exporting selected pages...";
  renderLoading();
  try {
    await exportNotebookToPdf(
      note,
      getActiveCanvasEngine(),
      (curr, total) => {
        loadingMessage = `Exporting page ${curr} of ${total}...`;
        renderLoading();
      },
      indices,
    );
  } catch (err) {
    alert("Export failed: " + err.message);
    console.error(err);
  } finally {
    isLoading = false;
    renderLoading();
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
    pendingDecomposedData: null,
    tags: Array.isArray(page.tags) ? page.tags.slice() : [],
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
    note.pages.splice(i, 1);
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
  note.pages.splice(target + 1, 0, ...clones);
  pageManagerSelection = new Set();
  saveNotes();
  await regeneratePageManagerThumbs();
  zoomRestoreTarget = pageManagerPriorZoom;
  render();
}

function pmTag() {
  const note = getActiveNote();
  if (!pageManagerSelection.size) return;
  const tag = (prompt("Tag the selected pages (single tag):") || "").trim();
  if (!tag) return;
  for (const i of pageManagerSelection) {
    const p = note.pages[i];
    p.tags = Array.isArray(p.tags) ? p.tags : [];
    if (!p.tags.includes(tag)) p.tags.push(tag);
  }
  saveNotes();
  refreshPageManagerGrid();
}

async function initEditor(note) {
  if (canvasEngines && canvasEngines.length > 0) {
    canvasEngines.forEach((e) => e.destroy());
    canvasEngines = [];
  }

  // When returning from the Page Manager we want to keep the zoom the user had,
  // rather than snapping back to fit-width. The flag is only set across those
  // two transitions, so normal note opens still fit to width.
  const restoreZoom = zoomRestoreTarget != null;
  if (restoreZoom) {
    currentZoom = zoomRestoreTarget;
    zoomRestoreTarget = null;
  }

  let needsSave = false;

  for (let i = 0; i < note.pages.length; i++) {
    const page = note.pages[i];
    const canvasEl = document.querySelector(`#omni-canvas-${i}`);
    if (!canvasEl) continue;

    const engine = new OmniCanvas(canvasEl, {
      width: Math.round(page.width || 800),
      height: Math.round(page.height || 1130),
      paperStyle: page.paperStyle || "plain",
      defaultFont: note.defaultFont || "DM Sans",
      onModified: () => {
        saveActiveCanvasPage();
      },
      onHistoryChange: ({ canUndo, canRedo }) => {
        // Only update buttons if this is the active canvas
        if (note.currentPageIndex === i) {
          const undoBtn = document.querySelector("#undo-btn");
          const redoBtn = document.querySelector("#redo-btn");
          if (undoBtn) undoBtn.disabled = !canUndo;
          if (redoBtn) redoBtn.disabled = !canRedo;
        }
      },
      onSelectionChange: (selected) => {
        if (note.currentPageIndex === i) {
          updateFontToolbarState(selected);
        }
      },
      onZoomChange: (z) => {
        updateZoomUI(z);
      },
      // Pinch/wheel zoom takes the exact route the slider takes.
      onZoomStart: (clientX, clientY) => beginZoomGesture(clientX, clientY),
      onZoomEnd: () => endZoomGesture(),
      onZoomRequest: (percent, preview) => setZoom(percent / 100, { preview }),
    });

    engine.setColor(currentColor);
    engine.setWidth(currentWidth);
    engine.setTool(currentTool);
    await engine.loadPage(page);

    // The import handoff is one-shot: clear it only once the page has actually
    // been loaded, so a failed load can still be retried on the next open.
    if (page.pendingImportData || page.pendingDecomposedData) {
      page.pendingImportData = null;
      page.pendingDecomposedData = null;
      needsSave = true;
    }

    // Initial welcome text on first page
    if (
      i === 0 &&
      note.id === "welcome-note" &&
      !page.canvasJson &&
      !page.pendingDecomposedData
    ) {
      engine.addTextAt("Welcome to OmniNote", 100, 100);
      engine.addTextAt(
        "Import any PDF using 'Import PDF' to edit text, images, and strokes!",
        100,
        170,
      );
      engine.setTool("select");
      const json = engine.toJSON();
      page.canvasJson = json;
      saveNotes();
    }

    engine.zoomLocked = zoomLocked;

    // Only pages near the viewport render at full quality; the rest are held
    // at 100% until scrolled to.
    engine.isActivePage = Math.abs(i - note.currentPageIndex) <= 1;
    if (
      note.pdfAssetId &&
      Number.isInteger(page.pdfPageIndex) &&
      !page.fallbackFromImage
    ) {
      engine.setPdfBackgroundSource({
        assetId: note.pdfAssetId,
        pageIndex: page.pdfPageIndex,
      });
    }

    canvasEngines.push(engine);
  }

  // `saveActiveCanvasPage` refuses to run while `canvasEngines` is still being
  // filled, so the `onModified` fired by the first page's `loadPage` is a no-op
  // and the freshly imported object graph was never written back. Persist it
  // here instead, or reopening the notebook would show a blank page.
  if (needsSave) {
    saveActiveCanvasPage();
  } else {
    saveNotes();
  }

  // Carry the global zoom across engines so each page renders at the current scale.
  for (const engine of canvasEngines) {
    if (engine.currentZoom !== currentZoom) {
      engine.setZoom(currentZoom, { force: true });
    }
  }

  // Wide imported pages are the common case, so open pulled back to fit width.
  applyDefaultZoom();
  initZoomWindow();

  // Set up scroll observer to update active page index
  const scrollContainer = document.querySelector("#canvas-scroll-container");
  if (scrollContainer) {
    const observer = new IntersectionObserver(
      (entries) => {
        let maxRatio = 0;
        let mostVisibleIndex = note.currentPageIndex;
        entries.forEach((entry) => {
          if (entry.isIntersecting && entry.intersectionRatio > maxRatio) {
            maxRatio = entry.intersectionRatio;
            mostVisibleIndex = Number(entry.target.dataset.index);
          }
        });
        if (mostVisibleIndex !== note.currentPageIndex) {
          note.currentPageIndex = mostVisibleIndex;
          document.querySelector(".page-counter-text").textContent =
            `Page ${note.currentPageIndex + 1} of ${note.pages.length}`;
          // Update nav buttons disabled state
          const prevBtn = document.querySelector("#prev-page-btn");
          const nextBtn = document.querySelector("#next-page-btn");
          if (prevBtn) prevBtn.disabled = note.currentPageIndex === 0;
          if (nextBtn)
            nextBtn.disabled = note.currentPageIndex === note.pages.length - 1;
          // Full-quality rendering (and PDF re-rasterization) follows the viewport.
          canvasEngines.forEach((eng, idx) =>
            eng.setActivePage(Math.abs(idx - mostVisibleIndex) <= 1),
          );
          attachZoomWindow();
          saveNotes();
        }
      },
      {
        root: scrollContainer,
        threshold: [0.1, 0.5, 0.9],
      },
    );

    document
      .querySelectorAll(".page-container")
      .forEach((el) => observer.observe(el));

    // Scroll to the active page on load
    const activeWrapper = document.querySelector(
      `#page-wrapper-${note.currentPageIndex}`,
    );
    if (activeWrapper) {
      activeWrapper.scrollIntoView();
    }
  }
  bindEditorEvents(note);
}

function saveActiveCanvasPage() {
  const note = getActiveNote();
  if (!note || canvasEngines.length === 0) return;

  canvasEngines.forEach((engine, i) => {
    const page = note.pages[i];
    if (page && engine) {
      const json = engine.toJSON();
      page.canvasJson = json;
      page.width = json.width;
      page.height = json.height;
      page.paperStyle = json.paperStyle;
    }
  });

  saveNotes();
  scheduleThumbnailRefresh(note.id);
}

let thumbnailTimer = null;

/** Thumbnails are only for the library grid, so they lag behind edits slightly. */
function scheduleThumbnailRefresh(noteId) {
  if (thumbnailTimer) clearTimeout(thumbnailTimer);
  thumbnailTimer = setTimeout(() => {
    thumbnailTimer = null;
    refreshNoteThumbnail(noteId).catch(() => {});
  }, 600);
}

async function refreshNoteThumbnail(noteId) {
  if (activeId !== noteId) return;

  const note = getActiveNote();
  const page = note?.pages?.[0];
  const engine = canvasEngines[0];
  if (!note || !page || !engine) return;

  try {
    // The canvas is sized to (page x render zoom), so a fixed multiplier would
    // yield a different thumbnail size at every zoom level. Solve for the
    // intended width instead.
    const pageW = page.width || engine.width || 800;
    const renderZoom = engine.getRenderZoom ? engine.getRenderZoom() : 1;
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const multiplier = Math.min(1, 320 / Math.max(1, pageW * renderZoom * dpr));

    const dataUrl = engine.canvas.toDataURL({
      format: "jpeg",
      quality: 0.35,
      multiplier,
    });
    if (!dataUrl) return;

    if (!page.thumbnailAssetId) {
      page.thumbnailAssetId = `thumb-${crypto.randomUUID()}`;
    }
    await putAssetFromDataUrl(page.thumbnailAssetId, dataUrl);
    page.thumbnail = null;
    saveNotes();
  } catch {
    // A missing thumbnail only costs a card preview, never the notebook itself.
  }
}

function bindEditorEvents(note) {
  document.querySelector("#back-btn")?.addEventListener("click", () => {
    saveActiveCanvasPage();
    activeId = null;
    showShapesFlyout = false;
    showPageSetup = false;
    render();
  });

  // Undo / Redo
  document.querySelector("#undo-btn")?.addEventListener("click", async () => {
    await getActiveCanvasEngine()?.undo();
  });

  document.querySelector("#redo-btn")?.addEventListener("click", async () => {
    await getActiveCanvasEngine()?.redo();
  });

  // Zoom controls
  document.querySelector("#zoom-in-btn")?.addEventListener("click", zoomIn);
  document.querySelector("#zoom-out-btn")?.addEventListener("click", zoomOut);
  document
    .querySelector("#zoom-reset-btn")
    ?.addEventListener("click", zoomReset);

  document
    .querySelector("#zoom-fit-width-btn")
    ?.addEventListener("click", () => zoomFit("width"));
  document
    .querySelector("#zoom-fit-page-btn")
    ?.addEventListener("click", () => zoomFit("page"));
  document
    .querySelector("#zoom-lock-btn")
    ?.addEventListener("click", toggleZoomLock);
  document
    .querySelector("#zw-toggle")
    ?.addEventListener("click", () => toggleZoomWindow());
  document
    .querySelector("#zw-close")
    ?.addEventListener("click", () => toggleZoomWindow(false));
  document
    .querySelector("#zw-down")
    ?.addEventListener("click", () => zoomWindow?.nextLine());
  document.querySelector("#zw-right")?.addEventListener("click", () => {
    if (zoomWindow) zoomWindow.nudge(zoomWindow.box.w * 0.25);
  });
  document.querySelector("#zw-left")?.addEventListener("click", () => {
    if (zoomWindow) zoomWindow.nudge(-zoomWindow.box.w * 0.25);
  });

  // Alt/Option + click on the page drops the zoom window's target box there.
  document
    .querySelector("#canvas-scroll-container")
    ?.addEventListener("click", (e) => {
      if (!zoomWindow?.visible || !e.altKey) return;
      const engine = getActiveCanvasEngine();
      if (!engine?.canvas.upperCanvasEl) return;
      const rect = engine.canvas.upperCanvasEl.getBoundingClientRect();
      const z = engine.currentZoom;
      zoomWindow.moveTo(
        (e.clientX - rect.left - engine.panX) / z,
        (e.clientY - rect.top - engine.panY) / z,
      );
    });

  // Slider: `input` fires continuously while dragging, so zoom tracks the drag.
  // Same deal as a pinch — preview cheaply while it moves, re-render crisp on
  // release — otherwise every notch reallocates and repaints all the canvases.
  const zoomSlider = document.querySelector("#zoom-slider");
  zoomSlider?.addEventListener("pointerdown", () =>
    beginZoomGesture(null, null),
  );
  zoomSlider?.addEventListener("input", (e) => {
    setZoom(Number(e.target.value) / 100, { preview: true });
  });
  zoomSlider?.addEventListener("change", (e) => {
    setZoom(Number(e.target.value) / 100);
    endZoomGesture();
  });

  // Percentage field — the precise counterpart to the slider.
  const zoomValue = document.querySelector("#zoom-value");
  const commitZoomValue = () => {
    if (!zoomValue) return;
    const n = Number.parseFloat(zoomValue.value);
    if (Number.isFinite(n) && n > 0) setZoom(n / 100);
    else updateZoomUI(currentZoom);
  };
  zoomValue?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitZoomValue();
      zoomValue.blur();
    } else if (e.key === "Escape") {
      updateZoomUI(currentZoom);
      zoomValue.blur();
    }
  });
  zoomValue?.addEventListener("focus", () => zoomValue.select());
  zoomValue?.addEventListener("blur", commitZoomValue);
  // Clicking anywhere on the control except the number resets to 100%.
  document.querySelector("#zoom-reset-btn")?.addEventListener("click", (e) => {
    if (e.target === zoomValue) return;
    setZoom(1, { reset: true });
  });

  // Page Navigation
  document.querySelector("#prev-page-btn")?.addEventListener("click", () => {
    if (note.currentPageIndex > 0) {
      const target = document.querySelector(
        `#page-wrapper-${note.currentPageIndex - 1}`,
      );
      if (target) target.scrollIntoView({ behavior: "smooth" });
    }
  });

  document.querySelector("#next-page-btn")?.addEventListener("click", () => {
    if (note.currentPageIndex < note.pages.length - 1) {
      const target = document.querySelector(
        `#page-wrapper-${note.currentPageIndex + 1}`,
      );
      if (target) target.scrollIntoView({ behavior: "smooth" });
    }
  });

  document.querySelector("#add-page-btn")?.addEventListener("click", () => {
    saveActiveCanvasPage();
    const currentPage = getCurrentPage();
    const newPage = {
      id: crypto.randomUUID(),
      pageNumber: note.pages.length + 1,
      width: currentPage?.width || 800,
      height: currentPage?.height || 1130,
      paperStyle: currentPage?.paperStyle || "lined",
      pageSize: "custom",
      thumbnail: null,
      canvasJson: null,
      pendingDecomposedData: null,
    };
    note.pages.splice(note.currentPageIndex + 1, 0, newPage);
    note.currentPageIndex++;
    saveNotes();
    render();
  });

  document
    .querySelector("#delete-page-btn")
    ?.addEventListener("click", async () => {
      if (note.pages.length <= 1) return;
      if (confirm(`Delete Page ${note.currentPageIndex + 1}?`)) {
        const [removed] = note.pages.splice(note.currentPageIndex, 1);
        // Copied pages can share image assets with the page being deleted.
        const stillUsed = new Set();
        for (const p of note.pages) {
          for (const id of collectPageAssetIds(p)) stillUsed.add(id);
        }
        await deleteAssets(
          collectPageAssetIds(removed).filter((id) => id && !stillUsed.has(id)),
        );
        if (note.currentPageIndex >= note.pages.length) {
          note.currentPageIndex = note.pages.length - 1;
        }
        saveNotes();
        render();
      }
    });

  // Page Setup Toggle
  document
    .querySelector("#page-setup-toggle-btn")
    ?.addEventListener("click", (e) => {
      e.stopPropagation();
      showPageSetup = !showPageSetup;
      const modal = document.querySelector("#page-setup-modal");
      if (modal) modal.style.display = showPageSetup ? "flex" : "none";
    });

  // Page Template Selection
  document.querySelectorAll(".paper-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const page = getCurrentPage();
      const engine = getActiveCanvasEngine();
      if (page && engine) {
        page.paperStyle = btn.dataset.paper;
        engine.setPaperStyle(page.paperStyle);
        saveActiveCanvasPage();

        document
          .querySelectorAll(".paper-btn")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
      }
    });
  });

  // Page Size Selection
  document
    .querySelector("#page-size-select")
    ?.addEventListener("change", (e) => {
      const page = getCurrentPage();
      const engine = getActiveCanvasEngine();
      const sizeConfig = PAGE_SIZES[e.target.value];
      if (page && sizeConfig && engine) {
        page.width = sizeConfig.width;
        page.height = sizeConfig.height;
        engine.setPageDimensions(sizeConfig.width, sizeConfig.height);
        saveActiveCanvasPage();
        const setupBtn = document.querySelector("#page-setup-toggle-btn span");
        if (setupBtn)
          setupBtn.textContent = `Page Style (${page.width} × ${page.height})`;
      }
    });

  // Font Family Selection
  document
    .querySelector("#font-family-select")
    ?.addEventListener("change", (e) => {
      const newFont = e.target.value;
      const engine = getActiveCanvasEngine();
      if (engine) {
        engine.setFontFamily(newFont);
        saveActiveCanvasPage();
      }
    });

  // Font Size Selection
  document.querySelector("#font-size-dec")?.addEventListener("click", () => {
    const engine = getActiveCanvasEngine();
    if (!engine) return;
    const newSize = Math.max(10, (engine.currentFontSize || 22) - 2);
    engine.setFontSize(newSize);
    const lbl = document.querySelector("#font-size-label");
    if (lbl) lbl.textContent = newSize;
    saveActiveCanvasPage();
  });

  document.querySelector("#font-size-inc")?.addEventListener("click", () => {
    const engine = getActiveCanvasEngine();
    if (!engine) return;
    const newSize = Math.min(120, (engine.currentFontSize || 22) + 2);
    engine.setFontSize(newSize);
    const lbl = document.querySelector("#font-size-label");
    if (lbl) lbl.textContent = newSize;
    saveActiveCanvasPage();
  });

  // Font Bold Toggle
  document.querySelector("#font-bold-btn")?.addEventListener("click", () => {
    const engine = getActiveCanvasEngine();
    if (!engine) return;
    const isBold = engine.toggleBold();
    document
      .querySelector("#font-bold-btn")
      ?.classList.toggle("active", isBold);
    saveActiveCanvasPage();
  });

  // Font Italic Toggle
  document.querySelector("#font-italic-btn")?.addEventListener("click", () => {
    const engine = getActiveCanvasEngine();
    if (!engine) return;
    const isItalic = engine.toggleItalic();
    document
      .querySelector("#font-italic-btn")
      ?.classList.toggle("active", isItalic);
    saveActiveCanvasPage();
  });

  // Font Underline Toggle
  document
    .querySelector("#font-underline-btn")
    ?.addEventListener("click", () => {
      const engine = getActiveCanvasEngine();
      if (!engine) return;
      const isUnderline = engine.toggleUnderline();
      document
        .querySelector("#font-underline-btn")
        ?.classList.toggle("active", isUnderline);
      saveActiveCanvasPage();
    });

  // Font Strikethrough Toggle
  document
    .querySelector("#font-strikethrough-btn")
    ?.addEventListener("click", () => {
      const engine = getActiveCanvasEngine();
      if (!engine) return;
      const isStrikethrough = engine.toggleStrikethrough();
      document
        .querySelector("#font-strikethrough-btn")
        ?.classList.toggle("active", isStrikethrough);
      saveActiveCanvasPage();
    });

  // Export Multi-Page PDF
  document
    .querySelector("#export-pdf-btn")
    ?.addEventListener("click", async () => {
      saveActiveCanvasPage();
      isLoading = true;
      loadingMessage = `Compiling '${note.title}' into PDF...`;
      renderLoading();

      try {
        await exportNotebookToPdf(
          note,
          getActiveCanvasEngine(),
          (curr, total) => {
            loadingMessage = `Exporting page ${curr} of ${total}...`;
            renderLoading();
          },
        );
      } catch (err) {
        alert("Error exporting PDF: " + err.message);
        console.error(err);
      } finally {
        isLoading = false;
        renderLoading();
      }
    });

  // Helper function to position a flyout relative to its trigger button
  function positionFlyout(flyout, trigger) {
    if (!flyout || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    const flyoutRect = flyout.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Default: below and left-aligned
    let left = rect.left;
    let top = rect.bottom + 4;

    // Flip horizontally if would overflow right edge
    if (left + flyoutRect.width > viewportWidth - 8) {
      left = rect.right - flyoutRect.width;
    }
    // Clamp to viewport
    left = Math.max(8, Math.min(left, viewportWidth - flyoutRect.width - 8));

    // Flip vertically if would overflow bottom edge
    if (top + flyoutRect.height > viewportHeight - 8) {
      top = rect.top - flyoutRect.height - 4;
    }
    // Clamp to viewport
    top = Math.max(8, Math.min(top, viewportHeight - flyoutRect.height - 8));

    flyout.style.left = `${left}px`;
    flyout.style.top = `${top}px`;
  }

  // Shapes Tool Flyout
  document.querySelector("#shapes-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    showShapesFlyout = !showShapesFlyout;
    const flyout = document.querySelector("#shapes-flyout");
    const trigger = document.querySelector("#shapes-btn");
    if (flyout) {
      flyout.style.display = showShapesFlyout ? "grid" : "none";
      if (showShapesFlyout && trigger) {
        positionFlyout(flyout, trigger);
      }
    }
  });

  // Shape Option Click
  document.querySelectorAll("[data-shape]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const shapeType = btn.dataset.shape;
      getActiveCanvasEngine()?.addShape(shapeType);
      showShapesFlyout = false;
      const flyout = document.querySelector("#shapes-flyout");
      if (flyout) flyout.style.display = "none";
      currentTool = "select";
      canvasEngines.forEach((e) => e.setTool("select"));
      document
        .querySelectorAll("[data-tool]")
        .forEach((b) => b.classList.remove("selected"));
      document.querySelector('[data-tool="select"]')?.classList.add("selected");
    });
  });

  // Close menus on outside click
  document.addEventListener("click", (e) => {
    if (
      !e.target.closest("#shapes-flyout") &&
      !e.target.closest("#shapes-btn")
    ) {
      showShapesFlyout = false;
      const flyout = document.querySelector("#shapes-flyout");
      if (flyout) flyout.style.display = "none";
    }
    if (
      !e.target.closest("#pen-styles-flyout") &&
      !e.target.closest("#pen-style-toggle")
    ) {
      const penFlyout = document.querySelector("#pen-styles-flyout");
      if (penFlyout) penFlyout.style.display = "none";
    }
    if (
      !e.target.closest("#page-setup-modal") &&
      !e.target.closest("#page-setup-toggle-btn")
    ) {
      showPageSetup = false;
      const modal = document.querySelector("#page-setup-modal");
      if (modal) modal.style.display = "none";
    }
  });

  document.querySelector("#rename-btn")?.addEventListener("click", () => {
    const newTitle = prompt("Notebook title:", note.title);
    if (newTitle && newTitle.trim()) {
      note.title = newTitle.trim();
      saveNotes();
      const titleSpan = document.querySelector("#rename-btn span");
      if (titleSpan) titleSpan.textContent = note.title;
    }
  });

  document
    .querySelector("#delete-notebook-btn")
    ?.addEventListener("click", () => {
      if (confirm(`Are you sure you want to delete "${note.title}"?`)) {
        notes = notes.filter((n) => n.id !== note.id);
        activeId = null;
        saveNotes();
        render();
      }
    });

  // Tool Selection
  document.querySelectorAll("[data-tool]").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentTool = btn.dataset.tool;
      canvasEngines.forEach((e) => e.setTool(currentTool));

      document
        .querySelectorAll("[data-tool]")
        .forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");

      // Update font toolbar visibility when switching to/from text tool
      const engine = getActiveCanvasEngine();
      if (engine) {
        updateFontToolbarState(engine.canvas.getActiveObjects());
      }
    });
  });

  // Pen Style Flyout
  const penStyleToggle = document.querySelector("#pen-style-toggle");
  const penStyleFlyout = document.querySelector("#pen-styles-flyout");
  if (penStyleToggle && penStyleFlyout) {
    penStyleToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const isVisible = penStyleFlyout.style.display !== "none";
      penStyleFlyout.style.display = isVisible ? "none" : "flex";
      if (!isVisible) {
        positionFlyout(penStyleFlyout, penStyleToggle);
      }
    });
  }

  // Pen Style Selection
  document.querySelectorAll("[data-pen-style]").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentPenStyle = btn.dataset.penStyle;
      canvasEngines.forEach((e) => e.setPenStyle(currentPenStyle));

      // Also switch to pen tool
      currentTool = "pen";
      canvasEngines.forEach((e) => e.setTool("pen"));
      document
        .querySelectorAll("[data-tool]")
        .forEach((b) => b.classList.remove("selected"));
      document.querySelector('[data-tool="pen"]')?.classList.add("selected");

      // Update active state
      document
        .querySelectorAll(".pen-style-opt")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      // Close flyout
      if (penStyleFlyout) penStyleFlyout.style.display = "none";
    });
  });

  // Thickness Slider
  const thicknessSlider = document.querySelector("#stroke-width-slider");
  const thicknessPreview = document.querySelector("#thickness-preview");
  if (thicknessSlider) {
    thicknessSlider.addEventListener("input", (e) => {
      currentWidth = Number(e.target.value);
      canvasEngines.forEach((e) => e.setWidth(currentWidth));
      if (thicknessPreview) {
        const size = Math.min(currentWidth, 16);
        thicknessPreview.style.width = size + "px";
        thicknessPreview.style.height = size + "px";
        thicknessPreview.style.background = currentColor;
      }
    });
  }

  const updateThicknessPreview = () => {
    if (thicknessPreview) {
      thicknessPreview.style.background = currentColor;
    }
  };

  /** Applies `hex` everywhere and marks `btn` (if given) as the chosen swatch. */
  const useColor = (hex, btn) => {
    currentColor = hex;
    canvasEngines.forEach((eng) => eng.setColor(hex));
    updateThicknessPreview();
    document
      .querySelectorAll(".swatch-dot")
      .forEach((b) => b.classList.remove("chosen"));
    if (btn) btn.classList.add("chosen");
  };

  // Quick Swatches — click to use, double-click to change, right-click to drop.
  // Shared by the rendered swatches and any swatch added later, so both behave
  // identically.
  const bindSwatch = (btn) => {
    // First click applies the colour; clicking the swatch that is already
    // chosen is what opens the picker to change it. There is deliberately no
    // separate edit affordance in the UI.
    btn.addEventListener("click", () => {
      if (btn.dataset.color === currentColor) {
        editSwatchColor(btn);
      } else {
        useColor(btn.dataset.color, btn);
      }
    });

    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      removeSwatch(btn);
    });
  };

  /** Opens the picker to recolour an existing swatch in place. */
  const editSwatchColor = (btn) => {
    openColorPicker(btn.dataset.color, (hex) => {
      const swIdx = Number(btn.dataset.swatchIdx);
      if (swIdx >= 0 && swIdx < customColors.length) {
        customColors[swIdx] = hex;
      } else {
        customColors.push(hex);
        btn.dataset.swatchIdx = String(customColors.length - 1);
      }
      btn.style.setProperty("--swatch", hex);
      btn.dataset.color = hex;
      saveCustomColors();
      useColor(hex, btn);
    });
  };

  /**
   * Removes a swatch. The last colour can never go — without one there is
   * nothing to draw with — and if the removed colour was the one in use, the
   * first remaining colour takes over so the tool never ends up colourless.
   */
  const removeSwatch = (btn) => {
    if (customColors.length <= 1) return;
    const swIdx = Number(btn.dataset.swatchIdx);
    if (!Number.isFinite(swIdx) || swIdx < 0 || swIdx >= customColors.length) {
      return;
    }
    const wasInUse = btn.dataset.color === currentColor;
    customColors.splice(swIdx, 1);
    saveCustomColors();
    btn.remove();

    document.querySelectorAll(".swatch-dot").forEach((b) => {
      const i = Number(b.dataset.swatchIdx);
      if (i > swIdx && i <= customColors.length) b.dataset.swatchIdx = i - 1;
    });

    if (wasInUse) {
      const first = document.querySelector(".swatch-dot");
      useColor(first ? first.dataset.color : DEFAULT_COLOR, first);
    }
    refreshAddColorButton();
  };

  document.querySelectorAll(".swatch-dot[data-color]").forEach(bindSwatch);
  refreshAddColorButton();

  // The shared picker input.
  const colorInput = document.querySelector("#color-picker-input");
  if (colorInput) {
    colorInput.addEventListener("change", (e) =>
      commitColorPicker(e.target.value),
    );
    // Fired when the user dismisses the picker without choosing.
    colorInput.addEventListener("cancel", () => commitColorPicker(null));
    // Last resort if neither of the above arrives: focus loss clears the flag
    // on the next tick, i.e. after `change` has already had its turn.
    colorInput.addEventListener("blur", () => {
      setTimeout(() => commitColorPicker(null), 0);
    });
  }

  // Add new color button — opens the same shared picker, repeatedly.
  const addColorBtn = document.querySelector("#add-color-btn");
  if (addColorBtn) {
    addColorBtn.addEventListener("click", () => {
      openColorPicker(currentColor, (hex) => {
        // Re-picking a colour that already has a swatch just selects it,
        // rather than adding a duplicate.
        const existing = document.querySelector(
          `.swatch-dot[data-color="${hex}"]`,
        );
        if (existing) {
          useColor(hex, existing);
          return;
        }

        customColors.push(hex);
        saveCustomColors();

        const stack = document.querySelector(".swatches-stack");
        if (!stack) {
          useColor(hex, null);
          return;
        }

        const swatch = document.createElement("label");
        swatch.className = "swatch-dot chosen";
        swatch.dataset.color = hex;
        swatch.dataset.swatchIdx = String(customColors.length - 1);
        swatch.style.setProperty("--swatch", hex);
        swatch.title =
          "Click to use · click again to change · right-click to remove";
        // Insert before the + button so new colours stack above it.
        stack.insertBefore(swatch, addColorBtn);
        bindSwatch(swatch);
        useColor(hex, swatch);
        refreshAddColorButton();
      });
    });
  }

  // Insert Image
  document
    .querySelector("#image-input")
    ?.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      const engine = getActiveCanvasEngine();
      if (file && engine) {
        await engine.addImageFile(file);
        currentTool = "select";
        canvasEngines.forEach((e) => e.setTool("select"));
        document
          .querySelectorAll("[data-tool]")
          .forEach((b) => b.classList.remove("selected"));
        document
          .querySelector('[data-tool="select"]')
          ?.classList.add("selected");
      }
      e.target.value = "";
    });

  // Page Manager (Noteful-style "Select" page grid)
  document.querySelector("#page-manager-btn")?.addEventListener("click", () => {
    if (showPageManager) closePageManager();
    else openPageManager();
  });
  bindPageManagerControls();
  bindPageManagerGrid();

  // Keyboard Shortcuts: Cmd+Z, Cmd+Shift+Z, Delete, Cmd+C, Cmd+V
  let clipboard = null;

  window.onkeydown = (e) => {
    // While the Page Manager is open, swallow everything except Escape (which
    // closes it) so shortcuts can't mutate the hidden editor behind the overlay.
    if (showPageManager) {
      if (e.key === "Escape") {
        e.preventDefault();
        closePageManager();
      }
      return;
    }

    // Never steal keys from a focused form field. On macOS the key labelled
    // "Delete" reports `Backspace`, so correcting a digit in the zoom field
    // would otherwise delete the selected object and swallow the keystroke.
    if (isTypingTarget(e.target)) return;

    const engine = getActiveCanvasEngine();
    const isEditingText = engine?.canvas.getActiveObject()?.isEditing;

    // Undo: Cmd+Z / Ctrl+Z
    if (
      (e.metaKey || e.ctrlKey) &&
      e.key.toLowerCase() === "z" &&
      !e.shiftKey
    ) {
      if (!isEditingText) {
        e.preventDefault();
        engine?.undo();
      }
    }
    // Redo: Cmd+Shift+Z / Ctrl+Y
    else if (
      ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && e.shiftKey) ||
      ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y")
    ) {
      if (!isEditingText) {
        e.preventDefault();
        engine?.redo();
      }
    }
    // Copy: Cmd+C / Ctrl+C
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
      if (!isEditingText && engine) {
        const active = engine.canvas.getActiveObject();
        if (active) {
          active.clone().then((cloned) => {
            clipboard = cloned;
          });
        }
      }
    }
    // Paste: Cmd+V / Ctrl+V
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
      if (!isEditingText && engine && clipboard) {
        clipboard.clone().then((cloned) => {
          cloned.set({
            left: (cloned.left || 0) + 20,
            top: (cloned.top || 0) + 20,
            evented: true,
          });
          if (cloned.type === "activeselection") {
            cloned.canvas = engine.canvas;
            cloned.forEachObject((obj) => {
              engine.canvas.add(obj);
            });
            cloned.setCoords();
          } else {
            engine.canvas.add(cloned);
          }
          engine.canvas.setActiveObject(cloned);
          engine.canvas.requestRenderAll();
          engine.recordHistory();
        });
      }
    }
    // Delete
    else if (e.key === "Delete" || e.key === "Backspace") {
      if (!isEditingText && engine?.canvas.getActiveObject()) {
        e.preventDefault();
        engine?.deleteSelected();
      }
    }
    // Zoom shortcuts. Keep active even while editing text — typing into a
    // textbox never needs +, -, or 0 from the host keyboard.
    else if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      zoomIn();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "-") {
      e.preventDefault();
      zoomOut();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "0") {
      e.preventDefault();
      zoomReset();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "9") {
      e.preventDefault();
      zoomFit("width");
    } else if ((e.metaKey || e.ctrlKey) && e.key === "8") {
      e.preventDefault();
      zoomFit("page");
    }
  };
}

/** Fills library card previews from IndexedDB once the grid is in the DOM. */
async function hydrateThumbnails() {
  const nodes = document.querySelectorAll("img[data-thumb]");
  for (const node of nodes) {
    const assetId = node.dataset.thumb;
    if (!assetId) continue;
    try {
      const url = await getAssetUrl(assetId);
      if (url) node.src = url;
    } catch {
      // Leave the placeholder in place if the asset is missing.
    }
  }
}

function bindLibraryEvents() {
  hydrateThumbnails();

  document.querySelectorAll("[data-open]").forEach((card) => {
    card.addEventListener("click", () => {
      activeId = card.dataset.open;
      render();
    });
  });

  // Sidebar destinations: Unfiled / Pinned / Trash / individual folders.
  document.querySelectorAll(".side[data-folder]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      // Folder rows have a small × button to delete the folder; ignore those.
      if (e.target.closest("[data-remove-folder]")) return;
      const target = btn.dataset.folder;
      // If the folder it points to was deleted, fall back to Unfiled.
      if (target && target.startsWith(FOLDER_PREFIX)) {
        const id = target.slice(FOLDER_PREFIX.length);
        if (!folderById(id)) {
          activeFolder = "unfiled";
          render();
          return;
        }
      }
      activeFolder = target;
      render();
    });
  });

  // "+ New folder" button — prompts for a name and creates the folder.
  document.querySelector("#new-folder-btn")?.addEventListener("click", () => {
    const name = (prompt("Folder name:") || "").trim();
    if (!name) return;
    const folder = { id: crypto.randomUUID(), name, createdAt: Date.now() };
    folders = [...folders, folder];
    saveFolders();
    activeFolder = FOLDER_PREFIX + folder.id;
    render();
  });

  // Per-folder × to remove (notes inside the folder become Unfiled).
  document.querySelectorAll("[data-remove-folder]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.removeFolder;
      const folder = folderById(id);
      if (!folder) return;
      if (!confirm(`Delete folder "${folder.name}"? Notes inside will move to Unfiled.`)) return;
      const moved = notes.filter((n) => n.folderId === id).length;
      for (const n of notes) if (n.folderId === id) n.folderId = null;
      folders = folders.filter((f) => f.id !== id);
      saveFolders();
      saveNotes();
      if (activeFolder === FOLDER_PREFIX + id) activeFolder = "unfiled";
      console.info(`Removed folder "${folder.name}" (${moved} notes moved to Unfiled)`);
      render();
    });
  });

  // Pin toggle on a card.
  document.querySelectorAll("[data-pin]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const n = notes.find((x) => x.id === btn.dataset.pin);
      if (!n) return;
      n.pinned = !n.pinned;
      saveNotes();
      render();
    });
  });

  // Restore from Trash.
  document.querySelectorAll("[data-restore]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const n = notes.find((x) => x.id === btn.dataset.restore);
      if (!n) return;
      n.trashed = false;
      saveNotes();
      render();
    });
  });

  // Per-card folder select.
  document.querySelectorAll("[data-folder-select]").forEach((sel) => {
    sel.addEventListener("change", (e) => {
      e.stopPropagation();
      const n = notes.find((x) => x.id === sel.dataset.folderSelect);
      if (!n) return;
      const v = sel.value;
      n.folderId = v === "__none__" ? null : v;
      saveNotes();
      // If the note just left the current view, re-render to hide it.
      const stillVisible = notesInCurrentView().some((x) => x.id === n.id);
      if (!stillVisible) render();
    });
    // The card's <button> would otherwise intercept the click; stop bubbling
    // so a click on the select opens the dropdown instead of opening the card.
    sel.addEventListener("click", (e) => e.stopPropagation());
  });

  // Card trash button — move to trash outside trash, delete forever inside.
  document.querySelectorAll("[data-delete-note]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const noteId = btn.dataset.deleteNote;
      const targetNote = notes.find((n) => n.id === noteId);
      if (!targetNote) return;
      if (activeFolder === "trashed") {
        if (!confirm(`Delete "${targetNote.title}" forever? This cannot be undone.`)) return;
        await deleteAssets(collectNoteAssetIds(targetNote));
        invalidatePdfDoc(targetNote?.pdfAssetId);
        notes = notes.filter((n) => n.id !== noteId);
        if (activeId === noteId) activeId = notes[0]?.id || null;
        saveNotes();
        render();
        return;
      }
      // Move to trash (no confirm — undoable via Restore).
      targetNote.trashed = true;
      // Leaving a folder for trash clears the folder pin.
      saveNotes();
      render();
    });
  });

  // Search filter
  document.querySelector("#search-input")?.addEventListener("input", (e) => {
    const query = e.target.value.toLowerCase().trim();
    document.querySelectorAll(".note-card-wrapper").forEach((cardWrapper) => {
      const titleEl = cardWrapper.querySelector("strong");
      const title = titleEl ? titleEl.textContent.toLowerCase() : "";
      if (title.includes(query)) {
        cardWrapper.style.display = "flex";
      } else {
        cardWrapper.style.display = "none";
      }
    });
  });

  const handleNewNote = () => {
    const newNote = {
      id: crypto.randomUUID(),
      title: "Untitled Notebook",
      createdAt: Date.now(),
      isPdf: false,
      currentPageIndex: 0,
      pages: [
        {
          id: crypto.randomUUID(),
          pageNumber: 1,
          width: 800,
          height: 1130,
          paperStyle: "lined",
          pageSize: "a4",
          thumbnail: null,
          canvasJson: null,
          pendingDecomposedData: null,
          tags: [],
        },
      ],
    };
    notes.unshift(newNote);
    activeId = newNote.id;
    saveNotes();
    render();
  };

  document
    .querySelector("#new-note-btn")
    ?.addEventListener("click", handleNewNote);
  document
    .querySelector("#fab-new-note")
    ?.addEventListener("click", handleNewNote);

  // Import PDF into a single multi-page notebook
  document
    .querySelector("#pdf-input")
    ?.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      isLoading = true;
      loadingMessage = `Reading '${file.name}'...`;
      renderLoading();

      // Every asset this import creates, so a failure can clean up after
      // itself without touching anything an existing notebook owns.
      const createdAssetIds = [];

      // Read the mode once, before any await, so a change mid-import cannot
      // produce a notebook that is half one thing and half the other.
      const importMode =
        document.querySelector("#import-mode")?.value === "annotations"
          ? "annotations"
          : "editable";

      try {
        const buffer = await file.arrayBuffer();

        // Persist each page's binary assets as soon as it is decomposed instead
        // of holding every page's background in memory until the document
        // finishes.
        const pages = await decomposePdf(
          buffer,
          1.333333,
          async (page, index) => {
          const ids = {};

          // When the only unrecovered content is the page's own backdrop, the
          // extracted backdrop image replaces the whole-page render. The render
          // also contains the content we recovered, so using it would paint
          // everything twice — visibly, because the raster's substituted font
          // and the text object's font do not share advance widths.
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

          // Embedded images are often the heaviest part of an export, so they
          // go to the asset store as real blobs rather than inline base64.
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

          loadingMessage =
            importMode === "annotations"
              ? `Rendering page ${index + 1}...`
              : `Recovering page ${index + 1}...`;
          renderLoading();

          // Drop the page-level blobs so nothing binary ends up persisted.
          return {
            ...page,
            ...ids,
            fallbackFromImage,
            backgroundBlob: undefined,
            thumbnailBlob: undefined,
          };
          },
          { mode: importMode },
        );

        if (pages.length === 0) {
          throw new Error("No pages found in this PDF.");
        }

        const baseName = file.name.replace(/\.pdf$/i, "");

        // Keep the original file. The per-page snapshot taken at import is only
        // ~1600px, which turns to mush once you zoom in; holding on to the
        // source lets the visible page be re-rendered at the current zoom.
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
            // The fallback is the extracted backdrop, not a page render, so it
            // must not be replaced by a full-page re-rasterization on zoom —
            // that would reintroduce the very doubling it exists to avoid.
            fallbackFromImage: page.fallbackFromImage === true,
            pendingImportData: {
              objects: page.objects || [],
              report: page.report || null,
            },
            tags: [],
          })),
        };

        notes.unshift(newNotebook);
        activeId = newNotebook.id;
        saveNotes();

        showImportReport(report);
      } catch (err) {
        // Nothing was committed, so delete only what this attempt created and
        // leave every existing notebook exactly as it was.
        await deleteAssets(createdAssetIds).catch(() => {});
        alert("Could not import this PDF: " + err.message);
        console.error(err);
      } finally {
        isLoading = false;
        e.target.value = "";
        render();
      }
    });
}

/**
 * True when a keystroke belongs to a field the user is typing into.
 *
 * Global shortcuts must not fire for these: on macOS the key labelled "Delete"
 * reports `Backspace`, so without this guard correcting a digit in the zoom
 * percentage field would also delete the selected object on the canvas.
 */
function isTypingTarget(el) {
  if (!el || typeof el !== "object") return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[c],
  );
}

/**
 * Folds every page's import report into one notebook-level summary.
 *
 * Counts describe objects that were actually created, never operators that
 * were merely inspected — the whole point is that the report can be trusted.
 */
function summarizeImport(pages) {
  const report = {
    pages: pages.length,
    textObjects: 0,
    vectorGroups: 0,
    imageObjects: 0,
    completePages: 0,
    partialPages: 0,
    fallbackPages: 0,
    fallbackRegions: 0,
    warnings: [],
    errors: [],
  };

  for (const page of pages) {
    const r = page.report;
    if (!r) continue;

    report.textObjects += r.textObjects || 0;
    report.vectorGroups += r.vectorGroups || 0;
    report.imageObjects += r.imageObjects || 0;
    report.fallbackRegions += r.fallbackRegions || 0;

    if (r.status === "complete") report.completePages++;
    else if (r.status === "fallback") report.fallbackPages++;
    else report.partialPages++;

    for (const w of r.warnings || []) {
      if (!report.warnings.includes(w)) report.warnings.push(w);
    }
    for (const e of r.errors || []) {
      if (!report.errors.includes(e)) report.errors.push(e);
    }
  }

  if (report.fallbackPages === report.pages) {
    report.status = "fallback";
  } else if (report.partialPages > 0 || report.fallbackPages > 0) {
    report.status = "partial";
  } else {
    report.status = "complete";
  }

  return report;
}

const IMPORT_WARNING_TEXT = {
  "unsupported-graphics-operators": "Some graphics could not be converted.",
  "unsupported-annotations": "Some annotations stayed in the page image.",
  "images-left-in-fallback": "Some images could not be extracted.",
  "page-sized-images-kept-in-fallback": "Full-page images stayed in the page image.",
  "low-confidence-regions-kept-in-fallback": "Uncertain regions were kept as an image.",
  "text-colour-approximated": "Text colours were approximated.",
  "text-extraction-failed": "Text could not be read on this page.",
  "operator-stream-failed": "Part of the page could not be read.",
  "fallback-render-failed": "The page image could not be rendered.",
  "operator-list-unavailable": "The page content stream was unreadable.",
  "annotation-scan-failed": "Annotations could not be inspected.",
};

/**
 * Non-blocking completion card.
 *
 * Deliberately a corner toast rather than a modal: the notebook is usable the
 * moment the import finishes, and nothing here waits for the user.
 */
function showImportReport(report) {
  // Only clears a previous *completion* toast; a storage warning is a
  // different, more important message and must survive this.
  document.querySelector(".import-report")?.remove();

  const lines = [];
  lines.push(`${report.pages} ${report.pages === 1 ? "page" : "pages"} imported`);

  const recovered = [];
  if (report.textObjects) recovered.push(`${report.textObjects} editable text`);
  if (report.imageObjects) recovered.push(`${report.imageObjects} image${report.imageObjects === 1 ? "" : "s"}`);
  if (report.vectorGroups) recovered.push(`${report.vectorGroups} ink group${report.vectorGroups === 1 ? "" : "s"}`);
  lines.push(recovered.length ? recovered.join(" · ") : "No editable content recovered");

  if (report.fallbackPages > 0) {
    lines.push(
      `${report.fallbackPages} ${report.fallbackPages === 1 ? "page kept" : "pages kept"} as an image`,
    );
  } else if (report.partialPages > 0) {
    lines.push(
      `${report.partialPages} partial ${report.partialPages === 1 ? "page" : "pages"} keep their original image underneath`,
    );
  }

  const card = document.createElement("div");
  card.className = `import-report import-report--${report.status}`;
  card.setAttribute("role", "status");

  const title = document.createElement("strong");
  title.textContent =
    report.status === "complete"
      ? "Import complete"
      : report.status === "fallback"
        ? "Imported as page images"
        : "Import finished with gaps";
  card.appendChild(title);

  for (const line of lines) {
    const p = document.createElement("span");
    p.textContent = line;
    card.appendChild(p);
  }

  const notes = (report.warnings || [])
    .map((w) => IMPORT_WARNING_TEXT[w] || w)
    .filter(Boolean);
  if (notes.length) {
    const list = document.createElement("em");
    list.textContent = notes.slice(0, 3).join(" ");
    card.appendChild(list);
  }

  const close = document.createElement("button");
  close.type = "button";
  close.className = "import-report-close";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => card.remove());
  card.appendChild(close);

  document.body.appendChild(card);

  setTimeout(() => card.remove(), 9000);
}

// Dev-only inspection hook for the browser regression harness. Vite replaces
// `import.meta.env.DEV` with `false` in a production build, so this whole
// block is dead code there and is dropped by the minifier.
if (import.meta.env.DEV) {
  window.__omni = {
    getNotes: () => notes,
    getActiveId: () => activeId,
    getEngines: () => canvasEngines,
    /** Snapshot of every object on a page, for assertions. */
    inspectPage: (index) => {
      const engine = canvasEngines[index];
      if (!engine) return null;
      return {
        width: engine.width,
        height: engine.height,
        backgroundVisible: engine.backgroundVisible,
        hasBackground: Boolean(engine.canvas.backgroundImage),
        objects: engine.canvas.getObjects().map((o) => ({
          type: o.type,
          omniType: o.omniType,
          sourceType: o.sourceType,
          omniId: o.omniId,
          assetId: o.assetId,
          text: o.text,
          left: Math.round(o.left),
          top: Math.round(o.top),
          angle: Math.round((o.angle || 0) * 100) / 100,
          width: Math.round(o.width || 0),
          height: Math.round(o.height || 0),
          // Fabric v6+ keeps group children on `_objects`.
          children: o._objects ? o._objects.length : undefined,
        })),
      };
    },
  };
}

disableBrowserZoom();

// Every page's object graph lives in IndexedDB, so the first render has to
// wait for it — rendering early would show blank imported pages.
hydrateNotes()
  .catch((err) => console.warn("Could not restore page data:", err))
  .finally(() => render());
