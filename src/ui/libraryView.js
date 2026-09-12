import { icon } from "./icons.js";
import { escapeHtml } from "./escapeHtml.js";

export const STANDARD_FONTS = [
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

export function renderFontOptions(note, currentSelectedFont) {
  const detected = note?.detectedFonts || [];
  const selectedFont = currentSelectedFont || note?.defaultFont || "DM Sans";

  let html = "";
  if (detected.length > 0) {
    html += `<optgroup label="Detected in Document">`;
    for (const font of detected) {
      const isSelected = font === selectedFont;
      const isDefault = font === note?.defaultFont;
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

export function noteCard(note, view, folders = []) {
  const firstPage = note.pages?.[0];
  const pageCount = note.pages?.length || 1;
  const thumbAssetId = firstPage?.thumbnailAssetId || note.thumbnailAssetId;
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

export function sidebar({ notes, folders, activeFolder, noteCount, folderPrefix }) {
  const folderList = folders
    .map(
      (f) => `
      <button class="side ${activeFolder === folderPrefix + f.id ? "active" : ""}" data-folder="${folderPrefix}${escapeHtml(f.id)}">
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

export function libraryView({
  notes,
  folders,
  activeFolder,
  visibleNotes,
  heading,
  emptyMsg,
  noteCount,
  folderPrefix,
}) {
  return `
    <div class="shell">
      <aside>${sidebar({ notes, folders, activeFolder, noteCount, folderPrefix })}</aside>
      <section class="library">
        <header class="library-top">
          <div class="library-top-title">
            ${icon("folder", 22)}
            <h1>${escapeHtml(heading)}</h1>
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

        <p class="library-section-label">${escapeHtml(heading)} (${visibleNotes.length})</p>
        <div class="note-grid">
          ${visibleNotes.length ? visibleNotes.map((n) => noteCard(n, activeFolder, folders)).join("") : `<div class="library-empty">${emptyMsg}</div>`}
        </div>

        <button class="fab" id="fab-new-note" title="Create New Note">
          ${icon("plus", 22)}
        </button>
      </section>
    </div>
  `;
}
