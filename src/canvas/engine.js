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

    this.onModified = options.onModified || (() => {});
    this.onHistoryChange = options.onHistoryChange || (() => {});
    this.onSelectionChange = options.onSelectionChange || (() => {});

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

    el.addEventListener("pointerdown", (e) => {
      if (this.currentTool === "eraser") {
        this.isEraserDown = true;
        this.performErase(e);
      }
    });

    el.addEventListener("pointermove", (e) => {
      if (this.currentTool === "eraser" && this.isEraserDown) {
        this.performErase(e);
      }
    });

    const finishStroke = () => {
      if (this.currentTool === "eraser") {
        this.isEraserDown = false;
      }
    };

    el.addEventListener("pointerup", finishStroke);
    el.addEventListener("pointercancel", finishStroke);
  }

  recordHistory(triggerModified = true) {
    if (this.isHistoryProcessing) return;

    const state = JSON.stringify(this.canvas.toJSON());
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
    this.canvas.requestRenderAll();
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
    } else if (page.canvasJson) {
      await this.canvas.loadFromJSON(page.canvasJson.canvasData || page.canvasJson);
      this.canvas.requestRenderAll();
    }

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
          const img = await FabricImage.fromURL(imgData.src);
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
    this.canvas.requestRenderAll();
  }

  toJSON() {
    return {
      width: this.canvas.width,
      height: this.canvas.height,
      paperStyle: this.paperStyle,
      canvasData: this.canvas.toJSON(),
    };
  }

  destroy() {
    this.canvas.dispose();
  }
}
