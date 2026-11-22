# OmniNote — Architecture Reference

Companion to `README.md`. The README is the **product spec** (what and why); this
file is the **code map** (where and how).

---

## 1. Purpose

OmniNote is a local-first desktop application (built with Tauri v2 and Rust) as well as a web notebook app for macOS. Its reason to
exist is migration: you export a notebook from Goodnotes/Notability as a PDF,
import it here, and the page keeps its appearance while OmniNote tries to recover
the content as editable objects instead of a dead bitmap.

Three import levels are defined in the README:

| Level | Meaning | Status |
|---|---|---|
| A | Page rendered as a locked background you can write over | Implemented |
| B | PDF content recovered as editable text / paths / images | Implemented (`decomposer.js`) |
| C | OCR / vision reconstruction of flattened scans | Out of scope for v1 |

Everything else — no accounts, no sync, no AI, no template marketplace — is
explicitly out of scope per the README.

---

## 2. Technology stack

| Layer | Choice | Notes |
|---|---|---|
| Build | Vite (`npm run dev` / `build` / `preview`) | `vite.config.js` splits `fabric`, `pdfjs`, `pdflib` into separate vendor chunks |
| Desktop App | Tauri v2 (`src-tauri/`) | Rust-based desktop shell for macOS / cross-platform |
| Language | Vanilla ES modules, modular UI & CSS | ~11.9k LOC JS, ~2.3k LOC CSS across component sheets |
| Canvas | `fabric` v7 | Owns the object graph, hit-testing, free-drawing brush, text editing |
| PDF decode | `pdfjs-dist` v6 | Operator-list parsing (Level B) and page rasterization |
| PDF write | `pdf-lib` | Export: each page is rasterized and embedded as one image |
| Test suite | Playwright Core (`npm test`) | Self-contained regression harness (`tests/run.mjs`, specs) |
| Linter | ESLint (`npm run lint`) | Browser & Node global validation via `eslint.config.js` |

---

## 3. Repository map

```text
index.html                  16    single <main id="app"> + module script
vite.config.js              32    manual vendor chunks for fabric, pdfjs, pdflib
eslint.config.js            61    ESLint flat config for src, scripts, and tests
jsconfig.json               10    module resolution & editor IntelliSense config
src/main.js               2373    app shell, state, view orchestration, event binding
src/updater.js             212    Tauri update checks and install flow
src/app/
  persistence.js           440    localStorage record, IndexedDB payload cache, hydration
  importFlow.js            641    PDF import, page promotion, blob persistence
  editorShortcuts.js       173    global keyboard shortcuts and typing-target guard
  backup.js                245    whole-library backup and restore (assets inlined)
  pageManager.js           880    Page Manager: reorder, rotate, extract, tag, copy/cut/paste
  libraryEvents.js         460    library screen events: cards, folders, search, bulk actions
src/ui/
  icons.js                  52    SVG icon lookup table (~30 crisp vector icons)
  libraryView.js           261    library grid, sidebar, note card, font options
  pageManagerView.js        76    page manager modal overlay & tile generator
  dialogs.js               601    import report, toasts, confirms, storage warnings
  escapeHtml.js             16    HTML sanitization utility
  toolbar.js               105    font toolbar state sync and option rendering
src/styles/
  base.css                  55    variables (:root), reset, body, input styling
  library.css              534    shell grid, sidebar, cards, card hover actions
  editor.css               828    topbar, tool rail, presets, swatches, status pill
  canvas.css               193    viewport container, zoom window, paper textures
  dialogs.css              437    loading overlay, spinner, toasts, alerts
  pageManager.css          235    page manager modal overlay & grid layout
src/style.css                6    root stylesheet aggregator importing src/styles/
src/canvas/
  engine.js               1827    OmniCanvas: tools, undo/redo, zoom/pan, background
  viewport.js              417    viewport controller: zoom math, anchors, gestures, window
  zoomWindow.js            351    magnified writing strip (mirrors live canvas)
  canvasBlob.js             52    canvas to WebP/PNG blob conversion utilities
src/pdf/
  decomposer.js           1444    Level-B: PDF operator stream -> editable objects
  exporter.js              394    PDF export + page thumbnails
  grouping.js              410    spatial clustering of strokes into coherent ink groups
  importModel.js           360    decomposed object normalization & fallback layer
  raster.js                107    on-demand re-raster of the source PDF at zoom
src/storage/assets.js      287    IndexedDB blob store with deep graph traversal
tests/
  run.mjs                  122    regression test runner (boots Vite & browser)
  lib/harness.mjs          420    Playwright test driver and evaluation helpers
  specs/                         7 browser regression specs: import, persistence,
                                 annotate, picker, editorSelect, slidingWindow,
                                 darkThumbs
  unit/                          4 Vitest suites: viewport, grouping, importModel,
                                 eraser
scripts/
  make-fixtures.mjs        561    byte-deterministic PDF fixture generator
  install-mac.sh            42    macOS install helper
  fix-macos.sh              32    macOS launch/quarantine helper
  dev/                            manual PDF probes (not part of the test suite)
src-tauri/                        Tauri 2 desktop wrapper configuration & Rust source
.github/workflows/                CI (lint, unit, build) and release pipeline
README.md                   87    product spec (authoritative for scope)
MEMORY_OPTIMIZATION.md     193    sliding-window memory notes
```

---

## 4. Module responsibilities

### `src/main.js` — the application shell

Holds the live application state and orchestrates views and event listeners.
The format and import pipelines live in `src/app/` and receive that state
through injected getters, so `main.js` stays the composition root:

* **State**: module-level variables — `notes`, `activeId`, `canvasEngines`,
  `currentTool/Color/Width/PenStyle`, `currentZoom`, `showPageManager`,
  `pageManagerSelection`, `pageClipboard`, `zoomLocked`, `normalizedNotes`,
  `hydratedPages`, …
* **Views**: delegates HTML template generation to `src/ui/libraryView.js` and
  `src/ui/pageManagerView.js`. `render()` updates `#app.innerHTML` and wires
  event handlers.
* **Orchestration**: `initEditor(note)` creates one `OmniCanvas` per page,
  loads each page, wires callbacks, sets up the IntersectionObserver and the
  zoom window.
* **Composition**: constructs the persistence, import-flow, shortcut,
  backup, page-manager and library-event controllers once, passing live
  getters and the callbacks they may call back into (`saveNotes`, `render`,
  `setLoading`, …).

### `src/app/persistence.js` — notebook record & payload cache

Owns the storage format, not the data. `createPersistence()` closes over the
caller's notebook array and the two WeakSets:

* **Record**: `normalizeNote()` backfills legacy fields; `projectNotesForStorage()`
  strips the object graph and import handoff before the localStorage write.
* **Payloads**: `persistPayload()` de-duplicates IndexedDB writes by key, while
  `inFlightPayloads` tracks unsettled writes so `flushPayloads()` can drain them
  on `pagehide`/`visibilitychange`.
* **Hydration**: `hydratePage()` lazily loads a page's `canvasJson` and pending
  import handoff; `hydrateNote()` loads the pages around the current one.
* **Quota fallback**: `saveNotes()` retries with thumbnails stripped and raises
  the storage warning if that still fails.

### `src/app/importFlow.js` — PDF in, editable pages out

`createImportFlow()` owns the pipeline from `File` to notebook, and from an
annotate-mode raster to native objects:

* **Import**: `handlePdfImport()` reads the mode once, then routes to
  `importPdfFile()` or the choose-pages picker. `importPdfFile()` decomposes
  page-by-page, persists blobs as each page arrives, and commits the notebook
  only after every page succeeds.
* **Promotion** (§10): `rebuildPageAsEditable()` captures the user's ink, swaps
  the raster for recovered objects, and re-applies the ink.
  `promotePageToEditable()` does one page; `makeAllPagesEditable()` batches the
  rest as lazy handoffs.
* **Shared asset path**: `persistPageAssets()` is used by both import and
  promotion, so a promoted page has exactly the shape an import produces.

### `src/app/editorShortcuts.js` — global keyboard handler

`createEditorShortcuts()` returns the single window-level `keydown` handler:
tool keys (V/P/H/E/T), undo/redo, copy/paste, delete, zoom, `?` for help, and
Escape while the Page Manager is open. It bails out via `isTypingTarget()` so
form fields keep their keys — notably macOS's `Backspace`-labelled Delete key.

### `src/app/backup.js` — whole-library backup and restore

`createBackup()` exports `backupAllNotes`, `restoreFromBackup` and `saveBytes`.
A backup is self-contained: every notebook, folder, colour and IndexedDB blob
is inlined into one JSON file. Restore replaces the library atomically and
only then deletes the assets the old library owned.

### `src/app/pageManager.js` — the Page Manager

`createPageManager()` owns the Noteful-style selection grid and its transient
state (open/closed, selection, drag, clipboard, thumbnails, zoom to restore).
It reorders, rotates, extracts, tags, copies, cuts, pastes, deletes, exports
and promotes pages, mounting temporary engines for pages outside the sliding
window.

### `src/app/libraryEvents.js` — library screen events

`createLibraryEvents()` wires cards, sidebar folders, pin/restore/trash
actions, search, bulk selection, backup/restore and PDF import. Library view
state stays in the shell; this module mutates it through injected
getters/setters.

### `src/ui/toolbar.js` — editor font toolbar

`createToolbar()` exposes `renderFontOptions`, `updateFontToolbarState` and
`syncToolbarForActivePage`, keeping font-control DOM sync out of the shell.

### `src/ui/` — modular UI templates & components

Decoupled view generators that produce clean HTML strings:

* **`icons.js`**: `icon(name, size = 18)` returns SVG markup for ~30 toolbar and control icons.
* **`libraryView.js`**: `libraryView()`, `sidebar()`, `noteCard()`, and `renderFontOptions()`.
* **`pageManagerView.js`**: `pageManagerOverlay()` and `pageManagerTilesHtml()` grid generator.
* **`dialogs.js`**: `showImportReport()` (import completion toast), `showToast()` (generic action toast), `showStorageWarning()`, and `clearStorageWarning()`.
* **`escapeHtml.js`**: utility for escaping untrusted string content in templates.

### `src/styles/` — component stylesheets

CSS broken down by area, aggregated by `src/style.css`:

* **`base.css`**: `:root` variables, reset, body layout, input styles.
* **`library.css`**: App shell, sidebar, note card grid, folder selectors, card hover actions.
* **`editor.css`**: Topbar, tool rail, thickness presets, color swatches, status pill, popovers.
* **`canvas.css`**: Viewport container, zoom window writing strip, paper textures (`.paper-*`).
* **`dialogs.css`**: Loading overlay, spinner, import report toasts, storage warnings.
* **`pageManager.css`**: Page manager modal overlay, thumbnail grid, drag-drop drop markers.

### `src/canvas/engine.js` — `OmniCanvas`

One instance per page. Wraps a Fabric `Canvas` and owns:

* **Tools** (`setTool`): select, pen (4 pen styles), marker/highlighter, eraser,
  text, plus shape insertion. Pen and marker switch Fabric into
  `isDrawingMode` and configure `freeDrawingBrush`.
* **Undo/redo**: whole-canvas JSON snapshots, 35 deep, per engine.
* **Zoom/pan**: see §6.
* **The locked background**: `backgroundImage` is held *outside* the object
  graph so it is never serialized into undo history or into `canvasJson`.
* **`loadPage()` layering**: the saved graph (`canvasJson`) is restored first,
  then any import handoff (`pendingImportData`) is layered on top, and the locked
  raster is applied last. Both sources can be present at once — that is exactly a
  promoted page, whose own annotations live in the graph and whose recovered
  objects arrive through the handoff.
* **`addObjectsFromJson(objects)`**: re-enlivens previously serialized objects.
  Promotion reloads a page to bring in recovered objects, and this is how the
  annotations that were already on the canvas get put back.
* **`loadPage(page)`**: the fork between first import
  (`pendingDecomposedData` → build objects) and reopening (`canvasJson` → `loadFromJSON`).

### `src/canvas/canvasBlob.js` — canvas blob conversions

Helper routines converting off-screen canvases into WebP or PNG blobs for
storage and thumbnail rendering. Shared by the PDF rasterizer, the decomposer
and the importer.

### `src/pdf/decomposer.js` — Level B extraction

`decomposePdf(buffer, scale, onPage, { mode })` walks every page. `mode` is
`"editable"` (default: full extraction) or `"annotations"` (raster only — the
operator list is never parsed at all). Each page becomes a record carrying the
grouped `objects`, an `importReport`, a `fallbackVisible` decision, and the
`backgroundBlob` / `thumbnailBlob` pair.

* **Text**: `getTextContent()` items are grouped into lines by baseline
  proximity and font, fonts normalized through `normalizeFontFamily()`
  (strips `ABCDEF+` subset prefixes and style suffixes).
* **Paths**: the pdf.js **operator list** is interpreted with an explicit
  matrix stack (`save`/`restore`/`transform`), and sub-path commands are
  converted to SVG path data for Fabric `Path` objects.
* **Images**: `paintImageXObject` pulls the bitmap out of `page.objs` /
  `commonObjs` and converts it to a data URL.
* **Fallback**: each page is also rendered once at ≤1600px as a WebP
  background, plus a ≤320px thumbnail.
* `onPage` is called per page so the caller can push blobs straight into
  IndexedDB and drop the references — a 100-page import never holds 100
  backgrounds in memory.
* **`decomposeStoredPdfPage(assetId, pageIndex, scale)`** is the single-page
  entry point behind "Make editable" (§10). It obtains its page from
  `raster.js`'s cached document via `getPdfDoc` — never `pdfjs.getDocument` — so
  a notebook still has exactly one worker, one parse, and one cache that
  `invalidatePdfDoc` can clear. It returns the same record shape `decomposePdf`
  hands to `onPage`.

### `src/pdf/grouping.js` — ink grouping
Spatial clustering algorithms that analyze extracted vector paths and cluster them into logical, selectable stroke groups based on proximity and stroke properties.

### `src/pdf/importModel.js` — import normalization
Normalizes extracted objects, validates schema versions, and composes page-sized fallback image layers when full object extraction is partial or lossy.

### `src/pdf/raster.js` — crisp zoom for imported pages

The import snapshot is only ~1600px, so zooming in would magnify a bitmap.
This module keeps the parsed `PDFDocumentProxy` in a `Map` and re-renders the
visible page with pdf.js at the current zoom (Google Drive behaviour): the
viewport transform is instant, sharper pixels arrive ~180 ms later.

`getPdfDoc(assetId)` is exported because this module is the **single owner** of
the pdf.js document: re-rasterization here and single-page promotion in
`decomposer.js` both go through it. A second opener would mean a second worker
and a cache that `invalidatePdfDoc` could no longer clear.

### `src/storage/assets.js` — IndexedDB blob store

Database `omninote-assets`, single object store `assets`. Binary data
(backgrounds, thumbnails, embedded images, source PDF) stored as Blobs;
only generated IDs are kept in localStorage.
* **Deep Asset Cleanup**: `collectNoteAssetIdsDeep`, `collectPageAssetIdsDeep`, and
  `collectAssetIdsFromGraph` inspect serialized Fabric object graphs to ensure embedded
  image blobs are never orphaned on delete while preserving shared assets across copies.

### `src/canvas/zoomWindow.js` — Noteful-style writing strip

A magnified strip docked at the bottom plus a target box on the page. It owns
**no content**: it is a `drawImage` crop of the live page canvas on a
`requestAnimationFrame` loop, and pointer input on the strip is re-dispatched
onto the page canvas as synthetic `mouse*`/`pointer*` events. Undo/redo,
persistence and every tool therefore keep working unchanged.

### `src/pdf/exporter.js` — PDF out

For each page: draw the imported background (or paper pattern), then rasterize
the Fabric content on top at 2×, then embed as JPEG (photographic) or PNG (line
art) at `px × 0.75 = pt`. `renderPageThumbnail()` is the same pipeline at 320px
for the Page Manager grid.

---

## 5. Data model

Persisted as one JSON array under `localStorage["omninote-notes-v2"]`.

```text
Notebook
  id, title, createdAt, isPdf, pdfAssetId, currentPageIndex,
  defaultFont, detectedFonts[]
  └── pages[]
        id, pageNumber, pdfPageIndex,
        width, height, paperStyle, pageSize,
        backgroundAssetId, thumbnailAssetId,        → IndexedDB
        canvasJson: { width, height, paperStyle, canvasData },
        pendingImportData,                           → consumed on first load
        importReport, fallbackVisible, fallbackFromImage,
        editMode: "annotate" | "notes",              → §10
        conversionState: "idle" | "converting" | "failed",
        decomposedObjects, importSchemaVersion, tags[]
```

`editMode` says which document owns the page. An imported page starts as
`"annotate"` — a locked raster with nothing selectable — and becomes `"notes"`
once its content has been rebuilt as native objects, either at import
(`editable` mode) or later per page (`Make editable`, §10). A page that never
came from a PDF is always `"notes"`. `conversionState` is transient except for
`"failed"`, which records a page whose content turned out to be unrecoverable so
the UI can explain rather than silently retry.

Page sizes: a4 800×1130, letter 800×1035, slide 1200×675, square 800×800.
Imported pages keep the PDF's own dimensions at 96 DPI (`scale = 1.3333`).

`normalizeNote()` (in `src/app/persistence.js`) runs on every read and backfills
missing fields, drops legacy inline dataURLs, and derives `detectedFonts` — it is
the de-facto migration layer, invoked from `loadNotes()` and from
`getActiveNote()` on all ~21 call sites.

---

## 6. Data flow

### Import

```text
file.pdf + mode ("editable" | "annotations")
  → decomposePdf(buffer, scale, onPage, { mode })
      → per page: text / paths / images  +  WebP background + thumbnail
        ("annotations" skips extraction entirely — raster + thumbnail only)
      → onPage(): persistPageAssets() → putAsset() blobs to IndexedDB, ids only
  → putAsset(pdfAssetId, file)        (source kept for crisp re-raster)
  → new Notebook{ pages[] } pushed to `notes`, saveNotes(), render()
```

### First open of an imported page

```text
loadPage(page)
  → canvasJson?        → hydrateCanvasJson() → loadFromJSON()   (the page's own content)
  → pendingImportData? → loadImportObjects() → IText / Path / group / FabricImage
  → fallbackVisible && backgroundAssetId?
        yes → loadBackgroundAsset() as the locked raster
        no  → backgroundImage = null
  → applyTransform() → _scheduleBackgroundRaster(0) → history reset
  → initEditor() clears the one-shot handoff once the page has loaded
```

### Promote one page to native objects ("Make editable")

```text
promotePageToEditable(index)
  → ink = engine.serialize().objects        (the user's own content, captured first)
  → decomposeStoredPdfPage(pdfAssetId, pdfPageIndex)   (reuses the cached document)
  → nothing recovered?  → conversionState = "failed"; the page stays annotate
  → persistPageAssets() → new background / thumbnail / embedded-image ids
  → page.pendingImportData = { objects, report }
  → engine.loadPage(page)                   (the raster is replaced by objects)
  → engine.addObjectsFromJson(ink)          (the annotations go back on top)
  → pendingImportData = null; canvasJson = engine.toJSON(); editMode = "notes"
  → the old raster is deleted unless a page copy still shares that asset
```

Batch (`makeAllPagesEditable`) runs the same extraction for the remaining pages
but with `instantiate: false` for every page except the one on screen: the
objects materialise when a page is next opened, so a long notebook is never
stalled by instantiating pages nobody is looking at.

### Edit → save

```text
pointer/fabric event
  → OmniCanvas events (object:added / modified / path:created)
  → recordHistory()  (JSON snapshot)
  → onModified → saveActiveCanvasPage()
        → engine.toJSON() into page.canvasJson for every page
        → saveNotes()  (synchronous JSON.stringify of all notebooks)
        → scheduleThumbnailRefresh()  (600 ms debounce)
```

### Zoom

```text
slider / pinch / shortcut / fit
  → setZoom() in main.js            (single funnel: lock, clamp, UI sync, anchor)
      → engine.setZoom() for every engine
      → applyTransform(): viewportTransform + backing-store resize
      → _scheduleBackgroundRaster(180 ms) → raster.js re-renders the PDF page
```

A pinch is treated as **one** gesture: deltas accumulate into percentage points
(0.35 pp/px), coalesce into one `requestAnimationFrame`, apply as a cheap
CSS-only scale (`preview`), and re-render at full resolution on release.

---

## 7. Patterns and conventions

* **String-template UI.** Views are template literals; `render()` replaces
  `#app.innerHTML` and rebinds. Fast to write, but it destroys scroll position,
  focus, and any in-flight DOM state.
* **Engine-per-page, index-parallel arrays.** `canvasEngines[i]` corresponds to
  `note.pages[i]`. Selection, thumbnails, and `currentPageIndex` are remapped
  together by `remapIndexForMove()` on reorder.
* **Callbacks down, no events up.** `main.js` passes `onModified`,
  `onHistoryChange`, `onSelectionChange`, `onZoomChange`, `onZoomRequest`,
  `onZoomStart/End` into each engine.
* **Binary never in `localStorage`.** Blobs go to IndexedDB; only ids are
  persisted. `saveNotes()` strips thumbnails if the quota is exceeded.
* **Document coordinates are sacred.** Zoom, pan, dpr and device pixels never
  enter persisted data; `toJSON()` writes `this.width/height` (the page), not
  the scaled canvas.
* **Defensive parsing.** The decomposer wraps the *loop body* in try/catch so
  one malformed PDF operator cannot kill the rest of the page.
* **Locked fallback layer.** The imported raster is held off the object graph
  (`selectable: false, evented: false`) so the eraser and selection can never
  damage it.

---

## 8. Hard-won gotchas (do not regress)

* **pdf.js 6 `constructPath`** args are `[paintOp, drawOps, minMax?]`; sub-ops
  use the DrawOPS enum (moveTo 0 … closePath 4), **not** `OPS.*`. The command
  buffer is sometimes a `Float32Array` wrapped in an array — unwrap one level.
* `multiplyTransform(m1, m2)` is `m1 × m2`; PDF `cm` needs
  `multiplyTransform(args, currentMatrix)` in that order, or translations get
  scaled and images fly off the page.
* Colour ops deliver one CSS string in `args[0]` on pdf.js ≥ 5 — always go
  through `readPdfColor()`, never `rgbToHex(a[0], a[1], a[2])`.
* `.canvas-wrap` has `scroll-behavior: smooth`; set
  `style.scrollBehavior = "auto"` before any programmatic scroll, or reading
  the offset back returns the pre-animation value.
* Zoom anchors are stored as **fractions** of the page box, never pixels.
* Global keyboard handlers must bail out through `isTypingTarget(e.target)` —
  on macOS the key labelled Delete reports `e.key === "Backspace"`.
* **Vite's default host is `localhost`, which resolves to `::1` on a dual-stack
  machine.** The server then binds IPv6 only, and `http://127.0.0.1:<port>` is
  refused — which looks exactly like a crashed app. `tests/run.mjs` names
  `host: "127.0.0.1"` so the URL it hands the browser is the address the server
  actually holds. (This is why the suite failed with `ERR_CONNECTION_REFUSED`
  after having passed the day before.)
* **Asset ids are shared by design.** A copied page (Page Manager copy/extract)
  shares its source's `backgroundAssetId` and image ids, so code that replaces a
  page's assets must allocate a new id rather than overwrite in place, and must
  check `isBackgroundAssetShared()` before deleting the old one.

---

## 9. Known defects / debt

1. [RESOLVED] **One live Fabric engine per page.** `initEditor` now mounts only
   the current page plus one neighbour on each side (see `windowIndexes`); pages
   outside the window render as a static thumbnail. `isActivePage` is retained
   for render-scale bookkeeping only.
2. [RESOLVED] **Unload write safety & in-flight tracking.** `inFlightPayloads`
   (in `src/app/persistence.js`) tracks every asynchronous IndexedDB write,
   drained on `pagehide` and `visibilitychange` (`flushPayloads()`). Deep asset
   collection ensures no orphaned blobs on delete.
3. **Undo is full-canvas snapshots** (35 deep, per engine) rather than commands.
4. **Eraser uses a bounding-box hit test** (`performErase`) — no partial erase.
5. [RESOLVED] **Page Manager icons.** Glyphs for `copy`, `cut`, `paste`, and `tag`
   are implemented in `src/ui/icons.js`.
6. `document.addEventListener("click", …)` is re-bound on every `render()`
   (inside `bindEditorEvents`) and the IntersectionObserver is never
   disconnected — both accumulate across renders.
7. [RESOLVED] **Regression tests & linter.** Self-contained Playwright test suite
   under `tests/` (`npm test`) and ESLint validation (`npm run lint`).
8. Export is **raster-only** — the output PDF is not searchable and does not
   contain recovered text.
9. `render()` always resets `currentZoom = 1`; `zoomRestoreTarget` exists
   specifically to survive Page Manager round-trips.
10. [RESOLVED] **Unused dependency dropped.** `perfect-freehand` was uninstalled
    from `package.json`.

---

## 10. PDF page modes: Annotations vs Notes

### Status: implemented (2026-09-16)

Import-time mode choice, per-page promotion, and batch promotion all ship.
`tests/specs/annotate.spec.mjs` covers them (22 checks), falsified by stashing
`src/`.

### The model

Two persisted fields per page, plus the legacy `decomposedObjects` flag so older
notebooks keep opening. `normalizeNote()` backfills all three additively.

```text
page.editMode          = "annotate" | "notes"
page.conversionState   = "idle" | "converting" | "failed"
page.decomposedObjects = boolean            (compatibility flag)
```

* **annotate** — the locked `backgroundAssetId` raster for instant paint, plus
  `renderPdfPageBlob` for sharpness at any zoom. No native objects at all, so
  nothing is selectable; pen, highlighter, shapes and text work on top unchanged.
* **notes** — native objects, produced either at import (`editable` mode) or by
  promoting a single page with `decomposeStoredPdfPage()`.

The mode is chosen in the library (`#import-mode`) and read once, before any
`await`, so a change mid-import cannot produce a half-and-half notebook.

### Where the code lives

| Concern | Location |
|---|---|
| Mode read + notebook construction | `app/importFlow.js` `handlePdfImport()`, `importPdfFile()` |
| Raster-only page record | `decomposer.js` `decomposePdf({ mode: "annotations" })` |
| Single-page extraction | `decomposer.js` `decomposeStoredPdfPage()` |
| Blob persistence (shared with import) | `app/importFlow.js` `persistPageAssets()` |
| Promotion and batch | `app/importFlow.js` `promotePageToEditable()`, `makeAllPagesEditable()` |
| Page layering | `engine.js` `loadPage()`, `addObjectsFromJson()` |
| Controls | `app/importFlow.js` `promoteControlsHtml()`, in the floating status pill |

### Decisions, and how they landed

1. **A lightweight import must still learn real page dimensions.** *Resolved
   without the planned probe.* The design called for a `getPdfPageInfo(assetId)`
   reading `getPage()` + `getViewport()` with no operator parse. It turned out to
   be unnecessary: annotate mode already calls `decomposePage(…, {extract:false})`,
   which skips `getOperatorList()` entirely and still reports exact `width`/`height`
   alongside the raster it must render anyway. The probe would have duplicated that
   for no saving, so it was dropped rather than left as dead code.
2. **One pdf.js document, one owner.** `getPdfDoc` is exported from `raster.js`
   and `decomposeStoredPdfPage` imports it; it never calls `pdfjs.getDocument`
   itself. A notebook therefore still has one worker, one parse, and one cache
   that `invalidatePdfDoc` can clear.
3. **Annotation preservation on promote.** The user's own content is captured with
   `engine.serialize()` *before* anything touches the canvas, and re-applied
   through `addObjectsFromJson()` after the reload. The suite asserts a
   pre-promotion stroke is still present — and still present again after a reopen.
4. **Lossy-extraction guard.** If a page yields no objects — a scan, a flattened
   export — promotion leaves it in `annotate`, sets `conversionState = "failed"`,
   and says why in a toast. A good raster is never replaced by an empty page.
   `setBackgroundVisible()` remains the documented "show original" escape hatch
   and still has no UI of its own; the source PDF is kept forever, so the raster
   can always be restored.
5. **Batch "make all editable".** Batch extracts only. Every page except the one
   on screen is left with a `pendingImportData` handoff and no instantiation,
   because instantiation is already lazy in `loadPage`. Sequential, so a long
   notebook stays responsive; opt-in, never the default.
6. **Export is still raster-only.** Untouched by this work — see defect 8 in §9.
   An annotate-aware export (copy the source page through untouched, draw only a
   transparent annotation layer on top) remains outstanding.

### One-shot handoff, two layers

`loadPage()` restores `canvasJson` first and layers `pendingImportData` on top.
Both can be present at once, and that is precisely a promoted page: its own
annotations live in the graph, the recovered objects arrive through the handoff.
`promotePageToEditable()` serializes the live canvas straight away and clears the
handoff, so a later open cannot prefer the handoff and drop the restored ink.

### Explicitly out of scope here

The O(n) engine-per-page defect (`initEditor` loops every page) is a separate
change, tracked in `MEMORY_OPTIMIZATION.md`. `isActivePage` limits *raster
quality* for distant pages, not the number of live Fabric engines.

---

## 11. Verification

Release gates:

```bash
npm run lint        # ESLint over src, scripts, tests and configs
npm run test:unit   # Vitest: 56 checks across four unit suites
npm test            # Playwright: seven browser regression specs
npm run build       # Vite production bundle
```

CI (`.github/workflows/ci.yml`) runs lint, unit tests and the production build.
The browser suite is run locally (it needs a Chrome-family binary); see
`tests/run.mjs` for the `OMNI_BROWSER` / `OMNI_HEADED` switches. For the
authoritative commit history, use `git log`.
