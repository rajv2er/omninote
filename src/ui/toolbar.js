import { renderFontOptions as renderFontOptionsHtml } from "./libraryView.js";

/**
 * Creates the editor toolbar helpers: font option rendering and toolbar state
 * sync. Shared notebook/tool state is read through injected getters.
 *
 * @param {object} options
 * @param {() => object|null} options.getActiveCanvasEngine
 * @param {() => string} options.getCurrentTool
 */
export function createToolbar({ getActiveCanvasEngine, getCurrentTool }) {
  function renderFontOptions(note) {
    const engine = getActiveCanvasEngine();
    const selectedFont = engine?.currentFont || note?.defaultFont || "DM Sans";
    return renderFontOptionsHtml(note, selectedFont);
  }

  function updateFontToolbarState(selected) {
    const textObj = selected?.find(
      (o) => o.type === "i-text" || o.text !== undefined,
    );

    const engine = getActiveCanvasEngine();
    if (!engine || !engine.canvas) return;
    const fontControlsBar = document.querySelector("#font-controls-bar");
    const fontSelect = document.querySelector("#font-family-select");
    const sizeLabel = document.querySelector("#font-size-label");
    const boldBtn = document.querySelector("#font-bold-btn");
    const italicBtn = document.querySelector("#font-italic-btn");
    const underlineBtn = document.querySelector("#font-underline-btn");
    const strikethroughBtn = document.querySelector("#font-strikethrough-btn");

    const hasTextSelection = !!textObj;
    const isTextTool = getCurrentTool() === "text";

    if (fontControlsBar) {
      const shouldShow = hasTextSelection || isTextTool;
      fontControlsBar.classList.toggle("visible", shouldShow);
    }

    if (!hasTextSelection && !isTextTool) {
      return;
    }

    if (textObj) {
      const font = textObj.fontFamily || engine?.currentFont || "DM Sans";
      if (fontSelect) {
        const exists = Array.from(fontSelect.options).some(
          (o) => o.value === font,
        );
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

  /**
   * Re-points the per-page toolbar at whichever page is now active.
   *
   * Undo/redo and the font controls describe the page being edited. Changing
   * pages does not fire a history or selection event on the page you arrive at,
   * so without this the buttons keep showing the state of the page you left —
   * undo stays greyed out on a page that has plenty to undo, and vice versa.
   */
  function syncToolbarForActivePage() {
    const engine = getActiveCanvasEngine();

    const undoBtn = document.querySelector("#undo-btn");
    const redoBtn = document.querySelector("#redo-btn");
    if (undoBtn) undoBtn.disabled = !engine?.canUndo?.();
    if (redoBtn) redoBtn.disabled = !engine?.canRedo?.();

    const selected = engine?.canvas?.getActiveObjects?.() || [];
    updateFontToolbarState(selected);
  }

  return { renderFontOptions, updateFontToolbarState, syncToolbarForActivePage };
}
