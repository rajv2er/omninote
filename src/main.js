import "./style.css";
import { OmniCanvas } from "./canvas/engine.js";
import { decomposePdf } from "./pdf/decomposer.js";
import { exportNotebookToPdf } from "./pdf/exporter.js";

const STORE_KEY = "omninote-notes-v2";

const PAGE_SIZES = {
  a4: { label: "A4 (Standard)", width: 800, height: 1130 },
  letter: { label: "US Letter", width: 800, height: 1035 },
  slide: { label: "16:9 Slide", width: 1200, height: 675 },
  square: { label: "Square (1:1)", width: 800, height: 800 },
};

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
let customColors = [];
try {
  customColors = JSON.parse(localStorage.getItem("omninote-custom-colors")) || [];
} catch {}
let isLoading = false;
let loadingMessage = "";
let showShapesFlyout = false;
let showPageSetup = false;
let activeFolder = "unfiled";

function normalizeNote(n) {
  if (!n) return n;
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
      },
    ];
  }
  if (n.currentPageIndex === undefined || n.currentPageIndex >= n.pages.length) {
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
      if (p.pendingDecomposedData?.detectedFonts) {
        p.pendingDecomposedData.detectedFonts.forEach((f) => detected.add(f));
      }
      if (!mostUsed && p.pendingDecomposedData?.mostUsedFont) {
        mostUsed = p.pendingDecomposedData.mostUsedFont;
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

function saveNotes() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(notes));
  } catch (e) {
    console.warn("Storage quota exceeded, stripping thumbnails:", e);
    // If local storage is full, strip heavy thumbnails to allow note save
    try {
      const stripped = notes.map((n) => ({
        ...n,
        pages: n.pages.map((p) => ({ ...p, thumbnail: null })),
      }));
      localStorage.setItem(STORE_KEY, JSON.stringify(stripped));
    } catch (err2) {
      console.error("Critical storage failure:", err2);
    }
  }
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
    upload: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
    download: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
    grid: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>`,
    folder: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`,
    pin: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>`,
    trash: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`,
    search: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
    plus: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    chevronDown: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
  };
  return icons[name] || "";
}

function render() {
  const app = document.querySelector("#app");
  const note = getActiveNote();

  if (note) {
    app.innerHTML = editorView(note);
    initEditor(note);
  } else {
    if (canvasEngine) {
      canvasEngine.destroy();
      canvasEngine = null;
    }
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

function libraryView() {
  return `
    <div class="shell">
      <aside>${sidebar()}</aside>
      <section class="library">
        <header class="library-top">
          <div class="library-top-title">
            ${icon("folder", 22)}
            <h1>Unfiled</h1>
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
            <button class="new-note-btn" id="new-note-btn">
              ${icon("plus", 16)}
              New Note
            </button>
          </div>
        </header>

        <p class="library-section-label">All Documents (${notes.length})</p>
        <div class="note-grid">
          ${notes.map(noteCard).join("")}
        </div>

        <button class="fab" id="fab-new-note" title="Create New Note">
          ${icon("plus", 22)}
        </button>
      </section>
    </div>
  `;
}

function sidebar() {
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
        <span class="side-badge">${notes.length}</span>
      </button>
      <button class="side ${activeFolder === "pinned" ? "active" : ""}" data-folder="pinned">
        ${icon("pin", 16)}
        <span>Pinned</span>
      </button>
      <button class="side ${activeFolder === "trash" ? "active" : ""}" data-folder="trash">
        ${icon("trash", 16)}
        <span>Trashed</span>
      </button>
    </nav>

    <div class="side-divider"></div>

    <div class="nav-section-title">
      <span>Folders</span>
    </div>
    <nav>
      <button class="side">
        ${icon("folder", 16)}
        <span>Lecture Notes</span>
      </button>
    </nav>
  `;
}

function noteCard(note) {
  const firstPage = note.pages?.[0];
  const pageCount = note.pages?.length || 1;
  const thumb = firstPage?.thumbnail || note.thumbnail;

  return `
    <div class="note-card-wrapper">
      <button class="note-card" data-open="${note.id}">
        <div class="preview ${firstPage?.paperStyle ? `paper-${firstPage.paperStyle}` : ""}">
          ${note.isPdf ? `<span class="preview-badge">${pageCount} ${pageCount === 1 ? "Page" : "Pages"}</span>` : ""}
          ${thumb ? `<img src="${thumb}" alt="" />` : `<span style="font-size: 28px; opacity: 0.3;">✦</span>`}
        </div>
        <strong>${escapeHtml(note.title)}</strong>
        <small>${pageCount} ${pageCount === 1 ? "page" : "pages"} · ${note.isPdf ? "PDF Document" : "Notebook"}</small>
      </button>
      <button class="card-delete-btn" data-delete-note="${note.id}" title="Delete notebook">
        ${icon("trash", 14)}
      </button>
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

  if (!detected.includes(selectedFont) && !STANDARD_FONTS.includes(selectedFont)) {
    html = `<option value="${escapeHtml(selectedFont)}" selected>${escapeHtml(selectedFont)}</option>` + html;
  }

  return html;
}

function updateFontToolbarState(selected) {
  const textObj = selected?.find(
    (o) => o.type === "i-text" || o.text !== undefined
  );

  const engine = getActiveCanvasEngine();

  const fontSelect = document.querySelector("#font-family-select");
  const sizeLabel = document.querySelector("#font-size-label");
  const boldBtn = document.querySelector("#font-bold-btn");
  const italicBtn = document.querySelector("#font-italic-btn");
  const underlineBtn = document.querySelector("#font-underline-btn");
  const strikethroughBtn = document.querySelector("#font-strikethrough-btn");

  if (textObj) {
    const font = textObj.fontFamily || engine?.currentFont || "DM Sans";
    if (fontSelect) {
      const exists = Array.from(fontSelect.options).some((o) => o.value === font);
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
  const defaultColors = ["#176a72"];
  const allColors = Array.from(new Set([...customColors, ...defaultColors]));
  
  const page = getCurrentPage();
  const pageIndex = note.currentPageIndex || 0;
  const totalPages = note.pages.length;
  
  const engine = getActiveCanvasEngine();

  return `
    <div class="editor">
      <header class="editor-top">
        <button class="icon-btn" id="back-btn" title="Back to Library">${icon("back", 18)}</button>

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
              <button class="paper-btn ${page.paperStyle === 'plain' ? 'active' : ''}" data-paper="plain" title="Plain White">
                <div class="paper-preview p-plain"></div>
              </button>
              <button class="paper-btn ${page.paperStyle === 'lined' ? 'active' : ''}" data-paper="lined" title="Ruled / Lined">
                <div class="paper-preview p-lined"></div>
              </button>
              <button class="paper-btn ${page.paperStyle === 'grid' ? 'active' : ''}" data-paper="grid" title="Graph Grid">
                <div class="paper-preview p-grid"></div>
              </button>
              <button class="paper-btn ${page.paperStyle === 'dotted' ? 'active' : ''}" data-paper="dotted" title="Dotted">
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
              .slice(0, 11)
              .map(
                (c, idx) => `
              <label class="swatch-dot ${c === currentColor ? "chosen" : ""}" data-color="${c}" data-swatch-idx="${idx}" style="--swatch:${c}" title="Click to use, double-click to change, Right-click to delete">
                <input type="color" class="swatch-edit-input" value="${c}" data-swatch-idx="${idx}" />
              </label>
            `
              )
              .join("")}
            <div style="position:relative">
              <button class="swatch-add-btn" id="add-color-btn" title="Add new color">+</button>
              <input type="color" id="add-color-input" class="swatch-edit-input" value="${currentColor}" />
            </div>
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
          `
            )
            .join("")}
        </section>

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
    </div>
  `;
}

async function initEditor(note) {
  if (canvasEngines && canvasEngines.length > 0) {
    canvasEngines.forEach(e => e.destroy());
    canvasEngines = [];
  }

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
    });

    engine.setColor(currentColor);
    engine.setWidth(currentWidth);
    engine.setTool(currentTool);
    await engine.loadPage(page);

    // Initial welcome text on first page
    if (i === 0 && note.id === "welcome-note" && !page.canvasJson && !page.pendingDecomposedData) {
      engine.addTextAt("Welcome to OmniNote", 100, 100);
      engine.addTextAt("Import any PDF using 'Import PDF' to edit text, images, and strokes!", 100, 170);
      engine.setTool("select");
      const json = engine.toJSON();
      page.canvasJson = json;
      saveNotes();
    }
    
    canvasEngines.push(engine);
  }

  // Set up scroll observer to update active page index
  const scrollContainer = document.querySelector("#canvas-scroll-container");
  if (scrollContainer) {
    const observer = new IntersectionObserver((entries) => {
      let maxRatio = 0;
      let mostVisibleIndex = note.currentPageIndex;
      entries.forEach(entry => {
        if (entry.isIntersecting && entry.intersectionRatio > maxRatio) {
          maxRatio = entry.intersectionRatio;
          mostVisibleIndex = Number(entry.target.dataset.index);
        }
      });
      if (mostVisibleIndex !== note.currentPageIndex) {
        note.currentPageIndex = mostVisibleIndex;
        document.querySelector(".page-counter-text").textContent = `Page ${note.currentPageIndex + 1} of ${note.pages.length}`;
        // Update nav buttons disabled state
        const prevBtn = document.querySelector("#prev-page-btn");
        const nextBtn = document.querySelector("#next-page-btn");
        if (prevBtn) prevBtn.disabled = note.currentPageIndex === 0;
        if (nextBtn) nextBtn.disabled = note.currentPageIndex === note.pages.length - 1;
        saveNotes();
      }
    }, {
      root: scrollContainer,
      threshold: [0.1, 0.5, 0.9]
    });

    document.querySelectorAll(".page-container").forEach(el => observer.observe(el));

    // Scroll to the active page on load
    const activeWrapper = document.querySelector(`#page-wrapper-${note.currentPageIndex}`);
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

      // Only generate thumbnail for the first page to save memory
      if (i === 0) {
        try {
          page.thumbnail = engine.canvas.toDataURL({
            format: "jpeg",
            quality: 0.35,
            multiplier: 0.2,
          });
        } catch (e) {}
      }
    }
  });

  saveNotes();
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

  // Page Navigation
  document.querySelector("#prev-page-btn")?.addEventListener("click", () => {
    if (note.currentPageIndex > 0) {
      const target = document.querySelector(`#page-wrapper-${note.currentPageIndex - 1}`);
      if (target) target.scrollIntoView({ behavior: 'smooth' });
    }
  });

  document.querySelector("#next-page-btn")?.addEventListener("click", () => {
    if (note.currentPageIndex < note.pages.length - 1) {
      const target = document.querySelector(`#page-wrapper-${note.currentPageIndex + 1}`);
      if (target) target.scrollIntoView({ behavior: 'smooth' });
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

  document.querySelector("#delete-page-btn")?.addEventListener("click", async () => {
    if (note.pages.length <= 1) return;
    if (confirm(`Delete Page ${note.currentPageIndex + 1}?`)) {
      note.pages.splice(note.currentPageIndex, 1);
      if (note.currentPageIndex >= note.pages.length) {
        note.currentPageIndex = note.pages.length - 1;
      }
      saveNotes();
      render();
    }
  });

  // Page Setup Toggle
  document.querySelector("#page-setup-toggle-btn")?.addEventListener("click", (e) => {
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
        
        document.querySelectorAll(".paper-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
      }
    });
  });

  // Page Size Selection
  document.querySelector("#page-size-select")?.addEventListener("change", (e) => {
    const page = getCurrentPage();
    const engine = getActiveCanvasEngine();
    const sizeConfig = PAGE_SIZES[e.target.value];
    if (page && sizeConfig && engine) {
      page.width = sizeConfig.width;
      page.height = sizeConfig.height;
      engine.setPageDimensions(sizeConfig.width, sizeConfig.height);
      saveActiveCanvasPage();
      const setupBtn = document.querySelector("#page-setup-toggle-btn span");
      if (setupBtn) setupBtn.textContent = `Page Style (${page.width} × ${page.height})`;
    }
  });

  // Font Family Selection
  document.querySelector("#font-family-select")?.addEventListener("change", (e) => {
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
    document.querySelector("#font-bold-btn")?.classList.toggle("active", isBold);
    saveActiveCanvasPage();
  });

  // Font Italic Toggle
  document.querySelector("#font-italic-btn")?.addEventListener("click", () => {
    const engine = getActiveCanvasEngine();
    if (!engine) return;
    const isItalic = engine.toggleItalic();
    document.querySelector("#font-italic-btn")?.classList.toggle("active", isItalic);
    saveActiveCanvasPage();
  });

  // Font Underline Toggle
  document.querySelector("#font-underline-btn")?.addEventListener("click", () => {
    const engine = getActiveCanvasEngine();
    if (!engine) return;
    const isUnderline = engine.toggleUnderline();
    document.querySelector("#font-underline-btn")?.classList.toggle("active", isUnderline);
    saveActiveCanvasPage();
  });

  // Font Strikethrough Toggle
  document.querySelector("#font-strikethrough-btn")?.addEventListener("click", () => {
    const engine = getActiveCanvasEngine();
    if (!engine) return;
    const isStrikethrough = engine.toggleStrikethrough();
    document.querySelector("#font-strikethrough-btn")?.classList.toggle("active", isStrikethrough);
    saveActiveCanvasPage();
  });

  // Export Multi-Page PDF
  document.querySelector("#export-pdf-btn")?.addEventListener("click", async () => {
    saveActiveCanvasPage();
    isLoading = true;
    loadingMessage = `Compiling '${note.title}' into PDF...`;
    renderLoading();

    try {
      await exportNotebookToPdf(note, getActiveCanvasEngine(), (curr, total) => {
        loadingMessage = `Exporting page ${curr} of ${total}...`;
        renderLoading();
      });
    } catch (err) {
      alert("Error exporting PDF: " + err.message);
      console.error(err);
    } finally {
      isLoading = false;
      renderLoading();
    }
  });

  // Shapes Tool Flyout
  document.querySelector("#shapes-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    showShapesFlyout = !showShapesFlyout;
    const flyout = document.querySelector("#shapes-flyout");
    if (flyout) flyout.style.display = showShapesFlyout ? "grid" : "none";
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
      canvasEngines.forEach(e => e.setTool("select"));
      document.querySelectorAll("[data-tool]").forEach((b) => b.classList.remove("selected"));
      document.querySelector('[data-tool="select"]')?.classList.add("selected");
    });
  });

  // Close menus on outside click
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#shapes-flyout") && !e.target.closest("#shapes-btn")) {
      showShapesFlyout = false;
      const flyout = document.querySelector("#shapes-flyout");
      if (flyout) flyout.style.display = "none";
    }
    if (!e.target.closest("#pen-styles-flyout") && !e.target.closest("#pen-style-toggle")) {
      const penFlyout = document.querySelector("#pen-styles-flyout");
      if (penFlyout) penFlyout.style.display = "none";
    }
    if (!e.target.closest("#page-setup-modal") && !e.target.closest("#page-setup-toggle-btn")) {
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

  document.querySelector("#delete-element-btn")?.addEventListener("click", () => {
    getActiveCanvasEngine()?.deleteSelected();
  });

  document.querySelector("#delete-notebook-btn")?.addEventListener("click", () => {
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
      canvasEngines.forEach(e => e.setTool(currentTool));

      document.querySelectorAll("[data-tool]").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
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
    });
  }

  // Pen Style Selection
  document.querySelectorAll("[data-pen-style]").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentPenStyle = btn.dataset.penStyle;
      canvasEngines.forEach(e => e.setPenStyle(currentPenStyle));

      // Also switch to pen tool
      currentTool = "pen";
      canvasEngines.forEach(e => e.setTool("pen"));
      document.querySelectorAll("[data-tool]").forEach((b) => b.classList.remove("selected"));
      document.querySelector('[data-tool="pen"]')?.classList.add("selected");

      // Update active state
      document.querySelectorAll(".pen-style-opt").forEach(b => b.classList.remove("active"));
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
      canvasEngines.forEach(e => e.setWidth(currentWidth));
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

  // Quick Swatches — single click = use color, double-click = edit color
  document.querySelectorAll(".swatch-dot[data-color]").forEach((btn) => {
    // Single click: select this color
    btn.addEventListener("click", (e) => {
      // Don't fire if the hidden input was the target
      if (e.target.classList.contains("swatch-edit-input")) return;
      currentColor = btn.dataset.color;
      canvasEngines.forEach(eng => eng.setColor(currentColor));
      updateThicknessPreview();
      document.querySelectorAll(".swatch-dot").forEach((b) => b.classList.remove("chosen"));
      btn.classList.add("chosen");
    });

    // Double-click: open color picker to change this swatch
    btn.addEventListener("dblclick", () => {
      const input = btn.querySelector(".swatch-edit-input");
      if (input) input.click();
    });

    // Right-click: delete swatch
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const idxStr = btn.dataset.swatchIdx;
      if (!idxStr) return;
      const idx = Number(idxStr);
      if (idx < customColors.length) {
        customColors.splice(idx, 1);
        localStorage.setItem("omninote-custom-colors", JSON.stringify(customColors));
        btn.remove();
        
        // Re-index remaining custom color swatches
        document.querySelectorAll(".swatch-dot").forEach(b => {
          const i = Number(b.dataset.swatchIdx);
          if (i > idx && i <= customColors.length) {
            b.dataset.swatchIdx = i - 1;
            const input = b.querySelector(".swatch-edit-input");
            if (input) input.dataset.swatchIdx = i - 1;
          }
        });
      }
    });

    // When picker confirms a new color, update the swatch in-place
    const editInput = btn.querySelector(".swatch-edit-input");
    if (editInput) {
      editInput.addEventListener("input", (e) => {
        currentColor = e.target.value;
        canvasEngines.forEach(eng => eng.setColor(currentColor));
        updateThicknessPreview();
        btn.style.setProperty("--swatch", currentColor);
        btn.dataset.color = currentColor;
        document.querySelectorAll(".swatch-dot").forEach((b) => b.classList.remove("chosen"));
        btn.classList.add("chosen");
      });
      editInput.addEventListener("change", (e) => {
        const newColor = e.target.value;
        const idx = Number(editInput.dataset.swatchIdx);
        // Update in customColors or replace the default
        const defaultColors = ["#176a72"];
        const allOld = [...customColors, ...defaultColors.filter(c => !customColors.includes(c))];
        if (idx < allOld.length) {
          if (idx < customColors.length) {
            customColors[idx] = newColor;
          } else {
            customColors.push(newColor);
          }
          localStorage.setItem("omninote-custom-colors", JSON.stringify(customColors));
        }
      });
    }
  });

  // Add new color button
  const addColorBtn = document.querySelector("#add-color-btn");
  const addColorInput = document.querySelector("#add-color-input");
  if (addColorBtn && addColorInput) {
    addColorBtn.addEventListener("click", () => {
      addColorInput.click();
    });
    addColorInput.addEventListener("change", (e) => {
      const newColor = e.target.value;
      if (!customColors.includes(newColor)) {
        customColors.push(newColor);
        localStorage.setItem("omninote-custom-colors", JSON.stringify(customColors));
      }
      currentColor = newColor;
      canvasEngines.forEach(eng => eng.setColor(currentColor));
      updateThicknessPreview();

      // Inject swatch into DOM before the + button
      const stack = document.querySelector(".swatches-stack");
      if (stack && addColorBtn) {
        const idx = customColors.length - 1;
        const swatchHtml = `<label class="swatch-dot chosen" data-color="${newColor}" data-swatch-idx="${idx}" style="--swatch:${newColor}" title="Click to use, double-click to change, Right-click to delete">
          <input type="color" class="swatch-edit-input" value="${newColor}" data-swatch-idx="${idx}" />
        </label>`;
        const wrapDiv = addColorBtn.parentElement;
        wrapDiv.insertAdjacentHTML("beforebegin", swatchHtml);

        document.querySelectorAll(".swatch-dot").forEach((b) => b.classList.remove("chosen"));

        // Bind the new swatch
        const newSwatch = wrapDiv.previousElementSibling;
        newSwatch.classList.add("chosen");
        newSwatch.addEventListener("click", (ev) => {
          if (ev.target.classList.contains("swatch-edit-input")) return;
          currentColor = newSwatch.dataset.color;
          canvasEngines.forEach(eng => eng.setColor(currentColor));
          updateThicknessPreview();
          document.querySelectorAll(".swatch-dot").forEach((b) => b.classList.remove("chosen"));
          newSwatch.classList.add("chosen");
        });
        newSwatch.addEventListener("dblclick", () => {
          const input = newSwatch.querySelector(".swatch-edit-input");
          if (input) input.click();
        });
        newSwatch.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const idxStr = newSwatch.dataset.swatchIdx;
          if (!idxStr) return;
          const swIdx = Number(idxStr);
          if (swIdx < customColors.length) {
            customColors.splice(swIdx, 1);
            localStorage.setItem("omninote-custom-colors", JSON.stringify(customColors));
            newSwatch.remove();
            document.querySelectorAll(".swatch-dot").forEach(b => {
              const i = Number(b.dataset.swatchIdx);
              if (i > swIdx && i <= customColors.length) {
                b.dataset.swatchIdx = i - 1;
                const input = b.querySelector(".swatch-edit-input");
                if (input) input.dataset.swatchIdx = i - 1;
              }
            });
          }
        });
        const editInput = newSwatch.querySelector(".swatch-edit-input");
        if (editInput) {
          editInput.addEventListener("input", (ev) => {
            currentColor = ev.target.value;
            canvasEngines.forEach(eng => eng.setColor(currentColor));
            updateThicknessPreview();
            newSwatch.style.setProperty("--swatch", currentColor);
            newSwatch.dataset.color = currentColor;
            document.querySelectorAll(".swatch-dot").forEach((b) => b.classList.remove("chosen"));
            newSwatch.classList.add("chosen");
          });
          editInput.addEventListener("change", (ev) => {
            const updatedColor = ev.target.value;
            const swIdx = Number(editInput.dataset.swatchIdx);
            if (swIdx < customColors.length) {
              customColors[swIdx] = updatedColor;
              localStorage.setItem("omninote-custom-colors", JSON.stringify(customColors));
            }
          });
        }
      }
    });
  }

  // Insert Image
  document.querySelector("#image-input")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    const engine = getActiveCanvasEngine();
    if (file && engine) {
      await engine.addImageFile(file);
      currentTool = "select";
      canvasEngines.forEach(e => e.setTool("select"));
      document.querySelectorAll("[data-tool]").forEach((b) => b.classList.remove("selected"));
      document.querySelector('[data-tool="select"]')?.classList.add("selected");
    }
    e.target.value = "";
  });

  // Keyboard Shortcuts: Cmd+Z, Cmd+Shift+Z, Delete, Cmd+C, Cmd+V
  let clipboard = null;

  window.onkeydown = (e) => {
    const engine = getActiveCanvasEngine();
    const isEditingText = engine?.canvas.getActiveObject()?.isEditing;

    // Undo: Cmd+Z / Ctrl+Z
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
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
  };
}

function bindLibraryEvents() {
  document.querySelectorAll("[data-open]").forEach((card) => {
    card.addEventListener("click", () => {
      activeId = card.dataset.open;
      render();
    });
  });

  // Delete note from library card
  document.querySelectorAll("[data-delete-note]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const noteId = btn.dataset.deleteNote;
      const targetNote = notes.find((n) => n.id === noteId);
      const title = targetNote?.title || "this notebook";
      if (confirm(`Are you sure you want to delete "${title}"?`)) {
        notes = notes.filter((n) => n.id !== noteId);
        if (activeId === noteId) {
          activeId = notes[0]?.id || null;
        }
        saveNotes();
        render();
      }
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
        },
      ],
    };
    notes.unshift(newNote);
    activeId = newNote.id;
    saveNotes();
    render();
  };

  document.querySelector("#new-note-btn")?.addEventListener("click", handleNewNote);
  document.querySelector("#fab-new-note")?.addEventListener("click", handleNewNote);

  // Import PDF into a single multi-page notebook
  document.querySelector("#pdf-input")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    isLoading = true;
    loadingMessage = `Decomposing '${file.name}' into editable pages...`;
    renderLoading();

    try {
      const buffer = await file.arrayBuffer();
      const pages = await decomposePdf(buffer, 1.333333);

      if (pages.length === 0) {
        throw new Error("No pages found in this PDF.");
      }

      const baseName = file.name.replace(/\.pdf$/i, "");

      // Create ONE notebook containing all decomposed pages with their exact individual sizes
      const newNotebook = {
        id: crypto.randomUUID(),
        title: baseName,
        createdAt: Date.now(),
        isPdf: true,
        defaultFont: pages.mostUsedFont || "DM Sans",
        detectedFonts: pages.detectedFonts || [],
        currentPageIndex: 0,
        pages: pages.map((page, idx) => ({
          id: crypto.randomUUID(),
          pageNumber: idx + 1,
          width: page.width, // Exact native PDF page dimensions
          height: page.height,
          paperStyle: "plain",
          pageSize: "custom",
          thumbnail: page.backgroundDataUrl,
          canvasJson: null,
          pendingDecomposedData: page,
        })),
      };

      notes.unshift(newNotebook);
      activeId = newNotebook.id;
      saveNotes();
    } catch (err) {
      alert("Could not decompose this PDF: " + err.message);
      console.error(err);
    } finally {
      isLoading = false;
      e.target.value = "";
      render();
    }
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[c]));
}

render();
