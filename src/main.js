import "./style.css";
import { OmniCanvas } from "./canvas/engine.js";
import {
  configureViewport,
  ZOOM_MIN,
  ZOOM_MAX,
  getCurrentZoom,
  setCurrentZoom,
  isZoomLocked,
  updateZoomUI,
  beginZoomGesture,
  endZoomGesture,
  disableBrowserZoom,
  setZoom,
  toggleZoomLock,
  applyDefaultZoom,
  initZoomWindow,
  toggleZoomWindow,
  hideZoomWindow,
  attachZoomWindow,
  zoomIn,
  zoomOut,
  zoomReset,
  zoomFit,
  zoomWindowNextLine,
  zoomWindowNudge,
  zoomWindowMoveTo,
} from "./canvas/viewport.js";

import { exportNotebookToPdf, renderPageThumbnail } from "./pdf/exporter.js";
import {
  putAsset,
  putAssetFromDataUrl,
  deleteAssets,
  collectPageAssetIdsDeep,
} from "./storage/assets.js";
import { createPersistence } from "./app/persistence.js";
import { createImportFlow } from "./app/importFlow.js";
import { createEditorShortcuts } from "./app/editorShortcuts.js";
import { createBackup } from "./app/backup.js";
import { createPageManager } from "./app/pageManager.js";
import { createLibraryEvents } from "./app/libraryEvents.js";
import { icon } from "./ui/icons.js";
import { escapeHtml } from "./ui/escapeHtml.js";
import {
  showStorageWarning,
  clearStorageWarning,
  showToast,
  showConfirm,
  showPrompt,
} from "./ui/dialogs.js";
import { libraryView as renderLibraryHtml } from "./ui/libraryView.js";
import { createToolbar } from "./ui/toolbar.js";
import { autoCheckForUpdates } from "./updater.js";

const STORE_KEY = "omninote-notes-v2";
const FOLDERS_KEY = "omninote-folders";

const PAGE_SIZES = {
  a4: { label: "A4 (Standard)", width: 800, height: 1130 },
  letter: { label: "US Letter", width: 800, height: 1035 },
  slide: { label: "16:9 Slide", width: 1200, height: 675 },
  square: { label: "Square (1:1)", width: 800, height: 800 },
};

const FOLDER_PREFIX = "folder:";
const SAFE_PAPER_STYLES = new Set(["plain", "lined", "grid", "dotted", "cornell", "music"]);

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

const normalizedNotes = new WeakSet();
let notes = [];
let activeId = null;
let lastRenderedNoteId = null;
let canvasEngines = [];
// Pages whose IndexedDB payloads have been loaded (or confirmed absent).
// A WeakSet keeps this out of the persisted notebook record.
const hydratedPages = new WeakSet();

let scheduleSnapshotRef = () => {};
const persistence = createPersistence({
  storeKey: STORE_KEY,
  getNotes: () => notes,
  getFolders: () => folders,
  getCustomColors: () => customColors,
  normalizedNotes,
  hydratedPages,
  showStorageWarning,
  clearStorageWarning,
  onSaved: () => scheduleSnapshotRef(),
});
const {
  normalizeNote,
  loadNotes,
  saveNotes,
  hydratePage,
  hydrateNote,
  hydrateNotes,
  isNoteHydrated,
  flushPayloads,
  pendingWrites,
  snapshotNotes,
  restoreFromSnapshot,
  scheduleSnapshot,
} = persistence;
scheduleSnapshotRef = scheduleSnapshot;
const pageHistoryCache = new Map(); // pageId -> { history, historyIndex }
// Keep undo history for only the most recently evicted pages; otherwise
// scrolling a long notebook pins a full snapshot stack for every page.
const PAGE_HISTORY_CACHE_LIMIT = 8;
// Off-window pages render as a static preview. Re-rasterizing one on every
// window change would make scrolling through a long notebook far more
// expensive than the engines the window exists to avoid, so the preview is
// cached per page and only dropped when that page's content changes.
const staticThumbCache = new Map(); // pageId -> data URL
const STATIC_THUMB_WIDTH = 320;
// Rendering every off-window preview at once (common on first open of a long
// notebook) used to spawn dozens of concurrent PDF renders. Serialize them
// behind a small concurrency limit instead.
const THUMB_RENDER_CONCURRENCY = 3;
let thumbRenderActive = 0;
const thumbRenderQueue = [];
function pumpThumbRenderQueue() {
  while (thumbRenderActive < THUMB_RENDER_CONCURRENCY && thumbRenderQueue.length) {
    const task = thumbRenderQueue.shift();
    thumbRenderActive++;
    task()
      .catch(() => {})
      .finally(() => {
        thumbRenderActive--;
        pumpThumbRenderQueue();
      });
  }
}
function queueThumbRender(task) {
  return new Promise((resolve, reject) => {
    thumbRenderQueue.push(() =>
      Promise.resolve()
        .then(task)
        .then(resolve, reject),
    );
    pumpThumbRenderQueue();
  });
}
/**
 * Visibility margin a neighbouring page must clear before it dethrones the
 * current page. Without it the scroll observer flaps between two pages near
 * 50/50 visibility, and every flap destroys and remounts live engines.
 */
const ACTIVE_PAGE_HYSTERESIS = 0.15;
// Recent engine-mount failures (page index, message, timestamp), newest last,
// capped so a pathological page cannot grow memory.
const mountErrors = [];
function recordMountError(index, err) {
  mountErrors.push({
    pageIndex: index,
    message: String(err?.message || err),
    at: Date.now(),
  });
  while (mountErrors.length > 20) mountErrors.shift();
}

// Bumped on every editor render so a superseded render's pending awaits can
// bail out instead of writing engines into the view that replaced it.
let editorInitToken = 0;
// Sliding-window updates run one at a time; see `scheduleEngineWindow`.
let engineWindowChain = Promise.resolve();
// Stored so the scroll observer and outside-click listener can be cleaned up
// before a new render replaces them. Without this, every render leaks another
// observer and another document-level click handler.
let scrollObserver = null;
let outsideClickHandler = null;
// Same for the editor keyboard shortcuts: bindEditorEvents runs on every
// render, so the previous window-level handler must be removed first.
// (Missing this declaration once crashed every return to the library with
// `ReferenceError: editorKeyHandler is not defined`.)
let editorKeyHandler = null;
let currentTool = "select";
let currentColor = sanitizeColor("#176a72");
let currentWidth = 4;
let currentPenStyle = "ballpoint";
/** Every palette starts from this, so there is always at least one colour. */
const DEFAULT_COLOR = "#176a72";
/** Two-column rail: eleven swatches plus the add button. */
const MAX_SWATCHES = 11;

/** Accepts only safe hex colors to prevent CSS/attribute injection. */
function isSafeColor(value) {
  return typeof value === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value.trim());
}
function sanitizeColor(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return isSafeColor(trimmed) ? trimmed : DEFAULT_COLOR;
}

let customColors = [];
try {
  const parsed = JSON.parse(localStorage.getItem("omninote-custom-colors"));
  if (Array.isArray(parsed)) {
    customColors = parsed.map(sanitizeColor).filter(isSafeColor);
  }
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
let librarySelectionMode = false;
const selectedNoteIds = new Set();




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
  if (!note || !canvasEngines) return null;
  return canvasEngines[note.currentPageIndex] || null;
}

/**
 * Switch every canvas engine to `tool` and keep the toolbar's selected state
 * in sync. Used by both the toolbar buttons and the single-key shortcuts
 * (V/P/H/E/T) advertised in the shortcuts dialog.
 */
function setActiveTool(tool) {
  currentTool = tool;
  canvasEngines.forEach((e) => e?.setTool(currentTool));

  document
    .querySelectorAll("[data-tool]")
    .forEach((b) => b.classList.remove("selected"));
  document
    .querySelector(`[data-tool="${tool}"]`)
    ?.classList.add("selected");

  const engine = getActiveCanvasEngine();
  if (engine) {
    updateFontToolbarState(engine.canvas.getActiveObjects());
  }
}

function beginLoading(message) {
  isLoading = true;
  loadingMessage = message;
  renderLoading();
}

function endLoading() {
  isLoading = false;
}

const {
  releaseReplacedBackground,
  isPromotablePage,
  promoteControlsHtml,
  refreshPromoteControls,
  rebuildPageAsEditable,
  promotePageToEditable,
  makeAllPagesEditable,
  handlePdfImport,
  pickPdfFileNative,
} = createImportFlow({
  getNotes: () => notes,
  setActiveId: (id) => {
    activeId = id;
  },
  registerNote: (note) => normalizedNotes.add(note),
  getActiveNote,
  getCanvasEngines: () => canvasEngines,
  saveNotes,
  saveEngineToPage,
  render,
  setLoading: beginLoading,
  clearLoading: endLoading,
});

const { backupAllNotes, restoreFromBackup, saveBytes } = createBackup({
  getNotes: () => notes,
  setNotes: (next) => {
    notes = next;
  },
  getFolders: () => folders,
  setFolders: (next) => {
    folders = next;
  },
  getCustomColors: () => customColors,
  setCustomColors: (next) => {
    customColors = next;
  },
  setActiveId: (id) => {
    activeId = id;
  },
  markPageHydrated: (page) => hydratedPages.add(page),
  saveFolders,
  saveCustomColors,
  normalizeNote,
  hydrateNote,
  saveNotes,
  render,
  setLoading: beginLoading,
  clearLoading: endLoading,
  refreshLoading: renderLoading,
  sanitizeColor,
  defaultColor: DEFAULT_COLOR,
  safePaperStyles: SAFE_PAPER_STYLES,
});

const {
  pageManagerOverlay,
  openPageManager,
  closePageManager,
  isPageManagerOpen,
  bindPageManagerGrid,
  bindPageManagerControls,
  consumeZoomRestoreTarget,
} = createPageManager({
  getNotes: () => notes,
  getActiveNote,
  getCanvasEngines: () => canvasEngines,
  getActiveCanvasEngine,
  setActiveId: (id) => {
    activeId = id;
  },
  saveNotes,
  render,
  saveActiveCanvasPage,
  saveEngineToPage,
  forgetPageCaches,
  createPageEngine,
  setStaticPageThumbnail,
  hydrateNote,
  setLoading: beginLoading,
  clearLoading: endLoading,
  refreshLoading: renderLoading,
  saveBytes,
  isPromotablePage,
  rebuildPageAsEditable,
  refreshPromoteControls,
  releaseReplacedBackground,
  forgetNoteNormalization: (note) => normalizedNotes.delete(note),
  markPageHydrated: (page) => hydratedPages.add(page),
});

const { bindLibraryEvents } = createLibraryEvents({
  getNotes: () => notes,
  setNotes: (next) => {
    notes = next;
  },
  getActiveId: () => activeId,
  setActiveId: (id) => {
    activeId = id;
  },
  getFolders: () => folders,
  setFolders: (next) => {
    folders = next;
  },
  getActiveFolder: () => activeFolder,
  setActiveFolder: (next) => {
    activeFolder = next;
  },
  isSelectionMode: () => librarySelectionMode,
  setSelectionMode: (on) => {
    librarySelectionMode = on;
  },
  getSelectedNoteIds: () => selectedNoteIds,
  saveNotes,
  saveFolders,
  render,
  folderById,
  notesInCurrentView,
  hydrateNote,
  backupAllNotes,
  restoreFromBackup,
  handlePdfImport,
  pickPdfFileNative,
  markPageHydrated: (page) => hydratedPages.add(page),
  markNoteNormalized: (note) => normalizedNotes.add(note),
  folderPrefix: FOLDER_PREFIX,
});

const { renderFontOptions, updateFontToolbarState, syncToolbarForActivePage } = createToolbar({
  getActiveCanvasEngine,
  getCurrentTool: () => currentTool,
});


const editorShortcuts = createEditorShortcuts({
  getActiveCanvasEngine,
  setActiveTool,
  isPageManagerOpen,
  closePageManager,
  zoomIn,
  zoomOut,
  zoomReset,
  zoomFit,
});

configureViewport({
  getCanvasEngines: () => canvasEngines,
  getActiveNote,
  getActiveCanvasEngine,
  // Static previews are laid out at the page's on-screen size, so they follow
  // the zoom the same way a live canvas does.
  onZoomApplied: () => layoutStaticThumbnails(),
});

async function render() {
  // Never switch views with an unwritten save in flight.
  flushSaveNotes();
  const app = document.querySelector("#app");
  const note = getActiveNote();

  if (note) {
    // Lazy hydration: only load this notebook's page payloads when opening it.
    if (!isNoteHydrated(note)) {
      isLoading = true;
      loadingMessage = "Opening notebook…";
      renderLoading();
      await hydrateNote(note);
      isLoading = false;
    }
    // Preserve zoom across same-notebook re-renders (e.g. add/delete page,
    // rename, promote). Only reset to 1 when opening a different notebook.
    if (note.id !== lastRenderedNoteId) {
      setCurrentZoom(1);
      lastRenderedNoteId = note.id;
    }
    app.innerHTML = editorView(note);
    await initEditor(note);
  } else {
    hideZoomWindow();
    canvasEngines.forEach((engine) => engine?.destroy());
    canvasEngines = [];
    pageHistoryCache.clear();
    staticThumbCache.clear();
    // Clean up editor-scoped listeners before switching to the library view.
    if (scrollObserver) {
      scrollObserver.disconnect();
      scrollObserver = null;
    }
    if (outsideClickHandler) {
      document.removeEventListener("click", outsideClickHandler);
      outsideClickHandler = null;
    }
    if (editorKeyHandler) {
      window.removeEventListener("keydown", editorKeyHandler);
      editorKeyHandler = null;
    }
    lastRenderedNoteId = null;
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
    overlay.setAttribute("role", "status");
    overlay.setAttribute("aria-live", "polite");

    const spinner = document.createElement("div");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    overlay.appendChild(spinner);

    const message = document.createElement("div");
    message.textContent = loadingMessage || "Processing...";
    overlay.appendChild(message);

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
  return renderLibraryHtml({
    notes,
    folders,
    activeFolder,
    visibleNotes: notesInCurrentView(),
    heading: libraryHeading(),
    emptyMsg: emptyMessage(),
    noteCount,
    folderPrefix: FOLDER_PREFIX,
    selectionMode: librarySelectionMode,
    selectedIds: selectedNoteIds,
  });
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
          <input type="range" class="zoom-slider" id="zoom-slider" min="${Math.round(ZOOM_MIN * 100)}" max="${Math.round(ZOOM_MAX * 100)}" step="1" value="${Math.round(getCurrentZoom() * 100)}" title="Drag to zoom" aria-label="Zoom level" />
          <span class="zoom-label-btn" id="zoom-reset-btn" title="Reset to 100% (Cmd/Ctrl + 0) — or type an exact level">
            <input class="zoom-value" id="zoom-value" type="text" inputmode="numeric" value="${Math.round(getCurrentZoom() * 100)}" aria-label="Zoom percentage" title="Type a zoom level and press Enter" />
            <span class="zoom-pct">%</span>
          </span>
          <button class="icon-btn zoom-btn" id="zoom-in-btn" title="Zoom In (Cmd/Ctrl + =)">${icon("zoomIn", 14)}</button>
          <button class="icon-btn zoom-btn" id="zoom-fit-width-btn" title="Fit Width (Cmd/Ctrl + 9)">${icon("fitWidth", 14)}</button>
          <button class="icon-btn zoom-btn" id="zoom-fit-page-btn" title="Fit Whole Page (Cmd/Ctrl + 8)">${icon("fitPage", 14)}</button>
          <button class="icon-btn zoom-btn" id="zoom-lock-btn" title="Lock zoom">${icon(isZoomLocked() ? "lockClosed" : "lockOpen", 14)}</button>
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
          <span class="save-status" id="save-status" aria-live="polite">Saved</span>
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
              <button class="paper-btn ${page.paperStyle === "cornell" ? "active" : ""}" data-paper="cornell" title="Cornell Notes">
                <div class="paper-preview p-cornell"></div>
              </button>
              <button class="paper-btn ${page.paperStyle === "music" ? "active" : ""}" data-paper="music" title="Music Staff">
                <div class="paper-preview p-music"></div>
              </button>
            </div>
          </div>
          <div class="page-setup-row">
            <label>Page Size</label>
            <select id="page-size-select">
              <option value="custom" ${page.pageSize === "custom" || !page.pageSize ? "selected" : ""}>Current (${page.width} × ${page.height} px)</option>
              <option value="a4" ${page.pageSize === "a4" ? "selected" : ""}>A4 (800 × 1130)</option>
              <option value="letter" ${page.pageSize === "letter" ? "selected" : ""}>US Letter (800 × 1035)</option>
              <option value="slide" ${page.pageSize === "slide" ? "selected" : ""}>16:9 Slide (1200 × 675)</option>
              <option value="square" ${page.pageSize === "square" ? "selected" : ""}>Square (800 × 800)</option>
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

        <!-- Canvas Viewport.
             Each wrapper reserves its page's exact on-screen box up front so
             mounting or disposing an engine never moves the pages below it.
             Without the reserved box, showing/hiding the static preview shifts
             every following offsetTop, and a programmatic scroll measured
             before the shift lands on the wrong page. -->
        <section class="canvas-wrap" id="canvas-scroll-container">
          ${note.pages
            .map((p, i) => {
              const box = pageDisplaySize(p);
              return `
            <div class="page-container" id="page-wrapper-${i}" data-index="${i}" style="width:${box.width}px;height:${box.height}px">
              <canvas id="omni-canvas-${i}"></canvas>
              <img id="omni-thumb-${i}" class="page-thumbnail" alt="Page ${i + 1}" hidden />
            </div>
          `;
            })
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
          ${promoteControlsHtml(note, page)}
        </div>
      </div>
      ${pageManagerOverlay(note)}
    </div>
  `;
}

/**
 * The set of page indexes that should have a live engine for `note`.
 *
 * The window is the current page plus one neighbour on each side, clamped to
 * the notebook. Everything outside it renders as a static preview.
 */
function windowIndexes(note) {
  const currentIndex = note.currentPageIndex || 0;
  const radius = 1;
  const live = new Set();
  for (
    let i = Math.max(0, currentIndex - radius);
    i <= Math.min(note.pages.length - 1, currentIndex + radius);
    i++
  ) {
    live.add(i);
  }
  return live;
}

/**
 * Writes one engine's current state back onto the page record it was loaded
 * with.
 *
 * Saving through `engine.page` rather than through the engine's slot in
 * `canvasEngines` is what makes page insert / delete / reorder safe: those
 * operations shift every index after the change while the engines keep
 * pointing at the pages they were actually loaded with. An index-keyed save
 * would write one page's content onto its neighbour.
 */
function saveEngineToPage(engine) {
  if (!engine || !engine.page) return;
  const page = engine.page;
  const json = engine.toJSON();
  page.canvasJson = json;
  page.width = json.width;
  page.height = json.height;
  page.paperStyle = json.paperStyle;
  // The page changed, so its cached off-window preview is stale.
  staticThumbCache.delete(page.id);
  engine.dirty = false;
}

/** Drops the per-page caches for a page that is leaving the notebook. */
function forgetPageCaches(page) {
  if (!page) return;
  pageHistoryCache.delete(page.id);
  staticThumbCache.delete(page.id);
}

async function initEditor(note) {
  // A newer render supersedes this one; its awaits must not write into the
  // DOM the new view already replaced.
  const token = ++editorInitToken;
  engineWindowChain = Promise.resolve();

  // Save whatever engines are currently alive before tearing them down. This
  // is safe even when `note.pages` was just reshuffled, because each engine
  // saves onto its own page record.
  saveActiveCanvasPage();

  // Build (or rebuild) the sliding window of engines around the current page.
  for (const engine of canvasEngines) engine?.destroy();
  canvasEngines = [];

  const liveIndexes = windowIndexes(note);

  // When returning from the Page Manager we want to keep the zoom the user had,
  // rather than snapping back to fit-width. The flag is only set across those
  // two transitions, so normal note opens still fit to width.
  const restoreZoom = consumeZoomRestoreTarget();
  if (restoreZoom != null) setCurrentZoom(restoreZoom);
  const applyDefaultOnOpen = restoreZoom == null;

  let needsSave = false;

  for (let i = 0; i < note.pages.length; i++) {
    const page = note.pages[i];
    const canvasEl = document.querySelector(`#omni-canvas-${i}`);
    const thumbEl = document.querySelector(`#omni-thumb-${i}`);
    if (!canvasEl || !thumbEl) continue;

    if (!liveIndexes.has(i)) {
      // Outside the window: no engine, just a static preview.
      canvasEl.hidden = true;
      thumbEl.hidden = false;
      setStaticPageThumbnail(thumbEl, page, note);
      continue;
    }

    canvasEl.hidden = false;
    thumbEl.hidden = true;
    thumbEl.removeAttribute("src");

    let mounted = null;
    try {
      mounted = await createPageEngine(canvasEl, page, note, i);
    } catch (err) {
      // Same poison-page rule as the window update: fall back to the static
      // preview for this page instead of aborting the whole editor setup.
      console.error(`Could not mount page ${i}:`, err);
      recordMountError(i, err);
      canvasEl.hidden = true;
      thumbEl.hidden = false;
      setStaticPageThumbnail(thumbEl, page, note);
      continue;
    }
    if (token !== editorInitToken) {
      mounted.engine.destroy();
      return;
    }
    canvasEngines[i] = mounted.engine;
    if (mounted.clearedPending) needsSave = true;

    // Initial welcome text on first page
    if (
      i === 0 &&
      note.id === "welcome-note" &&
      !page.canvasJson &&
      !mounted.clearedPending
    ) {
      mounted.engine.addTextAt("Welcome to OmniNote", 100, 100);
      mounted.engine.addTextAt(
        "Import any PDF using 'Import PDF' to edit text, images, and strokes!",
        100,
        170,
      );
      mounted.engine.setTool("select");
      page.canvasJson = mounted.engine.toJSON();
      needsSave = true;
    }
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

  if (token !== editorInitToken) return;

  // Wide imported pages are the common case, so open pulled back to fit width.
  // Skip this when restoring a user's zoom across a Page Manager round-trip.
  if (applyDefaultOnOpen) applyDefaultZoom();
  initZoomWindow();

  // Set up scroll observer to update active page index
  const scrollContainer = document.querySelector("#canvas-scroll-container");
  if (scrollContainer) {
    // Disconnect the previous render's observer before creating a new one.
    if (scrollObserver) scrollObserver.disconnect();
    // Latest visibility per page across observer callbacks. A callback only
    // delivers pages whose ratio *changed*, so crowning the max of a single
    // batch flaps between neighbours sitting near 50/50 — and every flip
    // destroys and remounts live engines. The table makes the decision global;
    // the hysteresis margin below makes it sticky.
    const pageVisibility = new Map();
    // Synchronous ground truth for the incumbent page. The table can hold a
    // stale zero for the current page while a neighbour's threshold-crossing
    // arrives first; judging the switch on that stale value dethrones a page
    // that is actually fully visible. Measuring the incumbent live on every
    // decision closes the hole (one rect read per callback batch).
    const measureRatio = (index) => {
      const el = document.querySelector(`#page-wrapper-${index}`);
      if (!el) return 0;
      const c = scrollContainer.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const visible = Math.max(
        0,
        Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top),
      );
      return visible / Math.max(1, r.height);
    };
    scrollObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          pageVisibility.set(
            Number(entry.target.dataset.index),
            entry.isIntersecting ? entry.intersectionRatio : 0,
          );
        }
        const currentRatio = measureRatio(note.currentPageIndex);
        let bestIndex = note.currentPageIndex;
        let bestRatio = currentRatio;
        for (const [index, ratio] of pageVisibility) {
          if (
            index !== note.currentPageIndex &&
            ratio > bestRatio + ACTIVE_PAGE_HYSTERESIS
          ) {
            bestRatio = ratio;
            bestIndex = index;
          }
        }
        if (bestIndex !== note.currentPageIndex) {
          note.currentPageIndex = bestIndex;
          document.querySelector(".page-counter-text").textContent =
            `Page ${note.currentPageIndex + 1} of ${note.pages.length}`;
          // Update nav buttons disabled state
          const prevBtn = document.querySelector("#prev-page-btn");
          const nextBtn = document.querySelector("#next-page-btn");
          if (prevBtn) prevBtn.disabled = note.currentPageIndex === 0;
          if (nextBtn)
            nextBtn.disabled = note.currentPageIndex === note.pages.length - 1;
          // Move the sliding window to follow the viewport. The page that is
          // leaving is flushed inside the update, and the zoom window and
          // toolbar can only be re-pointed once the incoming engine exists.
          scheduleEngineWindow(note).then(() => {
            attachZoomWindow();
            syncToolbarForActivePage();
          });
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
      .forEach((el) => scrollObserver.observe(el));

    // Restore the scroll position the user left this notebook at.
    if (note.scrollPosition) {
      const prevBehavior = scrollContainer.style.scrollBehavior;
      scrollContainer.style.scrollBehavior = "auto";
      scrollContainer.scrollTop = note.scrollPosition;
      scrollContainer.style.scrollBehavior = prevBehavior;
    }

    // Remember where the user leaves this notebook, so reopen lands in the
    // same place. Debounced so a long scroll does not rewrite on every pixel.
    let scrollSaveTimer = null;
    scrollContainer.addEventListener(
      "scroll",
      () => {
        if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
        scrollSaveTimer = setTimeout(() => {
          if (!document.contains(scrollContainer)) return;
          note.scrollPosition = scrollContainer.scrollTop;
          scheduleSaveNotes();
        }, 500);
      },
      { passive: true },
    );

    // Scroll to the active page on load. This must land instantly: the
    // workspace scrolls smoothly (see `.canvas-wrap`), and a fresh render
    // starts at the top, so a smooth scroll here would animate all the way
    // from page 1 to the active page (e.g. 1→6 when adding a page after 5).
    // Same pattern as `restoreZoomAnchor` in viewport.js.
    const activeWrapper = document.querySelector(
      `#page-wrapper-${note.currentPageIndex}`,
    );
    if (activeWrapper) {
      const prevBehavior = scrollContainer.style.scrollBehavior;
      scrollContainer.style.scrollBehavior = "auto";
      activeWrapper.scrollIntoView({ block: "start" });
      scrollContainer.style.scrollBehavior = prevBehavior;
    }
  }
  syncToolbarForActivePage();
  bindEditorEvents(note);
}

/**
 * Builds a live engine for one page and restores anything the engine carries
 * across the sliding window (undo history, zoom, PDF background source).
 *
 * Returns the engine plus whether the import handoff was consumed, so the
 * caller can decide if a save is needed. The engine is *not* inserted into
 * `canvasEngines` here — that is the caller's job once it has confirmed the
 * view is still current.
 */
async function createPageEngine(canvasEl, page, note, index) {
  const engine = new OmniCanvas(canvasEl, {
    width: Math.round(page.width || 800),
    height: Math.round(page.height || 1130),
    paperStyle: page.paperStyle || "plain",
    defaultFont: note.defaultFont || "DM Sans",
    onModified: () => saveActiveCanvasPage({ immediate: false }),
    onHistoryChange: ({ canUndo, canRedo }) => {
      // Only update buttons if this is the active canvas
      if (note.currentPageIndex === index) {
        const undoBtn = document.querySelector("#undo-btn");
        const redoBtn = document.querySelector("#redo-btn");
        if (undoBtn) undoBtn.disabled = !canUndo;
        if (redoBtn) redoBtn.disabled = !canRedo;
      }
    },
    onSelectionChange: (selected) => {
      if (note.currentPageIndex === index) updateFontToolbarState(selected);
    },
    onZoomChange: (z) => updateZoomUI(z),
    // Pinch/wheel zoom takes the exact route the slider takes.
    onZoomStart: (clientX, clientY) => beginZoomGesture(clientX, clientY),
    onZoomEnd: () => endZoomGesture(),
    onZoomRequest: (percent, preview) => setZoom(percent / 100, { preview }),
    // A lazy-imported page renders its background from the source PDF on first
    // open. Once it lands, persist the blob so the next open reads it from
    // IndexedDB instead of re-rendering.
    onBackgroundRaster: (blob) => {
      if (page.backgroundAssetId || !blob) return;
      const assetId = `bg-${crypto.randomUUID()}`;
      putAsset(assetId, blob)
        .then(() => {
          page.backgroundAssetId = assetId;
          saveNotes();
        })
        .catch(() => {});
    },
  });

  engine.setColor(currentColor);
  engine.setWidth(currentWidth);
  engine.setTool(currentTool);
  await hydratePage(page);
  await engine.loadPage(page);

  // Restore the previous undo/redo stack if this page had an engine before.
  const cachedHistory = pageHistoryCache.get(page.id);
  if (cachedHistory) engine.setHistoryState(cachedHistory);

  // The import handoff is one-shot: clear it only once the page has actually
  // been loaded, so a failed load can still be retried on the next open.
  let clearedPending = false;
  if (page.pendingImportData || page.pendingDecomposedData) {
    page.pendingImportData = null;
    page.pendingDecomposedData = null;
    clearedPending = true;
  }

  engine.zoomLocked = isZoomLocked();
  // Every live engine is within one page of the viewport, so every live engine
  // renders at full quality — the rule the pre-window code used for
  // `currentPageIndex ± 1`. Only the pages outside the window are held back,
  // and those have no engine at all.
  engine.isActivePage = true;

  // Carry the global zoom across so a remounted page matches the others. Apply
  // it before the background source is set so the first raster is scheduled at
  // the correct zoom instead of snapping after a 100% preview.
  if (engine.currentZoom !== getCurrentZoom()) {
    engine.setZoom(getCurrentZoom(), { force: true });
  }

  if (
    note.pdfAssetId &&
    Number.isInteger(page.pdfPageIndex) &&
    !page.fallbackFromImage &&
    !page.pdfBackgroundRotated
  ) {
    engine.setPdfBackgroundSource({
      assetId: note.pdfAssetId,
      pageIndex: page.pdfPageIndex,
    });
  }

  return { engine, clearedPending };
}

/** The on-screen size a live canvas for `page` would have right now. */
function pageDisplaySize(page) {
  const z = getCurrentZoom();
  return {
    width: Math.max(1, Math.round((page.width || 800) * z)),
    height: Math.max(1, Math.round((page.height || 1130) * z)),
  };
}

/**
 * Sets a static, non-interactive page preview when the page is outside the
 * sliding window. This keeps long notebooks memory-flat: only the current page
 * and its neighbours get a full OmniCanvas engine.
 *
 * The wrapper already reserves the page's box (see editorView), so the
 * preview only fills it. Previews are cached per page so scrolling does not
 * re-rasterize every off-window page on every window change.
 */
async function setStaticPageThumbnail(imgEl, page, note) {
  await hydratePage(page);
  const { width, height } = pageDisplaySize(page);
  imgEl.style.width = `${width}px`;
  imgEl.style.height = `${height}px`;

  const cached = staticThumbCache.get(page.id);
  if (cached) {
    if (imgEl.getAttribute("src") !== cached) imgEl.src = cached;
    return;
  }

  await queueThumbRender(async () => {
    // Another queued render for the same page may have landed first.
    const cachedNow = staticThumbCache.get(page.id);
    if (cachedNow) {
      if (imgEl.getAttribute("src") !== cachedNow) imgEl.src = cachedNow;
      return;
    }
    try {
      // `renderPageThumbnail(page, targetWidth, options)` — the second argument
      // is the preview width in CSS pixels, and the PDF asset has to be passed
      // through options so lazy annotated pages can still be previewed.
      const url = await renderPageThumbnail(page, STATIC_THUMB_WIDTH, {
        pdfAssetId: note?.pdfAssetId,
      });
      if (!url) return;
      staticThumbCache.set(page.id, url);
      while (staticThumbCache.size > 24) {
        const oldest = staticThumbCache.keys().next().value;
        staticThumbCache.delete(oldest);
      }
      imgEl.src = url;
    } catch {
      // A missing preview does not block scrolling; the wrapper keeps its box.
    }
  });
}

/**
 * Re-lays out every page box after the zoom changes. Wrappers always carry
 * their page's exact on-screen size so mounting or disposing an engine never
 * shifts the pages below it (which used to send programmatic scrolls to the
 * wrong page and flip the active page spuriously).
 */
function layoutStaticThumbnails() {
  const note = getActiveNote();
  if (!note) return;
  for (let i = 0; i < note.pages.length; i++) {
    const { width, height } = pageDisplaySize(note.pages[i]);
    const wrapEl = document.querySelector(`#page-wrapper-${i}`);
    if (wrapEl) {
      wrapEl.style.width = `${width}px`;
      wrapEl.style.height = `${height}px`;
    }
    const imgEl = document.querySelector(`#omni-thumb-${i}`);
    if (!imgEl || imgEl.hidden) continue;
    imgEl.style.width = `${width}px`;
    imgEl.style.height = `${height}px`;
  }
}

/**
 * Serializes sliding-window updates.
 *
 * The scroll observer can fire several times while a fast scroll is in flight,
 * and an update destroys and mounts engines asynchronously. Two overlapping
 * updates would both see the same empty slot and mount two engines onto one
 * canvas — leaking one of them and racing on the DOM. Chaining them means the
 * last one wins and every intermediate state is consistent.
 */
function scheduleEngineWindow(note) {
  const token = editorInitToken;
  engineWindowChain = engineWindowChain
    .then(() => {
      // A queued update belongs to the view that scheduled it. Once a newer
      // render has taken over, running it would mount the old notebook's
      // engines onto the new notebook's canvases.
      if (token !== editorInitToken) return;
      return updateEngineWindow(note);
    })
    .catch(() => {});
  return engineWindowChain;
}

/**
 * Recomputes which pages should have a live engine after the visible page
 * changes. Pages entering the window are mounted; pages leaving it are saved,
 * destroyed, and replaced by a static thumbnail.
 */
async function updateEngineWindow(note) {
  const token = editorInitToken;
  const liveIndexes = windowIndexes(note);

  // Save and tear down the pages that just left the window. Each engine saves
  // onto its own page record, so this is correct even mid-reorder.
  for (let i = 0; i < note.pages.length; i++) {
    const engine = canvasEngines[i];
    if (!engine || liveIndexes.has(i)) continue;
    // Keep undo/redo history alive while the engine is off-screen.
    if (engine.page) {
      const historyId = engine.page.id;
      pageHistoryCache.delete(historyId);
      pageHistoryCache.set(historyId, engine.getHistoryState());
      while (pageHistoryCache.size > PAGE_HISTORY_CACHE_LIMIT) {
        const oldest = pageHistoryCache.keys().next().value;
        pageHistoryCache.delete(oldest);
      }
    }
    saveEngineToPage(engine);
    engine.destroy();
    canvasEngines[i] = null;
  }

  let needsSave = false;

  for (let i = 0; i < note.pages.length; i++) {
    const page = note.pages[i];
    const canvasEl = document.querySelector(`#omni-canvas-${i}`);
    const thumbEl = document.querySelector(`#omni-thumb-${i}`);
    if (!canvasEl || !thumbEl) continue;

    if (!liveIndexes.has(i)) {
      canvasEl.hidden = true;
      thumbEl.hidden = false;
      setStaticPageThumbnail(thumbEl, page, note);
      continue;
    }

    if (!canvasEngines[i]) {
      let mounted = null;
      try {
        mounted = await createPageEngine(canvasEl, page, note, i);
      } catch (err) {
        // One poison page must never abort the whole window update and leave
        // every page after it without an engine. The thumbnail stays visible
        // for this page; the next window update retries the mount.
        console.error(`Could not mount page ${i}:`, err);
        recordMountError(i, err);
      }
      if (!mounted) continue;
      if (token !== editorInitToken) {
        mounted.engine.destroy();
        return;
      }
      canvasEngines[i] = mounted.engine;
      if (mounted.clearedPending) needsSave = true;
    }

    canvasEl.hidden = false;
    thumbEl.hidden = true;
    thumbEl.removeAttribute("src");
  }

  if (needsSave) saveActiveCanvasPage();
}

let saveTimer = null;

function setSaveStatus(text) {
  const el = document.querySelector("#save-status");
  if (el) el.textContent = text;
}

/** Coalesces rapid saves (e.g. while dragging) without losing the final state. */
function scheduleSaveNotes() {
  if (saveTimer) return;
  setSaveStatus("Saving…");
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const ok = saveNotes();
    setSaveStatus(ok === false ? "Save failed" : "Saved");
  }, 400);
}

/** Forces any pending debounced save to land immediately. */
function flushSaveNotes() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  setSaveStatus("Saving…");
  const ok = saveNotes();
  setSaveStatus(ok === false ? "Save failed" : "Saved");
}

function saveActiveCanvasPage({ immediate = true } = {}) {
  const note = getActiveNote();
  if (!note) return;

  const scrollContainer = document.querySelector("#canvas-scroll-container");
  if (scrollContainer) note.scrollPosition = scrollContainer.scrollTop;

  const hadDirty = canvasEngines.some((engine) => engine && engine.dirty);
  for (const engine of canvasEngines) {
    if (engine && engine.dirty) saveEngineToPage(engine);
  }

  if (!hadDirty && !immediate) return;

  if (immediate) {
    setSaveStatus("Saving…");
    const ok = saveNotes();
    setSaveStatus(ok === false ? "Save failed" : "Saved");
  } else {
    scheduleSaveNotes();
  }
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
  if (!note || !page) return;

  try {
    // Render from the page record rather than from a live engine. With the
    // sliding window, page 0 often has no engine while the user edits a later
    // page, and an engine-indexed read silently stops updating the card.
    const dataUrl = await renderPageThumbnail(page, 320, {
      pdfAssetId: note.pdfAssetId,
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

  // Surface unexpected errors instead of failing silently.
  window.addEventListener("error", (e) => {
    console.error("Unhandled error:", e.error || e.message);
  });
  window.addEventListener("unhandledrejection", (e) => {
    console.error("Unhandled promise rejection:", e.reason);
  });

  // Last chance to land a payload write. `pagehide` covers close/navigate;
  // `visibilitychange` covers mobile backgrounding, where `pagehide` may never
  // arrive while the process is still alive to finish the transaction.
  window.addEventListener("pagehide", () => {
    flushSaveNotes();
    snapshotNotes();
    flushPayloads();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushSaveNotes();
      flushPayloads();
    }
  });


  // Every page's object graph lives in IndexedDB, so the first render has to
  // wait for it — rendering early would show blank imported pages.

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
    ?.addEventListener("click", () => zoomWindowNextLine());
  document.querySelector("#zw-right")?.addEventListener("click", () => {
    zoomWindowNudge(1);
  });
  document.querySelector("#zw-left")?.addEventListener("click", () => {
    zoomWindowNudge(-1);
  });

  // Alt/Option + click on the page drops the zoom window's target box there.
  document
    .querySelector("#canvas-scroll-container")
    ?.addEventListener("click", (e) => {
      if (e.altKey) zoomWindowMoveTo(e.clientX, e.clientY);
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
    else updateZoomUI(getCurrentZoom());
  };
  zoomValue?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitZoomValue();
      zoomValue.blur();
    } else if (e.key === "Escape") {
      updateZoomUI(getCurrentZoom());
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
      pendingImportData: null,
      importSchemaVersion: 1,
      fallbackVisible: true,
      importReport: null,
      editMode: "notes",
      conversionState: "idle",
      decomposedObjects: true,
      tags: [],
    };
    normalizedNotes.delete(note);
    note.pages.splice(note.currentPageIndex + 1, 0, newPage);
    note.currentPageIndex++;
    saveNotes();
    render();
  });

  document
    .querySelector("#delete-page-btn")
    ?.addEventListener("click", async () => {
      if (note.pages.length <= 1) return;
      if (await showConfirm(`Delete Page ${note.currentPageIndex + 1}?`, "Delete", "Cancel")) {
        // Flush first: the page's asset ids are collected from its record right
        // after the splice, and unsaved edits would leave their assets behind.
        saveActiveCanvasPage();
        normalizedNotes.delete(note);
        const [removed] = note.pages.splice(note.currentPageIndex, 1);
        forgetPageCaches(removed);
        // Copied pages (and extracted notebooks) can share image assets with the
        // page being deleted, so the "still used" set must cover every notebook.
        const stillUsed = new Set();
        for (const otherNote of notes) {
          for (const p of otherNote.pages || []) {
            if (otherNote === note && p === removed) continue;
            for (const id of await collectPageAssetIdsDeep(p)) stillUsed.add(id);
          }
        }
        await deleteAssets(
          (await collectPageAssetIdsDeep(removed)).filter(
            (id) => id && !stillUsed.has(id),
          ),
        );
        if (note.currentPageIndex >= note.pages.length) {
          note.currentPageIndex = note.pages.length - 1;
        }
        saveNotes();
        render();
      }
    });

  // Promotion ("Make editable"). Bound by delegation on the pill rather than on
  // the buttons, because the controls are repainted in place as page state
  // changes and re-binding individual listeners would go stale.
  document
    .querySelector(".floating-status-pill")
    ?.addEventListener("click", (e) => {
      const promotePage = e.target.closest("[data-promote-page]");
      if (promotePage) {
        promotePageToEditable(Number(promotePage.dataset.promotePage));
        return;
      }
      if (e.target.closest("[data-promote-all]")) makeAllPagesEditable();
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
        page.pageSize = e.target.value;
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
        await hydrateNote(note);
        const pdfBytes = await exportNotebookToPdf(
          note,
          getActiveCanvasEngine(),
          (curr, total) => {
            loadingMessage = `Exporting page ${curr} of ${total}...`;
            renderLoading();
          },
        );
        const cleanTitle = (note.title || "OmniNote_Document").replace(/[/\\?%*:|"<>]/g, "-");
        await saveBytes(pdfBytes, `${cleanTitle}.pdf`, [
          { name: "PDF", extensions: ["pdf"] },
        ]);
      } catch (err) {
        showToast("Error exporting PDF", String(err?.message || err), "error");
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
      canvasEngines.forEach((e) => e?.setTool("select"));
      document
        .querySelectorAll("[data-tool]")
        .forEach((b) => b.classList.remove("selected"));
      document.querySelector('[data-tool="select"]')?.classList.add("selected");
    });
  });

  // Close menus on outside click. The handler is stored so it can be removed
  // before a new render adds another — otherwise every render leaks a duplicate.
  if (outsideClickHandler) {
    document.removeEventListener("click", outsideClickHandler);
  }
  outsideClickHandler = (e) => {
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
  };
  document.addEventListener("click", outsideClickHandler);

  document.querySelector("#rename-btn")?.addEventListener("click", async () => {
    const newTitle = await showPrompt("Notebook title:", note.title);
    if (newTitle && newTitle.trim()) {
      note.title = newTitle.trim();
      saveNotes();
      const titleSpan = document.querySelector("#rename-btn span");
      if (titleSpan) titleSpan.textContent = note.title;
    }
  });

  document
    .querySelector("#delete-notebook-btn")
    ?.addEventListener("click", async () => {
      if (await showConfirm(`Are you sure you want to delete "${note.title}"?`, "Delete", "Cancel")) {
        notes = notes.filter((n) => n.id !== note.id);
        activeId = null;
        saveNotes();
        render();
      }
    });

  // Tool Selection
  document.querySelectorAll("[data-tool]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setActiveTool(btn.dataset.tool);
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
      canvasEngines.forEach((e) => e?.setPenStyle(currentPenStyle));

      // Also switch to pen tool
      currentTool = "pen";
      canvasEngines.forEach((e) => e?.setTool("pen"));
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
      canvasEngines.forEach((e) => e?.setWidth(currentWidth));
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
    canvasEngines.forEach((eng) => eng?.setColor(hex));
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
        canvasEngines.forEach((e) => e?.setTool("select"));
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
    if (isPageManagerOpen()) closePageManager();
    else openPageManager();
  });
  bindPageManagerControls();
  bindPageManagerGrid();

  // The previous render's handler must go before this one is added: without
  // this, every render stacks another window-level listener and one Cmd+Z
  // fires undo N times.
  if (editorKeyHandler) {
    window.removeEventListener("keydown", editorKeyHandler);
  }
  editorKeyHandler = editorShortcuts.onKeyDown;
  window.addEventListener("keydown", editorKeyHandler);
}

// Dev-only inspection hook for the browser regression harness. Vite replaces
// `import.meta.env.DEV` with `false` in a production build, so this whole
// block is dead code there and is dropped by the minifier.
if (import.meta.env.DEV) {
  window.__omni = {
    getNotes: () => notes,
    getActiveId: () => activeId,
    getEngines: () => canvasEngines,
    /** IndexedDB payload writes still in flight; tests drain these before a reload. */
    pendingWrites,
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

async function initApp() {
  let loaded = loadNotes();
  if (!loaded || !loaded.length) {
    const restored = await restoreFromSnapshot();
    loaded = restored && restored.length ? restored : [normalizeNote(sampleNote)];
  }
  notes = loaded;
  activeId = notes[0]?.id || null;
  lastRenderedNoteId = null;

  try {
    await hydrateNotes();
  } catch (err) {
    console.warn("Could not restore page data:", err);
  }

  render();
  // Silent daily update check (Mac app only; no-op in a browser).
  autoCheckForUpdates();
  scheduleSnapshot();
}

initApp();
