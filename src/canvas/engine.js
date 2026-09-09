import {
  Canvas,
  IText,
  Path,
  FabricImage,
  Rect,
  Circle,
  Triangle,
  Line,
  PencilBrush,
} from "fabric";
import { getAssetUrl } from "../storage/assets.js";
import { renderPdfPageBlob } from "../pdf/raster.js";

// Zoom bounds. The ceiling matters: 400% is a viewing cap, but handwriting
// needs real magnification, and the note apps this competes with go past it.
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 8;

// Crisp-zoom budget.
//
// Zoom used to magnify the existing bitmap: the backing store stayed at page
// size while the CSS box grew, so every zoom level above 100% was an upscale.
// Now the page is genuinely re-rendered at the zoomed resolution, which means
// the backing store grows with zoom. Browsers cap a canvas both per-edge and
// by total pixel count (Safari especially), so the render scale is clamped to
// these bounds and the shortfall degrades to a slight softness at extreme zoom
// rather than an allocation failure.
const MAX_CANVAS_EDGE = 16384;
const MAX_CANVAS_PIXELS = 32e6;
const MIN_RENDER_SCALE = 0.2;

// Re-rasterizing the imported page is the expensive half of a zoom change, so
// it only runs once the user stops moving the slider/wheel for this long.
const RASTER_DEBOUNCE_MS = 180;

export class OmniCanvas {
  constructor(canvasEl, options = {}) {
    this.canvasEl = canvasEl;
    this.width = options.width || 800;
    this.height = options.height || 1130;
    this.paperStyle = options.paperStyle || "plain";
    this.currentTool = "select";
    this.currentColor = "#176a72";
    this.currentWidth = 4;
    this.currentFont = options.defaultFont || "DM Sans";
    this.currentFontSize = 22;
    this.isBold = false;
    this.isItalic = false;
    this.isUnderline = false;
    this.isStrikethrough = false;
    this.penStyle = "ballpoint";

    // Zoom / Pan state. `currentZoom` is the only zoom variable — it is what
    // `setZoom` writes and `applyTransform` reads. `panX`/`panY` are the
    // viewport offset in screen pixels.
    // `renderZoom` is the zoom the backing store is actually rendered at. It
    // equals `currentZoom` until the pixel budget clamps it.
    this.renderZoom = 1;
    this.currentZoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.isPanning = false;
    this.panStartX = 0;
    this.panStartY = 0;
    this.isSpaceDown = false;
    // When locked, every zoom path is ignored (wheel, pinch, fit, shortcuts).
    // Notein does the same and it exists because a stray pinch while your palm
    // rests on the screen is otherwise unrecoverable mid-sentence.
    this.zoomLocked = false;
    this.wheelZoomEnabled = true;

    // Pinch state. A trackpad pinch is a *burst* of ~100 ctrl+wheel events, so
    // the delta is accumulated across the whole gesture and mapped to a change
    // in percentage points — the same linear, predictable response you get from
    // dragging the slider. Applying a factor per event instead makes a single
    // pinch compound into a runaway jump.
    this._pinchAccum = 0;
    this._pinchStartPct = 100;
    this._pinchTimer = null;
    // Percentage points gained per pixel of accumulated pinch. Tune this one
    // number to change how fast a pinch zooms; the slider is the reference feel.
    this.pinchPercentPerPixel = 0.35;
    // Latest un-applied pinch target and the frame that will apply it. A pinch
    // fires far more often than the screen refreshes, so the value is coalesced
    // into one update per animation frame.
    this._pinchPendingPct = null;
    this._pinchFrame = null;
    // True while a gesture is being tracked by CSS-only scaling (see
    // `applyTransform`). The backing store is re-rendered once on commit.
    this._previewActive = false;

    this.onModified = options.onModified || (() => {});
    this.onHistoryChange = options.onHistoryChange || (() => {});
    this.onSelectionChange = options.onSelectionChange || (() => {});
    this.onZoomChange = options.onZoomChange || (() => {});
    // Set by the app so wheel/pinch zoom goes through the same `setZoom` path
    // as the slider (UI sync, scroll anchoring, zoom lock).
    this.onZoomRequest = options.onZoomRequest || null;
    // Called once when a pinch begins and once when it ends, so the app can
    // hold a single scroll anchor for the whole gesture.
    this.onZoomStart = options.onZoomStart || null;
    this.onZoomEnd = options.onZoomEnd || null;

    // Locked imported-page fallback layer. Held separately from the object graph
    // so it is never serialized into undo history or persisted canvas JSON.
    this.backgroundImage = null;
    this.backgroundVisible = true;

    // Optional link back to the PDF this page was imported from. When present,
    // the background is re-rasterized from the source at the current zoom
    // (Google Drive behaviour) instead of being magnified from the single
    // snapshot captured at import time.
    this.pdfSource = null;
    this._bgRasterTimer = null;
    this._bgRasterToken = 0;
    this._bgRasterWidth = 0;
    this._bgRasterBusy = false;
    this._hiResBgUrl = null;
    // Every page gets an engine, so only the visible one is worth re-rendering.
    this.isActivePage = true;

    // Undo / Redo history tracking
    this.history = [];
    this.historyIndex = -1;
    this.isHistoryProcessing = false;

    this.initCanvas();
    this.setupEvents();
    this.setupPointerEvents();
    this.setTool("select");
    this.setPaperStyle(this.paperStyle);
    this.recordHistory(false);
  }

  initCanvas() {
    this.canvas = new Canvas(this.canvasEl, {
      width: this.width,
      height: this.height,
      backgroundColor: "transparent",
      selection: true,
      preserveObjectStacking: true,
      viewportTransform: [1, 0, 0, 1, 0, 0],
    });

    this.canvas.selectionColor = "rgba(99, 102, 241, 0.12)";
    this.canvas.selectionBorderColor = "#6366f1";
    this.canvas.selectionLineWidth = 1.5;
  }

  setupEvents() {
    this.canvas.on("object:modified", () => this.recordHistory());
    this.canvas.on("object:added", (e) => {
      if (!this.isHistoryProcessing && !e.target?.__skipHistory) {
        this.recordHistory();
      }
    });
    this.canvas.on("object:removed", () => {
      if (!this.isHistoryProcessing) {
        this.recordHistory();
      }
    });

    this.canvas.on("path:created", (e) => {
      const path = e.path;
      if (this.currentTool === "marker") {
        path.set({ opacity: 0.65, selectable: false });
      } else if (this.currentTool === "pen") {
        const style = this.penStyle || "ballpoint";
        const props = { selectable: false };
        if (style === "felt") {
          props.strokeLineCap = "butt";
          props.strokeLineJoin = "miter";
        }
        if (style === "dashed") {
          props.strokeDashArray = [6, 6];
        }
        path.set(props);
      } else {
        path.set({ selectable: false });
      }
      this.recordHistory();
    });

    // Selection change callbacks for contextual toolbar
    this.canvas.on("selection:created", (e) => this.onSelectionChange(e.selected || []));
    this.canvas.on("selection:updated", (e) => this.onSelectionChange(e.selected || []));
    this.canvas.on("selection:cleared", () => this.onSelectionChange([]));

    // Text click handling
    this.canvas.on("mouse:down", (opt) => {
      const pointer = this.canvas.getScenePoint(opt.e);

      if (this.currentTool === "text" && !opt.target) {
        this.addTextAt("Type here...", pointer.x, pointer.y);
        this.setTool("select");
      }
    });
  }

  performErase(e) {
    const pointer = this.canvas.getScenePoint(e);
    const objects = this.canvas.getObjects();
    for (let i = objects.length - 1; i >= 0; i--) {
      const obj = objects[i];
      if (obj === this.canvas.backgroundImage) continue;
      const bound = obj.getBoundingRect();
      if (
        pointer.x >= bound.left &&
        pointer.x <= bound.left + bound.width &&
        pointer.y >= bound.top &&
        pointer.y <= bound.top + bound.height
      ) {
        this.canvas.remove(obj);
        this.canvas.requestRenderAll();
        this.recordHistory();
        return;
      }
    }
  }

  setupPointerEvents() {
    const el = this.canvas.upperCanvasEl;
    if (!el) return;

    // Ctrl/Cmd + wheel (which is what a trackpad pinch actually is on macOS).
    el.addEventListener(
      "wheel",
      (e) => {
        if (e.ctrlKey || e.metaKey) {
          // Swallow it either way — otherwise the browser page-zooms instead.
          e.preventDefault();
          if (!this.wheelZoomEnabled) return;

          // deltaMode 1 = lines, 2 = pages; normalise both to pixels.
          const raw =
            e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
          const px = Math.max(-200, Math.min(200, raw));

          // A pinch is one continuous gesture, not 100 independent zooms. Track
          // where it started and convert the *running total* into percentage
          // points, exactly like the distance you dragged the zoom slider.
          const isNewGesture = !this._pinchTimer;
          if (this._pinchTimer) {
            clearTimeout(this._pinchTimer);
          } else {
            this._pinchStartPct = this.currentZoom * 100;
            this._pinchAccum = 0;
          }
          this._pinchTimer = setTimeout(() => this._endPinch(), 150);
          if (isNewGesture && this.onZoomStart) this.onZoomStart(e.clientX, e.clientY);

          this._pinchAccum += -px;
          this._pinchPendingPct =
            this._pinchStartPct + this._pinchAccum * this.pinchPercentPerPixel;

          // Coalesce: a trackpad can fire several events between two frames.
          // Applying every one reallocated and fully re-rendered every canvas in
          // the notebook, which is what made the gesture stutter.
          if (!this._pinchFrame) {
            this._pinchFrame = requestAnimationFrame(() => {
              this._pinchFrame = null;
              this._flushPinch();
            });
          }
        }
      },
      { passive: false },
    );

    // Space key for temporary pan mode. Sets isSpaceDown so pointerdown can
    // decide to pan instead of select/draw.
    const handleKeyDown = (e) => {
      if (e.code === "Space" && !e.repeat) {
        this.isSpaceDown = true;
        this.canvas.defaultCursor = "grab";
        el.style.cursor = "grab";
      }
    };
    const handleKeyUp = (e) => {
      if (e.code === "Space") {
        this.isSpaceDown = false;
        this.canvas.defaultCursor = this.currentTool === "eraser" ? "crosshair" : "default";
        el.style.cursor = "";
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
    this._keyboardHandlers = { handleKeyDown, handleKeyUp };

    el.addEventListener("pointerdown", (e) => {
      if (this.currentTool === "eraser") {
        this.isEraserDown = true;
        this.performErase(e);
      } else if (e.button === 1 || (e.button === 0 && this.isSpaceDown)) {
        // Middle mouse OR space+drag to pan.
        this.isPanning = true;
        this.panStartX = e.clientX - this.panX;
        this.panStartY = e.clientY - this.panY;
        el.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    });

    el.addEventListener("pointermove", (e) => {
      if (this.currentTool === "eraser" && this.isEraserDown) {
        this.performErase(e);
      } else if (this.isPanning) {
        this.panX = e.clientX - this.panStartX;
        this.panY = e.clientY - this.panStartY;
        this.applyTransform();
      }
    });

    const finishStroke = () => {
      this.isEraserDown = false;
      this.isPanning = false;
    };

    el.addEventListener("pointerup", finishStroke);
    el.addEventListener("pointercancel", finishStroke);
    el.addEventListener("pointerleave", finishStroke);
  }

  /**
   * Serializes the editable object graph only. The locked fallback background is
   * deliberately excluded: it lives in IndexedDB behind an asset id, and its
   * object URL would be dead by the time this JSON is reloaded.
   */
  serialize() {
    const json = this.canvas.toJSON();
    delete json.backgroundImage;
    // Fabric may record the canvas dimensions; they are render state, not
    // document state, so they are pinned back to the page size.
    if ("width" in json) json.width = this.width;
    if ("height" in json) json.height = this.height;
    return json;
  }

  recordHistory(triggerModified = true) {
    if (this.isHistoryProcessing) return;

    const state = JSON.stringify(this.serialize());
    if (this.history[this.historyIndex] === state) return;

    this.historyIndex++;
    this.history = this.history.slice(0, this.historyIndex);
    this.history.push(state);

    if (this.history.length > 35) {
      this.history.shift();
      this.historyIndex--;
    }

    this.notifyHistory();
    if (triggerModified) {
      this.onModified();
    }
  }

  notifyHistory() {
    this.onHistoryChange({
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
    });
  }

  canUndo() {
    return this.historyIndex > 0;
  }

  canRedo() {
    return this.historyIndex < this.history.length - 1;
  }

  async undo() {
    if (!this.canUndo()) return;
    this.isHistoryProcessing = true;
    this.historyIndex--;
    const state = JSON.parse(this.history[this.historyIndex]);
    await this.canvas.loadFromJSON(state);
    this.applyBackground();
    this.canvas.requestRenderAll();
    this.isHistoryProcessing = false;
    this.notifyHistory();
    this.onModified();
  }

  async redo() {
    if (!this.canRedo()) return;
    this.isHistoryProcessing = true;
    this.historyIndex++;
    const state = JSON.parse(this.history[this.historyIndex]);
    await this.canvas.loadFromJSON(state);
    this.applyBackground();
    this.canvas.requestRenderAll();
    this.isHistoryProcessing = false;
    this.notifyHistory();
    this.onModified();
  }

  setTool(tool) {
    this.currentTool = tool;
    this.canvas.isDrawingMode = false;

    if (tool === "select") {
      this.canvas.selection = true;
      this.canvas.defaultCursor = "default";
      this.setObjectsSelectable(true);
    } else if (tool === "pen" || tool === "marker") {
      this.canvas.isDrawingMode = true;
      if (!this.canvas.freeDrawingBrush) {
        this.canvas.freeDrawingBrush = new PencilBrush(this.canvas);
      }
      const brush = this.canvas.freeDrawingBrush;
      if (tool === "marker") {
        brush.color = this.getMarkerColor(this.currentColor);
        brush.width = this.currentWidth * 3;
        brush.strokeLineCap = "round";
        brush.strokeDashArray = null;
      } else {
        brush.color = this.currentColor;
        // Apply pen style
        const style = this.penStyle || "ballpoint";
        if (style === "ballpoint") {
          brush.width = this.currentWidth;
          brush.strokeLineCap = "round";
          brush.strokeDashArray = null;
        } else if (style === "fountain") {
          brush.width = this.currentWidth * 2;
          brush.strokeLineCap = "round";
          brush.strokeDashArray = null;
        } else if (style === "felt") {
          brush.width = this.currentWidth * 1.5;
          brush.strokeLineCap = "butt";
          brush.strokeDashArray = null;
        } else if (style === "dashed") {
          brush.width = this.currentWidth;
          brush.strokeLineCap = "round";
          brush.strokeDashArray = [6, 6];
        }
      }
      this.canvas.selection = false;
      this.canvas.defaultCursor = "crosshair";
      this.setObjectsSelectable(false);
    } else if (tool === "eraser") {
      this.canvas.selection = false;
      this.canvas.defaultCursor = "crosshair";
      this.setObjectsSelectable(false);
    } else if (tool === "text") {
      this.canvas.selection = false;
      this.canvas.defaultCursor = "text";
      this.setObjectsSelectable(false);
    }
  }

  setFontFamily(fontFamily) {
    this.currentFont = fontFamily;
    const activeObj = this.canvas.getActiveObject();
    if (activeObj && activeObj instanceof IText) {
      activeObj.set("fontFamily", fontFamily);
      this.canvas.requestRenderAll();
      this.recordHistory();
    }
  }

  setFontSize(size) {
    this.currentFontSize = size;
    const activeObj = this.canvas.getActiveObject();
    if (activeObj && activeObj instanceof IText) {
      activeObj.set("fontSize", size);
      this.canvas.requestRenderAll();
      this.recordHistory();
    }
  }

  toggleBold() {
    const activeObj = this.canvas.getActiveObject();
    if (activeObj && activeObj instanceof IText) {
      const isBold = activeObj.fontWeight === "bold" || activeObj.fontWeight === 700;
      activeObj.set("fontWeight", isBold ? "normal" : "bold");
      this.canvas.requestRenderAll();
      this.recordHistory();
      return !isBold;
    }
    this.isBold = !this.isBold;
    return this.isBold;
  }

  toggleItalic() {
    const activeObj = this.canvas.getActiveObject();
    if (activeObj && activeObj instanceof IText) {
      const isItalic = activeObj.fontStyle === "italic";
      activeObj.set("fontStyle", isItalic ? "normal" : "italic");
      this.canvas.requestRenderAll();
      this.recordHistory();
      return !isItalic;
    }
    this.isItalic = !this.isItalic;
    return this.isItalic;
  }

  toggleUnderline() {
    const activeObj = this.canvas.getActiveObject();
    if (activeObj && activeObj instanceof IText) {
      const isUnderlined = activeObj.underline;
      activeObj.set("underline", !isUnderlined);
      this.canvas.requestRenderAll();
      this.recordHistory();
      return !isUnderlined;
    }
    this.isUnderline = !this.isUnderline;
    return this.isUnderline;
  }

  toggleStrikethrough() {
    const activeObj = this.canvas.getActiveObject();
    if (activeObj && activeObj instanceof IText) {
      const isStrikethrough = activeObj.linethrough;
      activeObj.set("linethrough", !isStrikethrough);
      this.canvas.requestRenderAll();
      this.recordHistory();
      return !isStrikethrough;
    }
    this.isStrikethrough = !this.isStrikethrough;
    return this.isStrikethrough;
  }

  setPenStyle(style) {
    this.penStyle = style;
    // Re-apply brush settings if pen is currently active
    if (this.currentTool === "pen") {
      this.setTool("pen");
    }
  }

  setColor(color) {
    this.currentColor = color;

    if (this.canvas.freeDrawingBrush && (this.currentTool === "pen" || this.currentTool === "marker")) {
      this.canvas.freeDrawingBrush.color = this.currentTool === "marker" ? this.getMarkerColor(color) : color;
    }

    const activeObj = this.canvas.getActiveObject();
    if (activeObj) {
      if (activeObj instanceof IText) {
        activeObj.set("fill", color);
      } else if (activeObj instanceof Path) {
        if (activeObj.fill && activeObj.fill !== "transparent") {
          activeObj.set("fill", color);
        } else if (activeObj.stroke) {
          activeObj.set("stroke", color);
        }
      } else if (activeObj instanceof Line) {
        activeObj.set("stroke", color);
      } else if (activeObj instanceof Rect || activeObj instanceof Circle || activeObj instanceof Triangle) {
        if (activeObj.stroke && activeObj.stroke !== "transparent") {
          activeObj.set("stroke", color);
        } else {
          activeObj.set("fill", color);
        }
      }
      this.canvas.requestRenderAll();
      this.recordHistory();
    }
  }

  setWidth(width) {
    this.currentWidth = width;

    if (this.canvas.freeDrawingBrush && (this.currentTool === "pen" || this.currentTool === "marker")) {
      this.canvas.freeDrawingBrush.width = this.currentTool === "marker" ? width * 3 : width;
    }

    const activeObj = this.canvas.getActiveObject();
    if (activeObj && activeObj.strokeWidth !== undefined) {
      activeObj.set("strokeWidth", width);
      this.canvas.requestRenderAll();
      this.recordHistory();
    }
  }

  getMarkerColor(hex) {
    let cleanHex = hex.replace("#", "");
    if (cleanHex.length === 3) {
      cleanHex = cleanHex.split("").map((c) => c + c).join("");
    }
    const r = parseInt(cleanHex.slice(0, 2), 16) || 0;
    const g = parseInt(cleanHex.slice(2, 4), 16) || 0;
    const b = parseInt(cleanHex.slice(4, 6), 16) || 0;
    return `rgba(${r}, ${g}, ${b}, 0.65)`;
  }

  setObjectsSelectable(selectable) {
    this.canvas.forEachObject((obj) => {
      obj.selectable = selectable;
      obj.evented = selectable || this.currentTool === "eraser";
    });
    this.canvas.requestRenderAll();
  }

  addTextAt(text, x, y) {
    const itext = new IText(text, {
      left: x,
      top: y,
      originX: "left",
      originY: "top",
      fontFamily: this.currentFont,
      fontSize: this.currentFontSize || 22,
      fontWeight: this.isBold ? "bold" : "normal",
      fontStyle: this.isItalic ? "italic" : "normal",
      underline: this.isUnderline,
      linethrough: this.isStrikethrough,
      fill: this.currentColor,
      cornerColor: "#6366f1",
      cornerStyle: "circle",
      cornerSize: 8,
      transparentCorners: false,
    });
    this.canvas.add(itext);
    this.canvas.setActiveObject(itext);
    itext.enterEditing();
    itext.selectAll();
    this.canvas.requestRenderAll();
  }

  addShape(type) {
    const centerX = this.width / 2 - 60;
    const centerY = this.height / 2 - 50;

    const commonOpts = {
      left: Math.max(40, centerX),
      top: Math.max(40, centerY),
      originX: "left",
      originY: "top",
      stroke: this.currentColor,
      strokeWidth: this.currentWidth,
      fill: "transparent",
      cornerColor: "#6366f1",
      cornerStyle: "circle",
      cornerSize: 8,
      transparentCorners: false,
    };

    let shape;
    if (type === "rect") {
      shape = new Rect({
        ...commonOpts,
        width: 140,
        height: 90,
        rx: 4,
        ry: 4,
      });
    } else if (type === "circle") {
      shape = new Circle({
        ...commonOpts,
        radius: 55,
      });
    } else if (type === "triangle") {
      shape = new Triangle({
        ...commonOpts,
        width: 120,
        height: 100,
      });
    } else if (type === "line") {
      shape = new Line([centerX, centerY, centerX + 180, centerY], {
        stroke: this.currentColor,
        strokeWidth: this.currentWidth,
        originX: "left",
        originY: "top",
        cornerColor: "#6366f1",
        cornerStyle: "circle",
        cornerSize: 8,
        transparentCorners: false,
      });
    }

    if (shape) {
      this.canvas.add(shape);
      this.setTool("select");
      this.canvas.setActiveObject(shape);
      this.canvas.requestRenderAll();
    }
  }

  setPaperStyle(style) {
    this.paperStyle = style;
    const container = this.canvasEl.closest(".canvas-container") || this.canvasEl.parentElement;
    if (container) {
      container.classList.remove("paper-plain", "paper-lined", "paper-grid", "paper-dotted");
      container.classList.add(`paper-${style}`);
    }
    this.onModified();
  }

  setPageDimensions(width, height) {
    this.width = Math.round(width);
    this.height = Math.round(height);
    this.canvas.setDimensions({ width: this.width, height: this.height });
    this.applyTransform();
    this.recordHistory();
  }

  async addImageFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const img = await FabricImage.fromURL(e.target.result);
          const maxDim = 400;
          if (img.width > maxDim || img.height > maxDim) {
            const scale = maxDim / Math.max(img.width, img.height);
            img.scale(scale);
          }
          img.set({
            left: 100,
            top: 100,
            originX: "left",
            originY: "top",
            cornerColor: "#6366f1",
            cornerStyle: "circle",
            cornerSize: 8,
            transparentCorners: false,
          });
          this.canvas.add(img);
          this.canvas.setActiveObject(img);
          this.canvas.requestRenderAll();
          resolve(img);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  deleteSelected() {
    const activeObjects = this.canvas.getActiveObjects();
    if (activeObjects.length > 0) {
      activeObjects.forEach((obj) => this.canvas.remove(obj));
      this.canvas.discardActiveObject();
      this.canvas.requestRenderAll();
    }
  }

  /**
   * Loads a specific notebook page (handles either decomposed PDF data or saved JSON).
   * Automatically adapts canvas width & height to the page's exact dimensions.
   */
  async loadPage(page) {
    this.isHistoryProcessing = true;
    this.canvas.clear();

    this.width = Math.round(page.width || 800);
    this.height = Math.round(page.height || 1130);
    this.canvas.setDimensions({ width: this.width, height: this.height });
    this.setPaperStyle(page.paperStyle || "plain");

    if (page.pendingDecomposedData) {
      await this.loadDecomposedPdf(page.pendingDecomposedData);
      delete page.pendingDecomposedData;
      // Canva-like: when decomposition succeeds, hide the fallback background
      // so only editable objects are visible
      this.backgroundVisible = false;
      this.applyBackground();
    } else if (page.canvasJson) {
      await this.canvas.loadFromJSON(page.canvasJson.canvasData || page.canvasJson);
      this.canvas.requestRenderAll();
    }

    // Re-attach after loading, since clear()/loadFromJSON() drop the background.
    // Only load background for pages WITHOUT decomposed data (pure Level A fallback)
    if (!page.pendingDecomposedData && page.backgroundAssetId) {
      await this.loadBackgroundAsset(page.backgroundAssetId);
    } else if (!page.pendingDecomposedData) {
      this.applyBackground();
    }

    // Honour the current zoom so it carries across pages. Always applied, not
    // just when zoomed: zoom 100% still has to size the backing store for dpr.
    this.applyTransform();
    this._scheduleBackgroundRaster(0);

    this.isHistoryProcessing = false;
    this.history = [];
    this.historyIndex = -1;
    this.recordHistory();
  }

  async loadDecomposedPdf(pageData) {
    this.isHistoryProcessing = true;
    this.canvas.clear();
    this.width = Math.round(pageData.width);
    this.height = Math.round(pageData.height);
    this.canvas.setDimensions({
      width: this.width,
      height: this.height,
    });

    // 1. Add Text Objects with detected font
    if (pageData.textObjects) {
      for (const t of pageData.textObjects) {
        const itext = new IText(t.text, {
          left: t.left,
          top: t.top,
          originX: "left",
          originY: "top",
          fontSize: t.fontSize,
          fontFamily: t.fontFamily || this.currentFont || "sans-serif",
          fill: t.fill || "#1e1e1e",
          cornerColor: "#6366f1",
          cornerStyle: "circle",
          cornerSize: 8,
          transparentCorners: false,
        });
        this.canvas.add(itext);
      }
    }

    // 2. Add Vector Paths / Handwriting Strokes
    if (pageData.pathObjects) {
      for (const p of pageData.pathObjects) {
        try {
          const path = new Path(p.pathData, {
            stroke: p.stroke || null,
            strokeWidth: p.strokeWidth || 1,
            fill: p.fill || "transparent",
            strokeLineCap: "round",
            strokeLineJoin: "round",
            originX: "left",
            originY: "top",
            cornerColor: "#6366f1",
            cornerStyle: "circle",
            cornerSize: 8,
            transparentCorners: false,
          });
          this.canvas.add(path);
        } catch (pathErr) {
          console.warn("Skipping invalid path segment:", pathErr);
        }
      }
    }

    // 3. Add Embedded Images
    if (pageData.imageObjects) {
      for (const imgData of pageData.imageObjects) {
        try {
          const src = imgData.src || (imgData.assetId ? await getAssetUrl(imgData.assetId) : null);
          if (!src) continue;

          const img = await FabricImage.fromURL(src);
          if (imgData.width && img.width) {
            img.scaleToWidth(imgData.width);
          }
          img.set({
            left: imgData.left,
            top: imgData.top,
            originX: "left",
            originY: "top",
            cornerColor: "#6366f1",
            cornerStyle: "circle",
            cornerSize: 8,
            transparentCorners: false,
          });
          this.canvas.add(img);
        } catch (imgErr) {
          console.warn("Skipping image object:", imgErr);
        }
      }
    }

    this.isHistoryProcessing = false;
    this.applyBackground();
    this.canvas.requestRenderAll();
  }

  /**
   * Loads the locked imported-page fallback for this page from the asset store.
   * The image is kept out of the object graph so the eraser and selection skip it.
   */
  async loadBackgroundAsset(assetId) {
    if (!assetId) return;

    const url = await getAssetUrl(assetId);
    if (!url) return;

    const img = await FabricImage.fromURL(url);
    if (!img || !img.width) return;

    img.set({
      left: 0,
      top: 0,
      originX: "left",
      originY: "top",
      selectable: false,
      evented: false,
      hoverCursor: "default",
    });
    img.scaleX = this.width / img.width;
    img.scaleY = this.height / img.height;

    this.backgroundImage = img;
    this.applyBackground();
  }

  /** Re-attaches the fallback layer after any clear() or loadFromJSON() wipes it. */
  applyBackground() {
    if (!this.backgroundImage) return;
    if (this.canvas.backgroundImage !== this.backgroundImage) {
      this.canvas.backgroundImage = this.backgroundVisible ? this.backgroundImage : undefined;
      this.canvas.requestRenderAll();
    }
  }

  /**
   * Remembers which PDF page this canvas came from so the background can be
   * re-rendered from the source instead of magnified from the import snapshot.
   */
  setPdfBackgroundSource(source) {
    this.pdfSource = source && source.assetId ? source : null;
    this._scheduleBackgroundRaster(0);
  }

  /** Marks whether this page is near enough to the viewport to render at full quality. */
  setActivePage(active) {
    const was = this.isActivePage !== false;
    const next = Boolean(active);
    if (next === was) return;
    this.isActivePage = next;
    // Re-render at the higher resolution, and re-rasterize the imported page.
    this.applyTransform();
    if (next) this._scheduleBackgroundRaster(0);
  }

  /** Forces a sharper background at the current zoom (used on page change). */
  refreshBackgroundRaster(delay = 0) {
    this._scheduleBackgroundRaster(delay);
  }

  /**
   * Schedules a sharper re-render of the imported page.
   *
   * Zooming must feel instant, so the viewport transform is applied immediately
   * and only the pixels are deferred — the same two-stage trick Drive uses.
   */
  _scheduleBackgroundRaster(delay = RASTER_DEBOUNCE_MS) {
    if (!this.pdfSource || this.isActivePage === false) return;
    if (this._bgRasterTimer) clearTimeout(this._bgRasterTimer);
    this._bgRasterTimer = setTimeout(() => {
      this._bgRasterTimer = null;
      this._rasterizeBackground();
    }, delay);
  }

  async _rasterizeBackground() {
    if (!this.pdfSource || this._bgRasterBusy) return;

    const targetWidth = Math.round(this.width * this.computeRenderScale());

    // Never replace a sharp background with a softer one, and never re-render
    // for a zoom level that does not actually need more pixels.
    if (this._bgRasterWidth && targetWidth <= this._bgRasterWidth) return;

    this._bgRasterBusy = true;
    const token = ++this._bgRasterToken;

    try {
      const result = await renderPdfPageBlob(
        this.pdfSource.assetId,
        this.pdfSource.pageIndex,
        targetWidth
      );

      // A newer zoom landed while this render was in flight.
      if (!result || token !== this._bgRasterToken || !this.canvas) return;

      const url = URL.createObjectURL(result.blob);
      const img = await FabricImage.fromURL(url);
      if (!img || !img.width) {
        URL.revokeObjectURL(url);
        return;
      }
      if (token !== this._bgRasterToken || !this.canvas) {
        URL.revokeObjectURL(url);
        return;
      }

      img.set({
        left: 0,
        top: 0,
        originX: "left",
        originY: "top",
        selectable: false,
        evented: false,
        hoverCursor: "default",
      });
      img.scaleX = this.width / img.width;
      img.scaleY = this.height / img.height;

      if (this._hiResBgUrl) URL.revokeObjectURL(this._hiResBgUrl);
      this._hiResBgUrl = url;
      this._bgRasterWidth = result.width;

      this.backgroundImage = img;
      this.applyBackground();
      this.canvas.requestRenderAll();
    } catch (err) {
      console.warn("Background re-rasterization failed:", err);
    } finally {
      this._bgRasterBusy = false;
    }
  }

  setBackgroundVisible(visible) {
    this.backgroundVisible = visible;
    if (!visible) {
      this.canvas.backgroundImage = undefined;
    } else if (this.backgroundImage) {
      this.canvas.backgroundImage = this.backgroundImage;
    }
    this.canvas.requestRenderAll();
  }

  /**
   * Viewport zoom. Document coordinates are untouched — Fabric's
   * `setViewportTransform` re-maps the scene so pen input and selection keep
   * working at any scale. `focusX`/`focusY` keep the point under the cursor
   * stationary during wheel zoom.
   */
  setZoom(
    zoom,
    { focusX = null, focusY = null, resetPan = false, force = false, preview = false } = {},
  ) {
    if (this.zoomLocked && !force) return;
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    const oldZ = this.currentZoom;
    this.currentZoom = z;

    if (resetPan) {
      // Explicit zoom changes (buttons, slider, fit) recenter the page.
      this.panX = 0;
      this.panY = 0;
    } else if (focusX !== null && focusY !== null) {
      // Adjust pan so the focus point stays fixed on screen.
      this.panX = focusX - ((focusX - this.panX) / oldZ) * z;
      this.panY = focusY - ((focusY - this.panY) / oldZ) * z;
    }

    this.applyTransform({ preview });
    this.onZoomChange(z);
  }

  /** Applies the pinch target that has accumulated since the last frame. */
  _flushPinch() {
    const pct = this._pinchPendingPct;
    if (pct === null) return;
    // Routed through the app so a pinch gets the same treatment as the slider:
    // same UI sync, same scroll anchoring, same lock.
    if (this.onZoomRequest) this.onZoomRequest(pct, true);
    else this.setZoom(pct / 100, { preview: true });
  }

  /** Ends the gesture: land the final value, then re-render at full quality. */
  _endPinch() {
    this._pinchTimer = null;
    this._pinchAccum = 0;
    if (this._pinchFrame) {
      cancelAnimationFrame(this._pinchFrame);
      this._pinchFrame = null;
    }
    this._flushPinch();
    if (this.onZoomEnd) this.onZoomEnd();
    else this.commitZoomPreview();
  }

  /**
   * Ends a cheap CSS-scaled zoom by re-rendering the backing store at the real
   * resolution. Safe to call when no preview is in flight.
   */
  commitZoomPreview() {
    if (!this._previewActive) return;
    this.applyTransform();
    this.refreshBackgroundRaster();
  }

  /**
   * Device pixels per CSS pixel. Clamped because a fractional or absurd dpr
   * (some Windows setups report 3.5+) would blow the pixel budget instantly.
   */
  _devicePixelRatio() {
    const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    return Math.max(1, Math.min(3, dpr));
  }

  /**
   * Picks the zoom level to actually render at.
   *
   * Ideally this is `zoom * dpr` — one device pixel per screen pixel, which is
   * what makes strokes and text crisp. It is capped so the backing store fits
   * inside the browser's canvas limits.
   *
   * Pages that are not on screen are held at 100%. Every page in a notebook has
   * a live engine, so rendering all of them at the zoomed resolution would cost
   * hundreds of megabytes on a long document for pixels nobody is looking at.
   *
   * @returns {number} device pixels per page unit
   */
  computeRenderScale(zoom = this.currentZoom) {
    const w = Math.max(1, this.width);
    const h = Math.max(1, this.height);
    const dpr = this._devicePixelRatio();
    const effectiveZoom = this.isActivePage === false ? Math.min(zoom, 1) : zoom;

    const byEdge = Math.min(MAX_CANVAS_EDGE / w, MAX_CANVAS_EDGE / h);
    const byArea = Math.sqrt(MAX_CANVAS_PIXELS / (w * h));

    return Math.max(MIN_RENDER_SCALE, Math.min(effectiveZoom * dpr, byEdge, byArea));
  }

  /** Zoom the backing store is rendered at (differs from `currentZoom` when clamped). */
  getRenderZoom() {
    return this.renderZoom;
  }

  /**
   * Applies the current zoom + pan.
   *
   * Two sizes are involved and conflating them is what made zoom blurry:
   *
   *   - the *logical* size Fabric draws into, which sets the backing store
   *     (logical x dpr). This must grow with zoom so the page is re-rendered
   *     at the zoomed resolution rather than upscaled.
   *   - the *CSS* size, which is what the user actually sees.
   *
   * When the pixel budget clamps the render scale these diverge: the canvas is
   * drawn slightly smaller than displayed. Fabric's pointer pipeline divides by
   * the retina factor and multiplies by (backing store / css width), so as long
   * as the viewport transform is expressed in the *logical* scale the two
   * cancel out and hit-testing stays exact at any zoom.
   */
  applyTransform({ preview = false } = {}) {
    const z = this.currentZoom;

    if (preview) {
      /*
       * Cheap path used while a pinch or slider drag is in flight. Only the CSS
       * size changes, so the browser scales the bitmap it already has — no
       * reallocation, no full re-render of every page in the notebook.
       *
       * The trade is a soft page for the duration of the gesture; it snaps to
       * full resolution on `commitZoomPreview`. This is exactly what Google
       * Drive's viewer and Figma do, and it is the difference between a pinch
       * that stutters and one that tracks your fingers.
       */
      this._previewActive = true;
      this.canvas.setDimensions(
        {
          width: Math.max(1, Math.round(this.width * z)),
          height: Math.max(1, Math.round(this.height * z)),
        },
        { cssOnly: true },
      );
      return;
    }
    this._previewActive = false;

    const dpr = this._devicePixelRatio();
    const scale = this.computeRenderScale(z);
    const renderZoom = scale / dpr;

    this.renderZoom = renderZoom;
    this.canvas.viewportTransform = [renderZoom, 0, 0, renderZoom, this.panX, this.panY];
    if (this.canvas.calcViewportBoundaries) this.canvas.calcViewportBoundaries();

    const logicalW = Math.max(1, Math.round(this.width * renderZoom));
    const logicalH = Math.max(1, Math.round(this.height * renderZoom));
    const cssW = Math.max(1, Math.round(this.width * z));
    const cssH = Math.max(1, Math.round(this.height * z));

    // Backstore first (Fabric multiplies by dpr and re-applies the base
    // transform), then CSS, which also sizes the upper canvas and the wrapper.
    this.canvas.setDimensions({ width: logicalW, height: logicalH }, { backstoreOnly: true });
    this.canvas.setDimensions({ width: cssW, height: cssH }, { cssOnly: true });

    this.canvas.requestRenderAll();
    this._scheduleBackgroundRaster();
  }

  hasBackground() {
    return Boolean(this.backgroundImage);
  }

  toJSON() {
    // Deliberately `this.width`/`this.height` (the page), not `canvas.width`
    // (the page scaled by the render zoom). Persisting the latter would bake
    // whatever zoom was active at save time into the notebook.
    return {
      width: this.width,
      height: this.height,
      paperStyle: this.paperStyle,
      canvasData: this.serialize(),
    };
  }

  destroy() {
    if (this._keyboardHandlers) {
      document.removeEventListener("keydown", this._keyboardHandlers.handleKeyDown);
      document.removeEventListener("keyup", this._keyboardHandlers.handleKeyUp);
      this._keyboardHandlers = null;
    }
    if (this._bgRasterTimer) {
      clearTimeout(this._bgRasterTimer);
      this._bgRasterTimer = null;
    }
    if (this._pinchTimer) {
      clearTimeout(this._pinchTimer);
      this._pinchTimer = null;
    }
    if (this._pinchFrame) {
      cancelAnimationFrame(this._pinchFrame);
      this._pinchFrame = null;
    }
    this._pinchPendingPct = null;
    // Invalidate any in-flight render so it cannot resolve after disposal.
    this._bgRasterToken++;
    if (this._hiResBgUrl) {
      URL.revokeObjectURL(this._hiResBgUrl);
      this._hiResBgUrl = null;
    }
    this.canvas.dispose();
  }
}
