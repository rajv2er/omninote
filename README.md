# OmniNote

OmniNote is a deliberately small, local-first notebook app for macOS browsers.

Its purpose is simple: let someone move exported notebooks from Goodnotes, Notability, and similar apps into a clean canvas where they can keep writing and gradually make imported material editable.

It is **not** a general Canva clone, a document-management suite, or a feature-heavy Goodnotes replacement.

## Product promise

> Import a note PDF, keep its appearance, write on it immediately, and unlock editable imported objects whenever the file contains recoverable data.

The first release prioritizes a calm, Noteful-like notebook experience. The single meaningful differentiator is migration: Goodnotes/Notability exports should not become permanently dead documents when OmniNote can recover their content.

## Visual direction

The supplied references define the product's visual density and screen structure:

- [Library reference](/Users/rajveer/Desktop/Screenshot%202026-09-07%20at%205.59.29%E2%80%AFAM.png)
- [Notebook reference](/Users/rajveer/Desktop/Screenshot%202026-09-07%20at%205.59.38%E2%80%AFAM.png)

Use them as inspiration for spacing and information hierarchy. Do not copy Noteful's logo, artwork, icon set, exact UI, source code, private file format, or branding.

### Library

The library has one quiet sidebar and one content area.

```text
┌───────────────────┬──────────────────────────────────────────────────┐
│ OmniNote          │ omninote                         Import PDF  New │
│                   │                                                  │
│ ▦ Notebooks       │ ▱ Unfiled                                        │
│ ◌ Unfiled         │                                                  │
│ ♧ Pinned          │ YOUR NOTES                                       │
│ ♲ Trash           │ [ notebook thumbnail ] [ notebook thumbnail ]    │
│                   │                                                  │
│ FOLDERS           │                                             (+)  │
│ + New folder      │                                                  │
└───────────────────┴──────────────────────────────────────────────────┘
```

Only these destinations exist in the first release:

- Unfiled
- Pinned
- Trash
- Folders

### Notebook

```text
┌──────────────────────────────────────────────────────────────────────┐
│ ‹   Notebook title                                      ▦        ••• │
├───┬──────────────────────────────────────────────────────────────────┤
│ ✎ │                                                                  │
│ ▰ │                         page canvas                              │
│ ◇ │                                                                  │
│ ⌁ │                                                                  │
│ T │                                                                  │
│ ▧ │                                                                  │
├───┴──────────────────────────────────────────────────────────────────┤
│ Draw or click anywhere                                    4 px ───  │
└──────────────────────────────────────────────────────────────────────┘
```

The UI must remain sparse. The tool rail is the primary way to switch modes; contextual actions appear only after selecting an object.

## First-release scope

### Included

- Local notebook library with create, rename, pin, and trash actions.
- A one-page notebook canvas.
- Pen, highlighter, object eraser, selection, text, and image tools.
- Three visible colour choices and a stroke-width slider.
- Pointer input (mouse, trackpad, stylus where available).
- Imported PDF pages as writable backgrounds.
- Local persistence.
- Undo/redo once the object-command history is added.
- Export to PDF once the canvas model is stable.

### Explicitly out of scope

- Accounts, cloud sync, collaboration, sharing links, and comments.
- AI chat, summaries, generation, audio recording, handwriting recognition, OCR search, or flashcards.
- Template marketplace, stock asset library, stickers, elaborate brushes, rulers, tape, laser pointers, and dozens of colour presets.
- A native Goodnotes/Notability backup importer. Their native formats are proprietary.
- A promise that every PDF becomes perfectly editable.
- Copying Noteful or Canva's proprietary implementation or visual identity.

## Current prototype

The prototype is a Vite browser application.

```bash
npm install
npm run dev
```

Build verification:

```bash
npm run build
```

What currently works:

- Dark library and minimal notebook editor.
- New notebook creation and renaming.
- Local notebook metadata and canvas objects saved in `localStorage`.
- Freehand pen and highlighter strokes.
- Text and image insertion.
- Moving text and image objects with Select mode.
- PDF selection from the library. Every imported PDF page becomes its own note and is rasterized to a compressed WebP background.
- Page backgrounds are kept in IndexedDB, not as duplicated PDF files.

Prototype limitations to address next:

- Imported PDF content is currently a visual background, not yet decomposed into editable source objects.
- Erasing must be tested and improved to feel natural.
- Resize, rotation, object grouping, pin/trash/folder interactions, undo/redo, and PDF export are not built yet.
- The editor currently represents one page per notebook record. A real notebook/page model is required before the product grows.

## Technical approach

### Platform

Start as a local-first web application optimized for macOS desktop. It works in a browser now and can later be packaged as a macOS application or adapted for iPad.

Use Pointer Events rather than mouse-only events so stylus support is not designed out of the canvas.

### Storage

Do not keep every original imported PDF by default.

| Data | Storage | Reason |
|---|---|---|
| Notebook metadata and native object graph | Local persistence | Small and quickly queryable |
| Images and imported page fallback backgrounds | IndexedDB blobs | Avoids `localStorage` size limits |
| Render cache | Disposable | Regenerate it; never treat it as user data |
| Original PDF | Optional only | Retain only if the user wants exact-source fidelity |

If OmniNote cannot reconstruct a source item, it has only two honest options: retain a visual fallback for it, or let the user discard that item. It cannot promise both zero retained visual data and perfect visual fidelity.

### Internal document model

The app should own a native object model, not continually edit PDF bytes.

```text
Notebook
├── id, title, createdAt, pinned, folderId
└── pages[]
    ├── id, width, height, backgroundAssetId?
    ├── objects[]
    │   ├── stroke       { points, colour, width, opacity }
    │   ├── text         { text, x, y, width, font, size, colour }
    │   ├── image        { assetId, x, y, width, rotation }
    │   ├── shape        { kind, geometry, style }
    │   └── vectorGroup  { SVG/PDF paths, transform, style }
    └── importReport     { source?, extracted, grouped, fallback }
```

All coordinates belong to the page coordinate system, not screen pixels. Zoom, pan, screen resolution, and device pixel ratio must not change document data.

### Canvas layers

```text
top      selection controls / active transform box
         native text, image, shape, vector-group objects
         native ink strokes
bottom   optional imported-page fallback image
```

The fallback layer is locked. It should never accidentally intercept pen input or object selection.

## PDF migration strategy

### The supported input is an export

OmniNote targets PDFs exported from note-taking platforms, especially Goodnotes and Notability. It does not require the native proprietary notebook files.

Goodnotes has an **Editable PDF** option. Its published documentation says this can preserve handwriting, highlighting, text boxes, and images as selectable/movable/resizable PDF objects. A flattened export does not preserve that portability. See [Goodnotes' format documentation](https://support.goodnotes.com/hc/en-us/articles/8537070839183-Differences-between-Editable-and-Flattened-PDF-Formats).

Notability exports PDF, Note, JPEG, PNG, and NTB formats, but its native export formats should be treated as proprietary rather than a stable import contract. See [Notability's sharing documentation](https://support.gingerlabs.com/hc/en-us/articles/205228298-Sharing-Notes).

### Import levels

| Level | Input/result | User experience |
|---|---|---|
| A — page background | Any PDF | Page is rendered; write and place native objects over it |
| B — extracted objects | Digitally authored/exported PDF | Recover text, images, vector paths, highlights; select and transform them |
| C — reconstruction | Flattened/scanned content | Optional OCR or vision-assisted reconstruction; never claim perfect accuracy |

Level A is implemented as the safety net. Level B is the important differentiator. Level C is later and optional.

### Import pipeline

```text
PDF file
  │
  ├─ inspect page/resources
  ├─ extract native candidates: text, embedded images, vector paths, annotations
  ├─ classify: editable / grouped / fallback
  ├─ render any required fallback region to compressed WebP
  ├─ write native OmniNote page objects + fallback assets
  └─ discard original PDF unless “Keep original” was chosen
```

The importer must provide a concise report, for example:

```text
Imported 12 pages
• 38 text boxes editable
• 146 handwriting/vector groups movable and recolourable
• 3 visual fallback regions
• Original PDF not retained
```

### What “editable” means

For imported Goodnotes/Notability content, editable does **not** always mean restoring the exact original pen gesture, pressure curve, eraser history, or brush preset. A PDF often contains only final geometry.

The practical goal is:

- Move, scale, rotate, recolour, duplicate, delete, and arrange recovered objects.
- Edit actual text where the font/text data is available.
- Keep complex handwriting as a sensible `vectorGroup`, rather than turning every tiny path into an unusable individual object.
- Make all new OmniNote ink fully native and editable at stroke level.

## Interaction rules

### Tools

| Tool | Behaviour |
|---|---|
| Pen | Draw a native pressure-aware stroke |
| Highlighter | Draw a wide translucent native stroke |
| Eraser | Remove touched native strokes/objects; never damage the locked fallback layer |
| Select | Tap or drag-select objects, then move/resize/rotate/delete/group |
| Text | Click anywhere to place a text box |
| Image | Place a local image as an object |

### Selection

- Click/tap selects the topmost eligible object.
- Shift-click adds to selection on desktop.
- Dragging empty space makes a marquee selection.
- A selected group can be entered to select a child; grouping remains intact.
- Transform controls appear only while something is selected.
- Delete affects native objects, not fallback content.

### Input and performance

- Use `PointerEvent.pressure` when present; fall back to a stable width when it is not.
- Smooth input during drawing, but retain enough raw points to preserve handwriting quality.
- Use `requestAnimationFrame` for visual updates; save after a short debounce instead of on every pointer move.
- Render only visible pages once multiple-page notebooks exist.

## Design rules

- Dark shell, white/off-white paper, blue/purple accent only for active actions.
- Keep library cards small, with the page itself as the thumbnail.
- Avoid visible panels until the user asks for an action.
- Tool labels belong in hover tooltips, not permanently in the toolbar.
- Use clear, familiar symbols, but use original icon assets in a production build.
- Maintain good contrast and keyboard access; the app is not pen-only.

## Delivery phases

### Phase 0 — current walking skeleton

- Browser shell, library, editor, basic local persistence.
- Native pen/highlighter/text/image objects.
- PDF page-background import with source discarded.

### Phase 1 — dependable notebook editing

- Proper multi-page notebook model.
- Select, move, resize, rotate, delete, copy/paste, group/ungroup.
- Reliable eraser, undo/redo command history, pin/trash/folders.
- Page thumbnails and PDF export.

### Phase 2 — editable migration

- Inspect Goodnotes Editable PDF samples.
- Extract text, images, vector paths, and PDF annotations.
- Build `vectorGroup` objects and import report.
- Retain fallback only for unsupported elements.

### Phase 3 — optional recovery enhancements

- Text OCR for flattened PDFs.
- Vision-assisted segmentation for simple diagrams or graphics.
- User-controlled “Keep original PDF” option.

Do not begin Phase 3 until Phase 1 is dependable and Phase 2 has been tested against real exports.

## Test corpus

Build and maintain a private test set containing only documents the project has permission to use:

- Goodnotes Editable PDF: handwriting, highlighter, typed text, image, shape, imported slides.
- Goodnotes Flattened PDF of the same content.
- Notability PDF exports.
- A scanned handwritten page.
- A lecture slide deck annotated with ink.
- Multiple page sizes and orientations.
- A large notebook with at least 100 pages.

For every sample, compare:

1. visual appearance after import;
2. which objects became editable;
3. page load and drawing latency;
4. resulting local storage size;
5. exported-PDF appearance.

## Acceptance criteria

The focused v1 is ready for real use when a person can:

1. Import a typical exported note PDF without losing page appearance.
2. Open it quickly from the library.
3. Write smoothly with a mouse, trackpad, or available stylus.
4. Add and move a text box and image.
5. Erase their own additions without altering the imported page.
6. Close and reopen the browser without losing the notebook.
7. Export or print the annotated result.

The editable-import milestone is ready when a Goodnotes Editable PDF sample produces movable/recolourable vector groups and editable text without visible layout regressions.

## Repository map

```text
index.html          App entry point
src/main.js         UI, state, canvas input, local storage, PDF rendering
src/style.css       Minimal dark library and white-page editor styles
package.json        Vite commands and dependencies
```

## Decisions log

| Decision | Reason |
|---|---|
| macOS browser first | Fastest way to get a usable app matching the desktop references |
| Local-first | No account, sync, or backend complexity in v1 |
| Minimal tool set | The reference UI is intentionally sparse; feature volume is not the goal |
| Original PDF optional | Avoid duplicate storage; keep only when exact-source fidelity is important |
| PDF background before object recovery | Every PDF remains usable even when extraction fails |
| Goodnotes Editable PDF first | It is the clearest public path to portable PDF objects |
| Independent implementation | Learn from product patterns without copying proprietary code or assets |

