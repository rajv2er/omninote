import { icon } from "./icons.js";
import { escapeHtml } from "./escapeHtml.js";

/**
 * Renders the HTML grid of page tiles for the Page Manager modal.
 */
export function pageManagerTilesHtml(note, selection, thumbs) {
  return note.pages
    .map((p, i) => {
      const selected = selection.has(i);
      const thumb = thumbs[i] || "";
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

/**
 * Renders the Page Manager modal overlay structure.
 */
export function pageManagerOverlay(note, selection, thumbs, clipboardLength = 0) {
  const total = note.pages.length;
  const sel = selection.size;
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
      <div class="pm-grid" id="page-manager-grid">${pageManagerTilesHtml(note, selection, thumbs)}</div>
      <footer class="pm-toolbar">
        <button class="pm-op" id="pm-insert" title="Insert a blank page after the selection">${icon("plus", 16)}<span>Insert</span></button>
        <button class="pm-op" id="pm-rotate" ${sel ? "" : "disabled"} title="Rotate selected pages 90°">${icon("rotate", 16)}<span>Rotate</span></button>
        <span class="pm-sep"></span>
        <button class="pm-op" id="pm-copy" ${sel ? "" : "disabled"} title="Copy selected pages">${icon("copy", 16)}<span>Copy</span></button>
        <button class="pm-op" id="pm-cut" ${sel ? "" : "disabled"} title="Cut selected pages">${icon("cut", 16)}<span>Cut</span></button>
        <button class="pm-op" id="pm-paste" ${clipboardLength ? "" : "disabled"} title="Paste copied/cut pages">${icon("paste", 16)}<span>Paste</span></button>
        <button class="pm-op" id="pm-tag" ${sel ? "" : "disabled"} title="Tag selected pages">${icon("tag", 16)}<span>Tag</span></button>
        <span class="pm-sep"></span>
        <button class="pm-op pm-danger" id="pm-delete" ${sel ? "" : "disabled"} title="Delete selected pages">${icon("trash", 16)}<span>Delete</span></button>
        <span class="pm-spacer"></span>
        <button class="pm-op" id="pm-extract" ${sel ? "" : "disabled"} title="New notebook from selected pages">${icon("folder", 16)}<span>Extract</span></button>
        <button class="pm-op" id="pm-share" ${sel ? "" : "disabled"} title="Export selected pages as PDF">${icon("download", 16)}<span>Share</span></button>
      </footer>
    </div>`;
}
