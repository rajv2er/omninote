import { showShortcutsHelp } from "../ui/dialogs.js";

/**
 * Creates the editor's global keyboard handler.
 *
 * The handler is stateless apart from the copy/paste clipboard, which lives for
 * the lifetime of the app. The app shell injects the live engine lookup and the
 * actions a shortcut can trigger, so this module never reaches into app state.
 *
 * @param {object} options
 * @param {() => object|null} options.getActiveCanvasEngine
 * @param {(tool: string) => void} options.setActiveTool
 * @param {() => boolean} options.isPageManagerOpen
 * @param {() => void} options.closePageManager
 * @param {() => void} options.zoomIn
 * @param {() => void} options.zoomOut
 * @param {() => void} options.zoomReset
 * @param {(mode: string) => void} options.zoomFit
 */
export function createEditorShortcuts({
  getActiveCanvasEngine,
  setActiveTool,
  isPageManagerOpen,
  closePageManager,
  zoomIn,
  zoomOut,
  zoomReset,
  zoomFit,
}) {
  /**
   * True when a keystroke belongs to a field the user is typing into.
   *
   * Global shortcuts must not fire for these: on macOS the key labelled "Delete"
   * reports `Backspace`, so without this guard correcting a digit in the zoom
   * percentage field would also delete the selected object on the canvas.
   */
  function isTypingTarget(el) {
    if (!el || typeof el !== "object") return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  // Keyboard Shortcuts: Cmd+Z, Cmd+Shift+Z, Delete, Cmd+C, Cmd+V
  let clipboard = null;

  const onKeyDown = (e) => {
    // While the Page Manager is open, swallow everything except Escape (which
    // closes it) so shortcuts can't mutate the hidden editor behind the overlay.
    if (isPageManagerOpen()) {
      if (e.key === "Escape") {
        e.preventDefault();
        closePageManager();
      }
      return;
    }

    // Never steal keys from a focused form field. On macOS the key labelled
    // "Delete" reports `Backspace`, so correcting a digit in the zoom field
    // would otherwise delete the selected object and swallow the keystroke.
    if (isTypingTarget(e.target)) return;

    const engine = getActiveCanvasEngine();
    const isEditingText = engine?.canvas.getActiveObject()?.isEditing;

    if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      showShortcutsHelp();
      return;
    }

    // Single-key tool shortcuts (advertised in the shortcuts dialog).
    if (
      !isEditingText &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey
    ) {
      const toolMap = { v: "select", p: "pen", h: "marker", e: "eraser", t: "text" };
      const tool = toolMap[e.key.toLowerCase()];
      if (tool) {
        e.preventDefault();
        setActiveTool(tool);
        return;
      }
    }

    // Undo: Cmd+Z / Ctrl+Z
    if (
      (e.metaKey || e.ctrlKey) &&
      e.key.toLowerCase() === "z" &&
      !e.shiftKey
    ) {
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
    // Zoom shortcuts. Keep active even while editing text — typing into a
    // textbox never needs +, -, or 0 from the host keyboard.
    else if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      zoomIn();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "-") {
      e.preventDefault();
      zoomOut();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "0") {
      e.preventDefault();
      zoomReset();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "9") {
      e.preventDefault();
      zoomFit("width");
    } else if ((e.metaKey || e.ctrlKey) && e.key === "8") {
      e.preventDefault();
      zoomFit("page");
    }
  };

  return { onKeyDown };
}
