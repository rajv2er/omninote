/**
 * Noteful-style zoom window.
 *
 * A magnified strip docked at the bottom of the editor, plus a target box drawn
 * on the page showing where ink actually lands. You write in the strip; the
 * stroke is recorded on the page at full size.
 *
 * The strip owns no content of its own. It is a pixel mirror of the live page
 * canvas (a scaled crop via drawImage), and pointer input is forwarded to the
 * page engine as synthetic events. That means undo/redo, the object graph,
 * persistence and every existing tool keep working exactly as before — there is
 * no second copy of the document to keep in sync.
 */

const STRIP_HEIGHT = 132;

export class ZoomWindow {
  constructor({ stripEl, boxEl }) {
    this.stripEl = stripEl;
    this.ctx = stripEl.getContext("2d");
    this.boxEl = boxEl;

    this.engine = null;
    this.pageEl = null;
    this.visible = false;

    this.pageWidth = 0;
    this.pageHeight = 0;
    this.margin = 28;
    this.box = { x: 0, y: 0, w: 0, h: 0 };

    this._raf = null;
    this._strokeMaxX = null;
    this._dragging = false;
    this._dragOffset = { x: 0, y: 0 };

    this._bindStrip();
    this._bindBox();
  }

  /** Points the window at a page engine and its DOM container. */
  attach(engine, pageEl) {
    this.detach();
    this.engine = engine;
    this.pageEl = pageEl;
    if (engine) {
      this.pageWidth = engine.width;
      this.pageHeight = engine.height;
      this._defaultBox();
    }
    if (this.visible) this._mountBox();
  }

  detach() {
    this._unmountBox();
    this.engine = null;
    this.pageEl = null;
  }

  show() {
    if (this.visible) return;
    this.visible = true;
    this._mountBox();
    this._resizeStrip();
    this._loop();
  }

  hide() {
    this.visible = false;
    this._unmountBox();
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
  }

  destroy() {
    this.hide();
    this.detach();
  }

  // ---------------------------------------------------------------- geometry

  _defaultBox() {
    const stripW = this._stripCssWidth() || 600;
    // A third of the page width gives roughly 3x magnification, which is the
    // sweet spot for handwriting at a normal stroke weight.
    this.box.w = this.pageWidth / 3;
    this.box.h = (this.box.w * STRIP_HEIGHT) / stripW;
    this.box.x = this.margin;
    this.box.y = Math.max(this.margin, this.pageHeight * 0.15);
    this._clampBox();
  }

  _clampBox() {
    this.box.w = Math.min(this.box.w, this.pageWidth);
    this.box.x = Math.max(0, Math.min(this.box.x, this.pageWidth - this.box.w));
    this.box.y = Math.max(0, Math.min(this.box.y, Math.max(0, this.pageHeight - this.box.h)));
  }

  /** Magnification factor: how many strip pixels per page unit. */
  get magnification() {
    const stripW = this._stripCssWidth();
    return stripW && this.box.w ? stripW / this.box.w : 1;
  }

  _stripCssWidth() {
    return this.stripEl.getBoundingClientRect().width || this.stripEl.clientWidth;
  }

  _resizeStrip() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this._stripCssWidth()));
    const h = STRIP_HEIGHT;
    if (this.stripEl.width !== Math.round(w * dpr) || this.stripEl.height !== Math.round(h * dpr)) {
      this.stripEl.width = Math.round(w * dpr);
      this.stripEl.height = Math.round(h * dpr);
    }
  }

  // -------------------------------------------------------------- target box

  _mountBox() {
    if (!this.boxEl || !this.pageEl) return;
    if (this.boxEl.parentElement !== this.pageEl) this.pageEl.appendChild(this.boxEl);
    this.boxEl.hidden = false;
    this._positionBox();
  }

  _unmountBox() {
    if (this.boxEl) this.boxEl.hidden = true;
  }

  _positionBox() {
    const engine = this.engine;
    if (!engine || !this.boxEl) return;
    const z = engine.currentZoom;
    // Page units -> canvas CSS pixels. The canvas element is displayed at
    // width * zoom, and panX/panY live in the same CSS-pixel space.
    this.boxEl.style.left = `${this.box.x * z + engine.panX}px`;
    this.boxEl.style.top = `${this.box.y * z + engine.panY}px`;
    this.boxEl.style.width = `${this.box.w * z}px`;
    this.boxEl.style.height = `${this.box.h * z}px`;
  }

  // ------------------------------------------------------------------ moving

  moveTo(pageX, pageY) {
    this.box.x = pageX - this.box.w / 2;
    this.box.y = pageY - this.box.h / 2;
    this._clampBox();
  }

  nudge(dx, dy = 0) {
    this.box.x += dx;
    this.box.y += dy;
    this._clampBox();
  }

  /** Drops to the next line and returns to the left margin. */
  nextLine() {
    this.box.x = this.margin;
    this.box.y += Math.max(this.box.h * 0.85, 24);
    if (this.box.y + this.box.h > this.pageHeight) {
      this.box.y = Math.max(0, this.pageHeight - this.box.h);
    }
    this._clampBox();
  }

  /**
   * Conveyor-belt advance. If the stroke you just finished reached past the
   * middle of the box, slide the box right by the overshoot so your next
   * stroke starts near the centre again. Wraps to a new line at the margin.
   */
  advanceAfterStroke(strokeMaxX) {
    if (strokeMaxX == null) return;
    const centre = this.box.x + this.box.w / 2;
    if (strokeMaxX <= centre) return;
    const next = this.box.x + (strokeMaxX - centre);
    const rightLimit = this.pageWidth - this.margin - this.box.w;
    if (next > rightLimit) {
      this.nextLine();
    } else {
      this.box.x = next;
      this._clampBox();
    }
  }

  // ---------------------------------------------------------------- rendering

  _loop() {
    if (!this.visible) return;
    this.render();
    this._raf = requestAnimationFrame(() => this._loop());
  }

  render() {
    const engine = this.engine;
    if (!engine || !this.visible) return;
    const src = engine.canvas && engine.canvas.lowerCanvasEl;
    if (!src || !src.width) return;

    this._resizeStrip();

    // The backing store is sized to (page x renderZoom x dpr) for crisp zoom,
    // and `renderZoom` can be clamped below `currentZoom` by the pixel budget.
    // Sample using the render zoom, not the display zoom.
    const z = engine.getRenderZoom ? engine.getRenderZoom() : engine.currentZoom;
    const dpr = src.width / ((engine.width || 1) * (z || 1));
    const sx = (this.box.x * z + engine.panX) * dpr;
    const sy = (this.box.y * z + engine.panY) * dpr;
    const sw = this.box.w * z * dpr;
    const sh = this.box.h * z * dpr;

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.stripEl.width, this.stripEl.height);
    if (sw <= 0 || sh <= 0) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, this.stripEl.width, this.stripEl.height);

    this._positionBox();
  }

  // ------------------------------------------------------------------- input

  _toPage(ev) {
    const rect = this.stripEl.getBoundingClientRect();
    const m = this.magnification;
    return {
      x: this.box.x + (ev.clientX - rect.left) / m,
      y: this.box.y + (ev.clientY - rect.top) / m,
    };
  }

  /**
   * Replays a strip pointer event onto the page canvas so Fabric's own brush,
   * selection and hit testing do the work. Fabric listens for `mouse*` events
   * unless `enablePointerEvents` is set, so pick the matching family.
   */
  _forward(kind, ev) {
    const engine = this.engine;
    if (!engine) return null;
    const upper = engine.canvas.upperCanvasEl;
    if (!upper) return null;

    const rect = upper.getBoundingClientRect();
    const z = engine.currentZoom;
    const p = this._toPage(ev);
    const clientX = rect.left + p.x * z + engine.panX;
    const clientY = rect.top + p.y * z + engine.panY;

    const usePointer = !!engine.canvas.enablePointerEvents;
    const Ctor = usePointer ? PointerEvent : MouseEvent;
    const type = usePointer ? `pointer${kind}` : `mouse${kind}`;
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
      button: 0,
      buttons: kind === "up" ? 0 : 1,
      ctrlKey: ev.ctrlKey,
      shiftKey: ev.shiftKey,
      altKey: ev.altKey,
      metaKey: ev.metaKey,
    };
    if (usePointer) {
      init.pointerId = 1;
      init.isPrimary = true;
      init.pointerType = "mouse";
    }
    const evt = new Ctor(type, init);
    upper.dispatchEvent(evt);
    return p;
  }

  _bindStrip() {
    const el = this.stripEl;

    el.addEventListener("pointerdown", (e) => {
      if (!this.engine || !this.visible) return;
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      this._strokeMaxX = null;
      const p = this._forward("down", e);
      if (p) this._strokeMaxX = p.x;
    });

    el.addEventListener("pointermove", (e) => {
      if (!this.engine || !this.visible) return;
      const p = this._forward("move", e);
      if (p && (this._strokeMaxX == null || p.x > this._strokeMaxX)) this._strokeMaxX = p.x;
    });

    const finish = (e) => {
      if (!this.engine || !this.visible) return;
      this._forward("up", e);
      el.releasePointerCapture?.(e.pointerId);
      this.advanceAfterStroke(this._strokeMaxX);
      this._strokeMaxX = null;
    };
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);
  }

  _bindBox() {
    const el = this.boxEl;
    if (!el) return;

    el.addEventListener("pointerdown", (e) => {
      if (!this.visible || !this.engine) return;
      e.preventDefault();
      e.stopPropagation();
      this._dragging = true;
      const p = this._pagePointFromEvent(e);
      this._dragOffset = { x: p.x - this.box.x, y: p.y - this.box.y };
      el.setPointerCapture?.(e.pointerId);
    });

    el.addEventListener("pointermove", (e) => {
      if (!this._dragging || !this.engine) return;
      const p = this._pagePointFromEvent(e);
      this.box.x = p.x - this._dragOffset.x;
      this.box.y = p.y - this._dragOffset.y;
      this._clampBox();
    });

    const end = (e) => {
      if (!this._dragging) return;
      this._dragging = false;
      el.releasePointerCapture?.(e.pointerId);
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  _pagePointFromEvent(ev) {
    const engine = this.engine;
    const upper = engine.canvas.upperCanvasEl;
    const rect = upper.getBoundingClientRect();
    const z = engine.currentZoom;
    return {
      x: (ev.clientX - rect.left - engine.panX) / z,
      y: (ev.clientY - rect.top - engine.panY) / z,
    };
  }
}
