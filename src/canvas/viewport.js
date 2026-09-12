import { MIN_ZOOM, MAX_ZOOM } from "./engine.js";
import { ZoomWindow } from "./zoomWindow.js";
import { icon } from "../ui/icons.js";

export const ZOOM_MIN = MIN_ZOOM;
export const ZOOM_MAX = MAX_ZOOM;
export const ZOOM_STEP = 1.25;

let currentZoom = 1;
let zoomLocked = false;
let zoomWindow = null;
let zoomGestureAnchor = null;

let _getCanvasEngines = () => [];
let _getActiveNote = () => null;
let _getActiveCanvasEngine = () => null;

/**
 * Connects the viewport controller to the application's active state.
 */
export function configureViewport({
  getCanvasEngines,
  getActiveNote,
  getActiveCanvasEngine,
}) {
  if (getCanvasEngines) _getCanvasEngines = getCanvasEngines;
  if (getActiveNote) _getActiveNote = getActiveNote;
  if (getActiveCanvasEngine) _getActiveCanvasEngine = getActiveCanvasEngine;
}

export function getCurrentZoom() {
  return currentZoom;
}

export function setCurrentZoom(z) {
  currentZoom = z;
}

export function isZoomLocked() {
  return zoomLocked;
}

export function getZoomWindow() {
  return zoomWindow;
}

/** Single place that keeps the label, the slider and `currentZoom` in sync. */
export function updateZoomUI(z) {
  currentZoom = z;
  const pct = Math.round(z * 100);
  const value = document.querySelector("#zoom-value");
  // Never overwrite the field while the user is typing into it.
  if (value && document.activeElement !== value) value.value = pct;
  const slider = document.querySelector("#zoom-slider");
  if (slider) slider.value = pct;
}

/** Content-space box of a page wrapper, independent of the current scroll. */
export function pageContentBox(wrap, contRect, container) {
  const r = wrap.getBoundingClientRect();
  return {
    left: r.left - contRect.left + container.scrollLeft,
    top: r.top - contRect.top + container.scrollTop,
    width: r.width,
    height: r.height,
  };
}

/**
 * Remembers which spot of the document a given screen point is showing.
 *
 * Zooming resizes every page, which shifts all the following ones and used to
 * throw the reader's place away. The anchor is stored as *fractions* of the
 * page box it lands on, so it is zoom-invariant: restoring re-measures the page
 * at its new size and puts the same fraction back under the same screen point.
 * Storing raw pixel offsets instead is what made a long pinch drift — every
 * step re-measured its own output and locked in the previous step's error.
 *
 * @param {number|null} clientX screen point to hold still (pinch cursor);
 *   defaults to the middle of the viewport, which is what the slider uses.
 */
export function captureZoomAnchor(clientX = null, clientY = null) {
  const container = document.querySelector("#canvas-scroll-container");
  if (!container) return null;

  const contRect = container.getBoundingClientRect();
  let ox = container.clientWidth / 2;
  let oy = container.clientHeight / 2;
  if (clientX !== null && clientY !== null) {
    const px = clientX - contRect.left;
    const py = clientY - contRect.top;
    // Only trust the cursor when it is actually over the page area; synthetic
    // or off-window events would otherwise anchor to a nonsense point.
    if (px >= 0 && px <= contRect.width && py >= 0 && py <= contRect.height) {
      ox = px;
      oy = py;
    }
  }

  const wraps = Array.from(container.querySelectorAll(".page-container"));
  if (wraps.length === 0) return null;

  const contentX = container.scrollLeft + ox;
  const contentY = container.scrollTop + oy;

  // The page the anchor point is actually over — not necessarily the "active"
  // page, which is only the one the observer last reported.
  let best = null;
  let bestDist = Infinity;
  for (const wrap of wraps) {
    const box = pageContentBox(wrap, contRect, container);
    const overshoot =
      contentY < box.top
        ? box.top - contentY
        : contentY > box.top + box.height
          ? contentY - (box.top + box.height)
          : 0;
    if (overshoot < bestDist) {
      bestDist = overshoot;
      best = { index: Number(wrap.dataset.index ?? 0), box };
    }
  }
  if (!best) return null;

  return {
    container,
    index: best.index,
    fx: best.box.width > 0 ? (contentX - best.box.left) / best.box.width : 0,
    fy: best.box.height > 0 ? (contentY - best.box.top) / best.box.height : 0,
    ox,
    oy,
  };
}

/** Puts the spot captured by `captureZoomAnchor` back under the same screen point. */
export function restoreZoomAnchor(anchor) {
  if (!anchor) return;
  try {
    const { container, index, fx, fy, ox, oy } = anchor;
    const wrap =
      document.querySelector(`#page-wrapper-${index}`) ||
      document.querySelector(".page-container");
    if (!wrap) return;
    const contRect = container.getBoundingClientRect();
    const box = pageContentBox(wrap, contRect, container);

    // The workspace scrolls smoothly, which is lovely for page-to-page jumps
    // but poisonous here: a smooth scroll is an animation, so reading the
    // offset back returns the *old* value and the next event of a pinch
    // restarts it from there. Anchoring has to land in one frame.
    const prevBehavior = container.style.scrollBehavior;
    container.style.scrollBehavior = "auto";
    container.scrollLeft = box.left + fx * box.width - ox;
    container.scrollTop = box.top + fy * box.height - oy;
    container.style.scrollBehavior = prevBehavior;
  } catch {
    // Anchoring is a comfort feature; a bad measurement must never break zoom.
  }
}

/**
 * A pinch is one continuous gesture, so its anchor is measured once when the
 * fingers land and held for the duration. Re-measuring per event made the
 * target drift, because each step anchored to the previous step's result.
 */
export function beginZoomGesture(clientX, clientY) {
  zoomGestureAnchor = captureZoomAnchor(clientX, clientY);
}

export function endZoomGesture() {
  zoomGestureAnchor = null;
  // The gesture was tracked by scaling the existing bitmap so it could keep up
  // with the fingers; now that it has settled, re-render every page at the
  // final resolution so ink and text are crisp again.
  const engines = _getCanvasEngines();
  for (const engine of engines) engine.commitZoomPreview();
}

/**
 * Turns off the browser's own page zoom.
 *
 * By default a trackpad pinch (or Ctrl+scroll, or Cmd +/-) scales the *entire
 * tab* — toolbar, tool rail and panels included — which both wrecks the layout
 * and double-scales the canvas. Only the page should ever zoom, and only via
 * `setZoom`, so every route the browser offers is swallowed here.
 */
export function disableBrowserZoom() {
  // Chrome, Edge and Firefox deliver a trackpad pinch as a burst of ctrl+wheel.
  // `wheel` defaults to passive on window/document/body, so `passive: false`
  // is required for preventDefault to do anything at all.
  window.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    },
    { passive: false },
  );

  // Safari uses real gesture events for a pinch and bypasses wheel entirely.
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    window.addEventListener(type, (e) => e.preventDefault(), {
      passive: false,
    });
  }

  // Two-finger pinch on a touchscreen.
  window.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length > 1) e.preventDefault();
    },
    { passive: false },
  );

  // Keyboard page zoom. This only suppresses the browser default — our own
  // Cmd/Ctrl +/-/0 shortcuts are separate listeners and still fire.
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (
      e.key === "+" ||
      e.key === "=" ||
      e.key === "-" ||
      e.key === "_" ||
      e.key === "0"
    ) {
      e.preventDefault();
    }
  });

  // Belt and braces: browsers that honour the viewport meta will refuse to
  // pinch-zoom the document at all.
  const meta = document.querySelector('meta[name="viewport"]');
  if (meta) {
    meta.setAttribute(
      "content",
      "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no",
    );
  }
}

export function setZoom(
  zoom,
  { reset = false, resetPan = true, force = false, preview = false } = {},
) {
  if (zoomLocked && !force) return;
  const next = reset ? 1 : Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
  // A pinch holds one anchor for the whole gesture; everything else measures
  // fresh each time, which is stable because the anchor is zoom-invariant.
  const anchor = zoomGestureAnchor || captureZoomAnchor();
  updateZoomUI(next);
  const engines = _getCanvasEngines();
  for (const engine of engines) {
    engine.setZoom(next, { resetPan, force, preview });
  }
  restoreZoomAnchor(anchor);
}

/** Toggles the zoom freeze and pushes the state down to every engine. */
export function toggleZoomLock() {
  zoomLocked = !zoomLocked;
  const engines = _getCanvasEngines();
  for (const engine of engines) engine.zoomLocked = zoomLocked;
  const btn = document.querySelector("#zoom-lock-btn");
  if (btn) {
    btn.innerHTML = icon(zoomLocked ? "lockClosed" : "lockOpen", 14);
    btn.title = zoomLocked ? "Zoom locked — click to unlock" : "Lock zoom";
    btn.classList.toggle("is-locked", zoomLocked);
  }
  return zoomLocked;
}

/**
 * Opening zoom. Wide imported pages are the common case, so pull back to fit
 * width — but never zoom past 100%, since magnifying a small page on open is
 * more surprising than helpful.
 */
export function applyDefaultZoom() {
  const engine = _getActiveCanvasEngine();
  const avail = getAvailableViewport();
  if (!engine || !avail || !engine.width) return;
  const fit = avail.width / engine.width;
  const z = Math.min(1, Math.max(ZOOM_MIN, fit));
  if (z < 1) setZoom(z, { force: true });
}

// --------------------------------------------------------------- zoom window

/** Points the zoom window at whichever page is currently active. */
export function attachZoomWindow() {
  if (!zoomWindow) return;
  const note = _getActiveNote();
  if (!note) return;
  const engine = _getActiveCanvasEngine();
  const pageEl = document.querySelector(
    `#page-wrapper-${note.currentPageIndex}`,
  );
  if (!engine || !pageEl) return;
  zoomWindow.attach(engine, pageEl);
}

export function initZoomWindow() {
  const stripEl = document.querySelector("#zw-canvas");
  const boxEl = document.querySelector("#zw-box");
  if (!stripEl || !boxEl) return;
  if (!zoomWindow) zoomWindow = new ZoomWindow({ stripEl, boxEl });
  attachZoomWindow();
}

export function toggleZoomWindow(force) {
  if (!zoomWindow) return;
  const next = force === undefined ? !zoomWindow.visible : force;
  const wrap = document.querySelector("#zoom-window");
  if (next) {
    attachZoomWindow();
    zoomWindow.show();
    if (wrap) wrap.hidden = false;
  } else {
    zoomWindow.hide();
    if (wrap) wrap.hidden = true;
  }
  document.querySelector("#zw-toggle")?.classList.toggle("is-active", next);
}

export function hideZoomWindow() {
  if (zoomWindow) zoomWindow.hide();
}

export function zoomWindowNextLine() {
  if (zoomWindow) zoomWindow.nextLine();
}

export function zoomWindowNudge(direction = 1) {
  if (zoomWindow) zoomWindow.nudge(direction * zoomWindow.box.w * 0.25);
}

export function zoomWindowMoveTo(clientX, clientY) {
  if (!zoomWindow?.visible) return;
  const engine = _getActiveCanvasEngine();
  if (!engine?.canvas?.upperCanvasEl) return;
  const rect = engine.canvas.upperCanvasEl.getBoundingClientRect();
  const z = engine.currentZoom;
  zoomWindow.moveTo(
    (clientX - rect.left - engine.panX) / z,
    (clientY - rect.top - engine.panY) / z,
  );
}


export function zoomIn() {
  setZoom(currentZoom * ZOOM_STEP);
}

export function zoomOut() {
  setZoom(currentZoom / ZOOM_STEP);
}

export function zoomReset() {
  setZoom(1, { reset: true });
}

/**
 * Usable drawing area inside the scroll viewport, excluding its padding.
 * Returns null if the editor is not mounted.
 */
export function getAvailableViewport() {
  const container = document.querySelector("#canvas-scroll-container");
  if (!container) return null;
  const style = getComputedStyle(container);
  const padX =
    (parseFloat(style.paddingLeft) || 0) +
    (parseFloat(style.paddingRight) || 0);
  const padY =
    (parseFloat(style.paddingTop) || 0) +
    (parseFloat(style.paddingBottom) || 0);
  return {
    width: container.clientWidth - padX,
    height: container.clientHeight - padY,
  };
}

/**
 * Fits the active page to the viewport. `"width"` fills the width and lets
 * you scroll vertically; `"page"` fits the whole page on screen at once.
 */
export function zoomFit(mode = "width") {
  const engine = _getActiveCanvasEngine();
  const avail = getAvailableViewport();
  if (!engine || !avail || !engine.width || !engine.height) return;
  const ratioW = avail.width / engine.width;
  const ratioH = avail.height / engine.height;
  setZoom(mode === "page" ? Math.min(ratioW, ratioH) : ratioW, {
    resetPan: true,
  });
}
