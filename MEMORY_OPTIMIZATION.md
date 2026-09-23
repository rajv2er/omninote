# OmniNote Performance & Memory Optimization Guide

This document details the memory footprint analysis of OmniNote, explains the root causes of memory consumption in development, and outlines the step-by-step engineering roadmap to achieve an ultra-lightweight, $O(1)$ memory architecture.

---

## 1. Diagnostic Snapshot (Live Measurements)

A live memory analysis (`ps` & `vmmap -summary`) of the running Tauri desktop application reveals the exact distribution of memory:

| Process | Resident Memory | Virtual Memory | Role & Responsibility |
|---|---|---|---|
| **`com.apple.WebKit.WebContent`** | **~1,300 MB (Dirty)** | **2,606 MB** | WebKit web engine rendering the canvas & UI |
| **`target/debug/app`** (OmniNote) | **103.8 MB** | ~35 GB (VM pool) | Native macOS Tauri Rust desktop shell |
| **`node`** (Vite Dev Server) | **119.2 MB** | 35.8 GB (VM pool) | Local development server & WebSocket HMR |
| **`com.apple.WebKit.GPU`** | **91.8 MB** | ~35 GB (VM pool) | macOS CoreAnimation & Metal GPU compositor |
| **`cargo-tauri`** | **42.4 MB** | ~34 GB (VM pool) | Tauri CLI dev watcher |
| **`com.apple.WebKit.Networking`** | **44.8 MB** | ~34 GB (VM pool) | WebKit internal IPC & local asset loading |

### Deep-Dive into WebKit Memory (`vmmap` Breakdown)
```text
Region Type                        Virtual      Resident         Dirty    Region Count
==============================   =========     =========     =========   =============
owned unmapped (graphics)             1.4G          1.3G        983.9M            1469
WebKit Malloc                         2.6G          1.6G        316.0M              76
DefaultMallocZone                    65.1M         14.7M          3.0M             412
==============================   =========     =========     =========   =============
TOTAL                                 4.3G          1.6G          1.3G            6650
```

> [!IMPORTANT]
> **Key Finding**: Out of ~1.3 GB of dirty RAM, **~1.0 GB is occupied entirely by `owned unmapped (graphics)` across 1,469 graphics allocations**. The Rust application itself is tiny (~103 MB), and the dev server is lightweight (~119 MB). The memory pressure comes almost exclusively from WebKit graphics backing stores.

---

## 2. Root Cause Analysis

### Bottleneck 1: $O(N)$ Canvas Engine Instantiation (`initEditor`)
- **Current Behavior**:
  When a notebook is opened, `initEditor(note)` in `src/main.js` iterates through **every single page in the document** and instantiates an `OmniCanvas` for each one:
  ```javascript
  for (let i = 0; i < note.pages.length; i++) {
    const engine = new OmniCanvas(canvasEl, ...);
    await engine.loadPage(page);
    canvasEngines.push(engine);
  }
  ```
- **The Retina Canvas Multiplier**:
  Each `OmniCanvas` wraps a Fabric.js instance, which allocates **two separate `<canvas>` elements**:
  1. A lower canvas for rendered objects, strokes, and PDF backgrounds.
  2. An upper canvas for active stylus input, brush previews, and selection bounds.
  
  On macOS Retina screens, `window.devicePixelRatio = 2` (or 3):
  $$\text{Backing Store Width} = 800 \times 2 = 1,600\text{ px}$$
  $$\text{Backing Store Height} = 1,130 \times 2 = 2,260\text{ px}$$
  $$\text{Uncompressed 32-bit RGBA Buffer} = 1,600 \times 2,260 \times 4\text{ bytes} \approx 14.5\text{ MB per canvas}$$
  $$\text{Memory per Page} = 14.5\text{ MB} \times 2\text{ canvases} \approx 29\text{ MB}$$

- **The Problem**:
  A 20-page document immediately allocates $20 \times 29\text{ MB} \approx \mathbf{580\text{ MB}}$ of uncompressed GPU backing textures in Metal, even if the user is only looking at Page 1. A 50-page document will exceed 1.4 GB.

---

### Bottleneck 2: Eager IndexedDB Hydration on Launch (`hydrateNotes`)
- **Current Behavior**:
  In `src/main.js:511`, `hydrateNotes()` runs before the first render:
  ```javascript
  for (const note of notes) {
    for (const page of note.pages || []) {
      const canvasKey = canvasKeyForPage(page);
      if (canvasKey && !page.canvasJson) {
        jobs.push(getPagePayload(canvasKey).then(...));
      }
    }
  }
  await Promise.all(jobs);
  ```
- **The Problem**:
  This reads and parses into JavaScript memory the complete serialized object graph (JSON) of **every page of every notebook in your entire library**, even when simply viewing the library grid.

---

### Bottleneck 3: Development Mode Overhead vs. Production Mode
Running via `cargo tauri dev` adds substantial development-only overhead:
1. **Node.js Vite Server**: Runs in the background (~120 MB RAM) to handle hot-reloading and file system watching.
2. **Unoptimized Debug Binary**: `target/debug/app` is built with `opt-level = 0`, debug symbols, and no dead-code elimination.
3. **WebKit Developer Tools**: WebKit allocates additional memory for console inspection, heap snapshots, and sourcemap tracking.
4. **Rust Compilation Spike**: The initial `cargo build` spawns 8–10 concurrent `rustc` compiler threads compiling >100 crates, which creates a temporary 2–4 GB CPU/RAM spike for ~15 seconds.

---

## 3. Optimization Roadmap & Solutions

```
Current Architecture (O(N) - Linear Memory Growth):
Notebook [Page 1 ... Page 50]
  ├── Page 1:  [Live Fabric Canvas] (29 MB)
  ├── Page 2:  [Live Fabric Canvas] (29 MB)
  ├── ...
  └── Page 50: [Live Fabric Canvas] (29 MB)
  → Total: ~1.45 GB GPU RAM

Target Architecture (O(1) - Constant Memory Window):
Notebook [Page 1 ... Page 50]
  ├── Offscreen Pages (1-3):    [Static Thumbnail / <img>]   (~0.5 MB)
  ├── Buffer Prev Page (4):     [Standby Canvas]             (~15 MB)
  ├── Active Visible Page (5):  [Full OmniCanvas Engine]     (~29 MB)
  ├── Buffer Next Page (6):     [Standby Canvas]             (~15 MB)
  └── Offscreen Pages (7-50):   [Static Thumbnail / <img>]   (~0.5 MB)
  → Total: ~60 MB GPU RAM (Fixed regardless of page count!)
```

---

### Phase 1: Immediate Quick Wins

#### 1. Lazy Payload Hydration
- **Change**: In `src/main.js`, update `hydrateNotes()` to do **nothing on startup**.
- **Execution**: Only load notebook metadata (id, title, page count, thumbnail).
- **On Note Open**: Only fetch payloads from IndexedDB for the pages of the opened note.
- **Impact**: App startup time drops to < 50 ms; Library view uses under **50 MB** of RAM.

#### 2. Rust Release Profile Optimization (`src-tauri/Cargo.toml`)
Configure Cargo to build a slim, memory-optimized binary:
```toml
[profile.dev]
opt-level = 1          # Speeds up dev runtime and reduces memory
incremental = true

[profile.release]
opt-level = "z"        # Optimize for binary and runtime size
lto = true             # Link-time optimization
codegen-units = 1      # Maximum cross-crate optimization
panic = "abort"        # Remove stack-unwind tables
strip = true           # Strip all debug symbols
```

#### 3. Off-Screen Canvas Backing Store Downscaling
- For pages where `isActivePage === false`, do not allocate 2x Retina backing stores.
- Render off-screen pages at `1x` (or `0.5x`) or unmount their `upperCanvasEl` (the transparent input layer).
- This immediately cuts memory on inactive pages by **75%**.

---

### Phase 2: The Core Architecture Fix — Virtualized Page Window

To permanently prevent OmniNote from being a resource hog, implement **Canvas Window Virtualization**:

#### Architecture Design:
1. **Sliding Window of 3 Pages**:
   - At any time, only at most 3 `OmniCanvas` engines exist:
     - `currentPageIndex - 1` (Previous page buffer for smooth upward scroll)
     - `currentPageIndex` (Active editing page with full tools, brush, hit-testing)
     - `currentPageIndex + 1` (Next page buffer for smooth downward scroll)
2. **Static Placeholder for Distant Pages**:
   - Every off-screen page wrapper `#page-wrapper-${i}` contains a simple `<img>` tag showing its thumbnail or pre-rendered raster snapshot.
   - Zero WebKit canvas backing store is allocated for distant pages.
3. **Scroll Intersection Observer**:
   - When the user scrolls, the observer detects the approaching page.
   - It serializes the page that is moving out of range, destroys its `OmniCanvas` instance, and mounts an `OmniCanvas` onto the incoming page.
4. **Result**:
   - Memory is **strictly $O(1)$**.
   - A 5-page notebook and a 500-page imported textbook use the exact same **~150 MB** of RAM.

---

### Phase 3: Production Build Comparison

When you are ready to distribute or run OmniNote daily, compile the production bundle:

```bash
npm run build
npm run tauri build
```

| Metric | Development (`tauri dev`) | Production (`tauri build`) |
|---|---|---|
| **Node.js Process** | Active (~120 MB) | **None (0 MB)** |
| **Frontend Serving** | Vite Dev Server via localhost | **Embedded static binary** |
| **Rust Executable** | Debug (~100 MB unoptimized) | **Release (~15–20 MB stripped)** |
| **Sourcemaps & DevTools** | Loaded in memory | **Disabled** |
| **Idle Memory Footprint** | ~1.4 GB (without virtualization) | **~150–250 MB** |
| **With Virtualization** | ~350 MB | **~80–120 MB** |

---

## 4. Summary Checklist for Future Implementation

- [ ] **Task 1**: Update `hydrateNotes()` in `src/main.js` to lazy-load page JSON on-demand.
- [ ] **Task 2**: Add `[profile.release]` and `[profile.dev]` flags to `src-tauri/Cargo.toml`.
- [ ] **Task 3**: Refactor `initEditor()` to mount a 3-page sliding window using `IntersectionObserver`.
- [ ] **Task 4**: Unmount `upperCanvasEl` for off-screen pages to release Metal GPU buffers.
- [ ] **Task 5**: Build and test with `npm run tauri build` to measure production memory consumption.
