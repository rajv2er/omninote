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

### Install on macOS

1. Open the `.dmg` from Releases and drag OmniNote to Applications.
2. Try to open it. If macOS says `"OmniNote" is damaged and can't be opened` or `unverified developer`, run this once in Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/OmniNote.app
codesign --force --deep -s - /Applications/OmniNote.app
```

3. Open OmniNote normally from Finder / Launchpad.

Or in one go (does the same two commands + verify):

```bash
bash scripts/fix-macos.sh
```

One-command install of the latest release:

```bash
REPO=rajv2er/omninote bash scripts/install-mac.sh
```

Still blocked? System Settings > Privacy & Security > Open Anyway.

Why this step? This is a free ad-hoc signed build (`APPLE_SIGNING_IDENTITY="-"`), not Apple-notarised. Apple only skips Gatekeeper for $99/yr notarised apps.

### No install (web)

Same notebook, no Gatekeeper: `npm run build`, then host `dist/` anywhere
(GitHub Pages, Netlify, `npm run preview`). No account, data stays in IndexedDB.

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
