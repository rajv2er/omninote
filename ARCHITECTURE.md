# OmniNote — Architecture Reference

Companion to `README.md`. The README is the **product spec** (what and why); this
file is the **code map** (where and how).

---

## 1. Purpose

OmniNote is a local-first, browser-only notebook app for macOS. Its reason to
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
| Build | Vite 8 (`npm run dev` / `build` / `preview`) | `vite.config.js` splits `fabric`, `pdfjs`, `pdflib` into separate chunks |
| Language | Vanilla ES modules, no framework, no TypeScript | ~7.6k LOC of JS, plus 1.6k LOC of CSS |
| Canvas | `fabric` v7 | Owns the object graph, hit-testing, free-drawing brush, text editing |
| PDF decode | `pdfjs-dist` v6 | Operator-list parsing (Level B) and page rasterization |
| PDF write | `pdf-lib` | Export: each page is rasterized and embedded as one image |
| Declared but unused | `perfect-freehand` | No import anywhere in `src/`; safe to drop |

There is no backend, no service worker, and no test runner in the repo.

---

## 3. Repository map

```text
index.html                 15    single <main id="app"> + module script
vite.config.js             22    manual chunks for the three big vendors
src/main.js              3185    app shell, state, both views, ALL event binding
src/canvas/engine.js     1278    OmniCanvas: tools, undo/redo, zoom/pan, background
src/canvas/zoomWindow.js  351    magnified writing strip (mirrors the live canvas)
src/pdf/decomposer.js     723    Level-B: PDF operator stream -> editable objects
src/pdf/exporter.js       217    PDF export + page thumbnails
src/pdf/raster.js         110    on-demand re-raster of the source PDF at zoom
src/storage/assets.js     144    IndexedDB blob store (backgrounds, thumbs, PDFs)
src/style.css            1681    dark shell + white paper, plain CSS
README.md                 352    product spec (authoritative for scope)
```

---

## 4. Module responsibilities

### `src/main.js` — the application shell

One module holds essentially all application state and every event listener.
There is no store abstraction and no component system.

* **State**: module-level `let` variables — `notes`, `activeId`, `canvasEngines`,
  `currentTool/Color/Width/PenStyle`, `currentZoom`, `showPageManager`,
  `pageManagerSelection`, `pageClipboard`, `zoomLocked`, …
* **Views**: `libraryView()` and `editorView(note)` return HTML strings.
  `render()` swaps `app.innerHTML` wholesale and then re-binds everything.
  There is no diffing; the DOM is rebuilt on every state change.
* **Orchestration**: `initEditor(note)` creates one `OmniCanvas` per page,
  loads each page, wires callbacks, sets up the IntersectionObserver and the
  zoom window.
* **Icon set**: `icon(name, size)` is an inline SVG lookup table (~30 icons).

### `src/canvas/engine.js` — `OmniCanvas`

One instance per page. Wraps a Fabric `Canvas` and owns:

* **Tools** (`setTool`): select, pen (4 pen styles), marker/highlighter, eraser,
  text, plus shape insertion. Pen and marker switch Fabric into
  `isDrawingMode` and configure `freeDrawingBrush`.
* **Undo/redo**: whole-canvas JSON snapshots, 35 deep, per engine.
* **Zoom/pan**: see §6.
* **The locked background**: `backgroundImage` is held *outside* the object
  graph so it is never serialized into undo history or into `canvasJson`.
* **`loadPage(page)`**: the fork between first import
  (`pendingDecomposedData` → build objects) and reopening (`canvasJson` → `loadFromJSON`).

### `src/pdf/decomposer.js` — Level B extraction

`decomposePdf(buffer, scale, onPage)` walks every page and returns
`{ textObjects, pathObjects, imageObjects, backgroundBlob, thumbnailBlob, fonts }`.

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

### `src/pdf/raster.js` — crisp zoom for imported pages

The import snapshot is only ~1600px, so zooming in would magnify a bitmap.
This module keeps the parsed `PDFDocumentProxy` in a `Map` and re-renders the
visible page with pdf.js at the current zoom (Google Drive behaviour): the
viewport transform is instant, sharper pixels arrive ~180 ms later.

### `src/storage/assets.js` — IndexedDB blob store

Database `omninote-assets`, single object store `assets`. Binary data is
(Backgrounds, thumbnails, embedded images, the source PDF) stored as Blobs;
only the generated id is persisted in `localStorage`. Object URLs are cached in
a `Map` so re-rendering the library does not reload blobs.

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
        pendingDecomposedData,                       → consumed on first load
        decomposedObjects, tags[]
```

Page sizes: a4 800×1130, letter 800×1035, slide 1200×675, square 800×800.
Imported pages keep the PDF's own dimensions at 96 DPI (`scale = 1.3333`).

`normalizeNote()` runs on every read and backfills missing fields, drops legacy
inline dataURLs, and derives `detectedFonts` — it is the de-facto migration
layer, invoked from `loadNotes()` and from `getActiveNote()` on all ~21 call sites.

---

## 6. Data flow

### Import

```text
file.pdf
  → decomposePdf(buffer)
      → per page: text / paths / images  +  WebP background + thumbnail
      → onPage(): putAsset() blobs → IndexedDB, return ids only
  → putAsset(pdfAssetId, file)        (source kept for crisp re-raster)
  → new Notebook{ pages[] } pushed to `notes`, saveNotes(), render()
```

### First open of an imported page

```text
loadPage(page)
  → pendingDecomposedData?
        yes → loadDecomposedPdf(): IText + Path + FabricImage objects
              if objects were produced → background hidden, decomposedObjects = true
              else                     → load the WebP fallback as locked background
        no  → loadFromJSON(page.canvasJson.canvasData)
  → delete page.pendingDecomposedData   (one-shot)
  → setPdfBackgroundSource({ assetId, pageIndex })
```

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

---

## 9. Known defects / debt

1. **One live Fabric engine per page.** `initEditor` instantiates an
   `OmniCanvas` for every page in the notebook, so memory is O(pages).
   `isActivePage` limits render *quality*, not engine count.
2. **`saveNotes()` is a full synchronous serialize of every notebook** on every
   edit. Only thumbnails are debounced. There is no `beforeunload` /
   `visibilitychange` flush.
3. **Undo is full-canvas snapshots** (35 deep, per engine) rather than commands.
4. **Eraser uses a bounding-box hit test** (`performErase`) — no partial erase.
5. `icon("copy" | "cut" | "paste" | "tag")` are **not defined** in the icon
   table, so those four Page Manager buttons render with no glyph (labels still
   show).
6. `document.addEventListener("click", …)` is re-bound on every `render()`
   (inside `bindEditorEvents`) and the IntersectionObserver is never
   disconnected — both accumulate across renders.
7. **No tests, no linter.** Playwright scripts live outside the repo.
8. Export is **raster-only** — the output PDF is not searchable and does not
   contain recovered text.
9. `render()` always resets `currentZoom = 1`; `zoomRestoreTarget` exists
   specifically to survive Page Manager round-trips.
10. `perfect-freehand` is a declared dependency with zero imports.

---

## 10. PDF page modes: Annotations vs Notes

### Where the code actually stands (verified 2026-09-10)

* Import is **eager**: `main.js:3069` runs `decomposePdf(buffer, 1.333333, onPage)`
  over the *whole document* before the notebook object exists (`main.js:3117`).
  Cost is O(pages) operator-list walks plus one background raster per page.
* The source PDF is **already retained** (`main.js:3113`), and `raster.js` already
  re-renders any page crisply at the current zoom — `renderPdfPageBlob`
  (`raster.js:70`), driven by `engine._rasterizeBackground` (`engine.js:1001`)
  and scheduled on zoom (`engine.js:992`).
* `setPdfBackgroundSource({ assetId, pageIndex })` is already wired for every
  imported page (`main.js:1952`).
* ⇒ **Annotations mode is roughly 80% built already.** The locked, crisp,
  on-demand PDF background exists. The missing piece is only *starting* a page in
  that state instead of decomposing everything up front.

### Proposed model

Two new persisted fields per page; `decomposedObjects` survives as an internal
compatibility flag so existing notebooks keep working. `normalizeNote()` backfills
`editMode = decomposedObjects ? "notes" : "annotate"`.

```text
page.editMode        = "annotate" | "notes"
page.conversionState = "idle" | "converting" | "failed"
```

* **annotate** (default) — `backgroundAssetId` snapshot for instant paint,
  `renderPdfPageBlob` for sharpness, no `pendingDecomposedData`. Pen, highlighter,
  shapes and text already work on top; no engine change required.
* **notes** — produced by promoting a single page via `decomposeStoredPdfPage()`.

### Decisions (resolved)

1. **A lightweight import must still learn real page dimensions.** Today
   `decomposePdf` supplies them (`main.js:3130`). Add `getPdfPageInfo(assetId)` to
   `raster.js` returning `{ numPages, pages: [{ width, height, rotation }] }` via
   `getPage()` + `getViewport()` — no operator-list parse, no raster. Reuse the
   existing `docs` cache (`raster.js:26`) so it costs essentially nothing.
2. **One pdf.js document, one owner.** `decomposeStoredPdfPage(assetId, pageIndex)`
   belongs in `decomposer.js`, but it must import `getPdfDoc` from `raster.js`
   rather than calling `pdfjs.getDocument` itself. Two independent openers means
   two workers, two parses, and a cache `invalidatePdfDoc` can no longer clear.
3. **Annotation preservation on promote.** Never load `canvasJson` over a freshly
   decomposed canvas — `loadDecomposedPdf` clears it (`engine.js:824`). Sequence:
   `const ink = engine.canvas.toObject()` → `await engine.loadPage(page)` with the
   fresh `pendingDecomposedData` → `util.enlivenObjects(ink.objects)` → `add()`
   each → `requestRenderAll()` → `recordHistory()` → persist.
4. **Lossy-extraction guard.** Flattened or scanned PDFs decompose badly. Gate
   promotion on the same `hasObjects` test already in `loadPage` (`engine.js:776`):
   if a page yields no text/path/image objects, leave it in `annotate` and say so
   rather than silently producing a near-empty page. Also surface
   `setBackgroundVisible()` (`engine.js:1060`, currently with no UI) as a
   "show original" escape hatch — the source PDF is kept forever, so the raster
   can always be restored.
5. **Batch "make all editable".** Extraction and Fabric instantiation are separate
   costs. Batch should only *extract* (write `pendingDecomposedData` + assets to
   IndexedDB) and never instantiate, because instantiation is already lazy in
   `loadPage`. Run sequentially with progress and cancellation. It remains O(pages),
   so it stays opt-in and never the default.
6. **Export is still raster-only.** `exporter.js:64-163` uses `pdf-lib` purely as a
   bitmap container, so the original text and vectors are lost. For annotate-mode
   pages the fix is `PDFDocument.load()` the source, copy the page in untouched,
   and draw only a transparent annotation PNG on top. Notes pages keep the current
   composed behaviour.

### Explicitly out of scope here

The O(n) engine-per-page defect (`initEditor` loop, `main.js:1887`) is a separate
change. `isActivePage` (`main.js:1951`) already limits *raster quality* for distant
pages, but not the number of live Fabric engines.

---

## 11. Git history

Seven commits, latest `10a9026 "Fix invisible strokes in imported PDFs"`.
Both `README.md` and package build verify clean (`npm run build`).
