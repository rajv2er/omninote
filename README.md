# OmniNote

OmniNote is a local-first notebook app for macOS, available as a native desktop app (Tauri v2) and in the browser.

Import a note PDF, keep its look, and keep writing on top of it. Where possible, imported text, images, and vector content stays editable.

## Features

- Notebook library with folders, pin, trash, and restore
- Multi-page canvas with pen, highlighter, eraser, select, text, and image tools
- PDF import with editable text / vector recovery and image fallback
- Undo / redo, page manager, and PDF export
- Offline local storage (IndexedDB), no account needed

## Quick start

### Web (Vite)

```bash
npm install
npm run dev      # http://localhost:5173
```

### Desktop (Tauri v2)

```bash
npm run tauri dev    # dev app with hot-reload
npm run tauri build  # release bundle
```

## Scripts

```bash
npm run build    # build web bundle to dist/
npm run lint     # run ESLint
npm test         # run tests in tests/run.mjs
```

## Project structure

```text
index.html       App entry
src/main.js      UI, canvas, storage, PDF import
src/             Canvas, PDF, storage, UI modules
src-tauri/       Tauri desktop shell (Rust)
tests/           Test runner and regression tests
scripts/         Dev / fixture scripts
```
