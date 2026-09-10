import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.mjs?url";
import { groupPageCandidates } from "./grouping.js";
import { canvasToBlob } from "./canvasBlob.js";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

/**
 * Bumped whenever the shape of `pendingImportData` changes. Old notebooks keep
 * the value they were written with (or none at all) and are migrated additively
 * by `normalizeNote()` — never rewritten in place.
 */
export const IMPORT_SCHEMA_VERSION = 2;
/** Bumped whenever the shape of a single imported object changes. */
export const IMPORTED_OBJECT_VERSION = 1;

/**
 * Normalizes raw PDF font names to clean web/system font names.
 * Strips subset prefixes (e.g. "ABCDEF+Helvetica-Bold" -> "Helvetica").
 */
export function normalizeFontFamily(rawName, fallback = "sans-serif") {
  if (!rawName) return fallback;
  let name = String(rawName).trim();

  // Strip 6-letter subset prefix like "ABCDEF+Helvetica"
  if (name.includes("+")) {
    name = name.split("+")[1];
  }

  // Remove common style suffixes
  const baseName = name
    .replace(/-(Bold|Italic|Regular|BoldItalic|Oblique|Medium|Light|Black|Roman|Semibold)$/i, "")
    .replace(/,(Bold|Italic|Regular|BoldItalic|Oblique|Medium|Light|Black|Roman|Semibold)$/i, "")
    .replace(/PSMT$/i, "")
    .replace(/MT$/i, "")
    .trim();

  const fontMap = {
    TimesNewRoman: "Times New Roman",
    Times: "Times New Roman",
    TimesRoman: "Times New Roman",
    Helvetica: "Helvetica",
    Arial: "Arial",
    Courier: "Courier New",
    CourierNew: "Courier New",
    Georgia: "Georgia",
    Verdana: "Verdana",
    Trebuchet: "Trebuchet MS",
    TrebuchetMS: "Trebuchet MS",
    Palatino: "Palatino",
    Garamond: "Garamond",
    Calibri: "Calibri",
    Cambria: "Cambria",
    Roboto: "Roboto",
    OpenSans: "Open Sans",
    Lato: "Lato",
    Montserrat: "Montserrat",
    SourceSansPro: "Source Sans Pro",
  };

  if (fontMap[baseName]) {
    return fontMap[baseName];
  }

  // Valid recognizable font name
  if (/^[A-Za-z0-9 ]+$/.test(baseName) && baseName.length > 2) {
    return baseName;
  }

  return fallback || "sans-serif";
}

/** Reads the weight/style encoded in a PDF font's name. */
export function readFontStyle(rawName) {
  const name = String(rawName || "");
  const bold = /bold|black|semibold|heavy/i.test(name);
  const italic = /italic|oblique/i.test(name);
  return {
    fontWeight: bold ? "bold" : "normal",
    fontStyle: italic ? "italic" : "normal",
  };
}

/**
 * Multiplies two 2D affine transformation matrices [a, b, c, d, e, f].
 */
function multiplyTransform(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

/**
 * Transforms a 2D point [x, y] using matrix m.
 */
function transformPoint(p, m) {
  return [
    p[0] * m[0] + p[1] * m[2] + m[4],
    p[0] * m[1] + p[1] * m[3] + m[5],
  ];
}

/**
 * Converts RGB components (0-1 or 0-255) to hex string.
 */
function rgbToHex(r, g, b) {
  const toHex = (c) => {
    const numeric = Number(c);
    if (!Number.isFinite(numeric)) return "00";
    const val = Math.max(
      0,
      Math.min(255, Math.round(numeric <= 1 ? numeric * 255 : numeric)),
    );
    return val.toString(16).padStart(2, "0");
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * pdf.js <= 4 exposed RGB channels as three numeric arguments. pdf.js >= 5
 * resolves the colour in the worker and exposes one CSS colour string instead
 * (for example `["#1a1a1a"]`). Accept both representations; never allow an
 * invalid `#NaNNaNNaN` stroke to reach Fabric.
 */
function readPdfColor(args, fallback = "#000000") {
  if (!args) return fallback;

  const first = args[0];
  if (typeof first === "string" && first.trim()) return first.trim();

  if (Array.isArray(first) || ArrayBuffer.isView(first)) {
    return first.length >= 3
      ? rgbToHex(first[0], first[1], first[2])
      : fallback;
  }

  return [args[0], args[1], args[2]].every((value) =>
    Number.isFinite(Number(value)),
  )
    ? rgbToHex(args[0], args[1], args[2])
    : fallback;
}

/**
 * Same as readPdfColor but for an [r,g,b] triple from an annotation.
 *
 * pdf.js hands annotation colours back either as an array or as an
 * array-like object with numeric keys, always in the 0-255 range.
 */
function rgbArrayToHex(triple, fallback = "#000000") {
  if (!triple) return fallback;
  const [r, g, b] = [triple[0], triple[1], triple[2]];
  if (![r, g, b].every((v) => Number.isFinite(Number(v)))) return fallback;
  return rgbToHex(r, g, b);
}

/**
 * pdf.js streams image bytes over from the worker *after* the operator list
 * resolves, so `page.objs.has(id)` is false during the scan and calling
 * `get()` early throws. Poll instead — a page with a slow image is worth
 * waiting for, but a missing one must not hang the whole import.
 */
async function waitForImageObject(page, id, timeoutMs = 4000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      if (page.objs && page.objs.has(id)) return page.objs.get(id);
      if (page.commonObjs && page.commonObjs.has(id)) return page.commonObjs.get(id);
    } catch {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return null;
}

/** Longest edge for the fallback background. Keeps a full page legible without huge files. */
const BACKGROUND_MAX_EDGE = 1600;
/** Longest edge for the library thumbnail. */
const THUMBNAIL_MAX_EDGE = 320;

/** Reverse lookup so warnings can name the operator instead of a bare number. */
function buildOpNames() {
  const names = {};
  for (const [key, value] of Object.entries(pdfjs.OPS || {})) {
    if (typeof value === "number" && names[value] === undefined) names[value] = key;
  }
  return names;
}

/**
 * Operators whose content we deliberately leave in the fallback.
 *
 * These are cases where promoting half-understood geometry would produce
 * objects that look wrong and cannot be fixed by the user — worse than a
 * locked picture of the page.
 */
const UNSUPPORTED_OPS = new Set(["shadingFill", "paintImageMaskXObject", "paintSolidColorImageMask"]);

/**
 * Annotation subtypes that are interaction targets rather than page content.
 *
 * pdf.js draws these as HTML overlays, never into the canvas, so a page cannot
 * lose any ink by treating them as unrecovered. Marking a page `partial` for a
 * hyperlink would be a false alarm that costs the user the clean render.
 */
const NON_VISUAL_ANNOTATIONS = new Set([
  "LINK",
  "POPUP",
  "SCREEN",
  "FILEATTACHMENT",
  "SOUND",
  "MOVIE",
  "PRINTERMARK",
  "TRAPNET",
  "WATERMARK",
  "THREED",
  "RICHMEDIA",
]);

/**
 * pdf.js `AnnotationType` value -> name, built once from the library so the
 * mapping cannot drift if the enum changes.
 */
const ANNOTATION_TYPE_NAMES = (() => {
  const names = {};
  for (const [key, value] of Object.entries(pdfjs.AnnotationType || {})) {
    names[value] = key;
  }
  return names;
})();

/** Reads pixels out of whatever shape pdf.js handed us for an image. */
function imageObjectToBlob(imgObj, width, height) {
  if (!imgObj || typeof document === "undefined") return null;

  try {
    if (imgObj.bitmap) {
      const canvas = document.createElement("canvas");
      canvas.width = imgObj.width || width;
      canvas.height = imgObj.height || height;
      canvas.getContext("2d").drawImage(imgObj.bitmap, 0, 0);
      return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    }

    const src = imgObj.data;
    if (!src) return null;

    const w = imgObj.width || width;
    const h = imgObj.height || height;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    const imgData = ctx.createImageData(w, h);
    const dst = imgData.data;

    // pdf.js hands back RGB, RGBA, or (rarely) a single-channel buffer.
    if (src.length === w * h * 4) {
      dst.set(src);
    } else if (src.length === w * h * 3) {
      let s = 0;
      let d = 0;
      while (s < src.length) {
        dst[d] = src[s];
        dst[d + 1] = src[s + 1];
        dst[d + 2] = src[s + 2];
        dst[d + 3] = 255;
        s += 3;
        d += 4;
      }
    } else if (src.length === w * h) {
      for (let i = 0; i < src.length; i++) {
        const v = src[i];
        dst[i * 4] = v;
        dst[i * 4 + 1] = v;
        dst[i * 4 + 2] = v;
        dst[i * 4 + 3] = 255;
      }
    } else {
      return null;
    }

    ctx.putImageData(imgData, 0, 0);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  } catch {
    return null;
  }
}

/**
 * Decomposes a single PDF page into classified native candidates.
 *
 * Scale 1.333333 converts PDF 72 DPI points to standard 96 DPI CSS pixels, so
 * every coordinate here is page space with a top-left origin. Nothing in the
 * returned data depends on the on-screen zoom, pan, or device pixel ratio.
 *
 * The returned `candidates` are deliberately un-grouped: grouping is a
 * separate, heuristic step (see `grouping.js`) so it can be tuned and tested
 * on its own.
 *
 * @param {object} [options]
 * @param {boolean} [options.extract] When false, only the page raster and
 *   thumbnail are produced — no content-stream walk at all. This is the
 *   "annotate the PDF" path: the original document stays the document, so a
 *   large file costs its own size rather than several times that in recovered
 *   objects. It is also far faster, because `getOperatorList()` is what reads
 *   the whole content stream.
 */
export async function decomposePage(page, scale = 1.333333, options = {}) {
  const extract = options.extract !== false;

  const viewport = page.getViewport({ scale });
  const width = Math.round(viewport.width);
  const height = Math.round(viewport.height);

  const candidates = [];
  const warnings = [];
  const unsupported = { operators: {}, annotations: [], images: 0 };
  const fontUsage = {};
  const opNames = buildOpNames();

  let opList = null;

  if (extract) {
    try {
      opList = await page.getOperatorList();
    } catch (e) {
      warnings.push("operator-list-unavailable");
      console.warn("Could not load operator list:", e);
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Operator stream: vectors, images, and the text colours in use.
  // ---------------------------------------------------------------------------

  /** Fill colours seen at each text-showing operator, in content order. */
  let textFills = [];
  let pendingPathSegments = [];

  if (opList) {
    try {
      const OPS = pdfjs.OPS;
      // pdf.js packs sub-path commands into a compact DrawOPS enum that is
      // deliberately distinct from OPS: moveTo is 13 in OPS but 0 in DrawOPS.
      // Comparing sub-path commands against OPS silently matches nothing.
      const DRAW = {
        moveTo: 0,
        lineTo: 1,
        curveTo: 2,
        quadraticCurveTo: 3,
        closePath: 4,
      };

      let matrixStack = [];
      let currentMatrix = [1, 0, 0, 1, 0, 0];
      let strokeColor = "#000000";
      let fillColor = "#000000";
      let lineWidth = 2;
      let lineCap = "round";
      let lineJoin = "round";
      let strokeAlpha = 1;
      let fillAlpha = 1;
      let formDepth = 0;

      const toViewportWith = (matrix, x, y) => {
        const [px, py] = transformPoint([x, y], matrix);
        return viewport.convertToViewportPoint(px, py);
      };

      const toViewport = (x, y) => toViewportWith(currentMatrix, x, y);

      /**
       * Turns sub-path commands into SVG path data, tracking the bounding box
       * as it goes. Grouping needs the box to test spatial proximity, and
       * computing it here avoids re-parsing the string later.
       */
      const buildPathData = (flat) => {
        const svgParts = [];
        const f = (n) => Number(n).toFixed(1);
        let k = 0;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        const seen = [];

        const track = (vx, vy) => {
          seen.push(vx, vy);
          if (vx < minX) minX = vx;
          if (vy < minY) minY = vy;
          if (vx > maxX) maxX = vx;
          if (vy > maxY) maxY = vy;
        };

        while (k < flat.length) {
          const sub = flat[k++];
          if (sub === DRAW.moveTo) {
            const [vx, vy] = toViewport(flat[k], flat[k + 1]);
            k += 2;
            track(vx, vy);
            svgParts.push(`M ${f(vx)} ${f(vy)}`);
          } else if (sub === DRAW.lineTo) {
            const [vx, vy] = toViewport(flat[k], flat[k + 1]);
            k += 2;
            track(vx, vy);
            svgParts.push(`L ${f(vx)} ${f(vy)}`);
          } else if (sub === DRAW.curveTo) {
            const [c1x, c1y] = toViewport(flat[k], flat[k + 1]);
            const [c2x, c2y] = toViewport(flat[k + 2], flat[k + 3]);
            const [vx, vy] = toViewport(flat[k + 4], flat[k + 5]);
            k += 6;
            track(c1x, c1y);
            track(c2x, c2y);
            track(vx, vy);
            svgParts.push(
              `C ${f(c1x)} ${f(c1y)}, ${f(c2x)} ${f(c2y)}, ${f(vx)} ${f(vy)}`
            );
          } else if (sub === DRAW.quadraticCurveTo) {
            const [cx, cy] = toViewport(flat[k], flat[k + 1]);
            const [vx, vy] = toViewport(flat[k + 2], flat[k + 3]);
            k += 4;
            track(cx, cy);
            track(vx, vy);
            svgParts.push(`Q ${f(cx)} ${f(cy)}, ${f(vx)} ${f(vy)}`);
          } else if (sub === DRAW.closePath) {
            svgParts.push("Z");
          } else {
            // An unknown command would desync the coordinate cursor, so stop.
            break;
          }
        }

        if (svgParts.length === 0) return null;

        return {
          pathData: svgParts.join(" "),
          bbox: seen.length
            ? { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
            : { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
        };
      };

      /** Normalises either pdf.js args shape into a flat DrawOPS array. */
      const toFlatDrawOps = (args) => {
        if (typeof args[0] === "number") {
          // pdf.js >= 5: [paintOp, drawOps, minMax?]. The command buffer is not
          // stable in shape — it is sometimes a plain array and sometimes a
          // typed array wrapped in an array — so unwrap until we reach a plain
          // sequence of numbers.
          let cur = args[1];
          for (let depth = 0; depth < 3; depth++) {
            if (!cur || typeof cur !== "object") return null;
            if (typeof cur[0] === "number") return cur;
            cur = cur[0];
          }
          return null;
        }
        // pdf.js < 5: [ops[], coords[]]
        if (!Array.isArray(args[0])) return null;

        const ops = args[0];
        const coords = Array.isArray(args[1]) ? args[1] : [];
        const flat = [];
        let c = 0;

        for (const subOp of ops) {
          if (subOp === OPS.moveTo) {
            flat.push(DRAW.moveTo, coords[c], coords[c + 1]);
            c += 2;
          } else if (subOp === OPS.lineTo) {
            flat.push(DRAW.lineTo, coords[c], coords[c + 1]);
            c += 2;
          } else if (subOp === OPS.curveTo) {
            flat.push(
              DRAW.curveTo,
              coords[c], coords[c + 1],
              coords[c + 2], coords[c + 3],
              coords[c + 4], coords[c + 5]
            );
            c += 6;
          } else if (subOp === OPS.curveTo2 || subOp === OPS.curveTo3) {
            // `v` and `y` are both quadratics: one control point, one endpoint.
            flat.push(
              DRAW.quadraticCurveTo,
              coords[c], coords[c + 1],
              coords[c + 2], coords[c + 3]
            );
            c += 4;
          } else if (subOp === OPS.closePath) {
            flat.push(DRAW.closePath);
          } else if (subOp === OPS.rectangle) {
            const [rx, ry, rw, rh] = [
              coords[c], coords[c + 1], coords[c + 2], coords[c + 3],
            ];
            c += 4;
            flat.push(
              DRAW.moveTo, rx, ry,
              DRAW.lineTo, rx + rw, ry,
              DRAW.lineTo, rx + rw, ry + rh,
              DRAW.lineTo, rx, ry + rh,
              DRAW.closePath
            );
          } else {
            break;
          }
        }

        return flat;
      };

      /** Image placements captured during the scan, resolved afterwards. */
      const pendingImages = [];

      /** Style signature used as grouping evidence: same look, same stroke. */
      const styleKey = () =>
        [strokeColor, fillColor, lineWidth, lineCap, lineJoin].join("|");

      const emitPath = (built, paintOp, seq) => {
        if (!built) return;

        const isStrokeOp =
          paintOp === OPS.stroke ||
          paintOp === OPS.closeStroke ||
          paintOp === OPS.fillStroke ||
          paintOp === OPS.eoFillStroke ||
          paintOp === OPS.closeFillStroke ||
          paintOp === OPS.closeEOFillStroke;

        const isFillOp =
          paintOp === OPS.fill ||
          paintOp === OPS.eoFill ||
          paintOp === OPS.fillStroke ||
          paintOp === OPS.eoFillStroke ||
          paintOp === OPS.closeFillStroke ||
          paintOp === OPS.closeEOFillStroke;

        if (!isStrokeOp && !isFillOp) {
          // Modern pdf.js carries the paint op inside constructPath, so any
          // other op here is a clipping path — it must not leak into a later
          // stroke. Only defer when the op genuinely did not say how to paint.
          if (paintOp === null) pendingPathSegments.push(built);
          return;
        }

        candidates.push({
          kind: "path",
          pathData: built.pathData,
          bbox: built.bbox,
          stroke: isStrokeOp ? strokeColor : null,
          strokeWidth: isStrokeOp ? lineWidth : 0,
          fill: isFillOp ? fillColor : "transparent",
          strokeLineCap: lineCap,
          strokeLineJoin: lineJoin,
          opacity: Math.min(isStrokeOp ? strokeAlpha : 1, isFillOp ? fillAlpha : 1),
          styleKey: styleKey(),
          seq,
          // Geometry inside a form XObject is not independently addressable,
          // so it is weaker grouping evidence than top-level page content.
          nested: formDepth > 0,
        });
      };

      const flushPending = (mode, seq) => {
        if (pendingPathSegments.length === 0) return;

        // Pending segments were produced by older pdf.js, which emits the path
        // and the paint op separately.
        const pathData = pendingPathSegments.map((p) => p.pathData).join(" ");
        const box = pendingPathSegments.reduce(
          (acc, p) => ({
            minX: Math.min(acc.minX, p.bbox.minX),
            minY: Math.min(acc.minY, p.bbox.minY),
            maxX: Math.max(acc.maxX, p.bbox.maxX),
            maxY: Math.max(acc.maxY, p.bbox.maxY),
          }),
          { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
        );
        const bbox = { ...box, width: box.maxX - box.minX, height: box.maxY - box.minY };

        candidates.push({
          kind: "path",
          pathData,
          bbox,
          stroke: mode === "fill" ? null : strokeColor,
          strokeWidth: mode === "fill" ? 0 : lineWidth,
          fill: mode === "fill" ? fillColor : "transparent",
          strokeLineCap: lineCap,
          strokeLineJoin: lineJoin,
          opacity: 1,
          styleKey: styleKey(),
          seq,
          nested: formDepth > 0,
        });
        pendingPathSegments = [];
      };

      const recordImage = async (imgObj, matrix, seq) => {
        // A PDF image is the unit square with its origin at the bottom-left.
        // Its *top-left* on screen is unit (0,1); taking the axis-aligned
        // bounding box instead would silently straighten every rotated or
        // skewed image.
        const topLeft = toViewportWith(matrix, 0, 1);
        const topRight = toViewportWith(matrix, 1, 1);
        const bottomLeft = toViewportWith(matrix, 0, 0);

        const imgWidth = Math.hypot(
          topRight[0] - topLeft[0],
          topRight[1] - topLeft[1],
        );
        const imgHeight = Math.hypot(
          bottomLeft[0] - topLeft[0],
          bottomLeft[1] - topLeft[1],
        );

        // Fabric's positive `angle` is clockwise on screen, which is exactly
        // what the screen-space direction of the image's top edge gives.
        const angle =
          (Math.atan2(topRight[1] - topLeft[1], topRight[0] - topLeft[0]) *
            180) /
          Math.PI;

        // A degenerate placement means the matrix was misunderstood; keep the
        // page's fallback rather than emitting a zero-size object.
        if (!(imgWidth > 1) || !(imgHeight > 1)) {
          unsupported.images++;
          warnings.push("image-placement-unresolved");
          return;
        }

        const blob = await imageObjectToBlob(imgObj, imgWidth, imgHeight);
        if (!blob) {
          unsupported.images++;
          warnings.push("image-bytes-unavailable");
          return;
        }

        candidates.push({
          kind: "image",
          blob,
          naturalWidth: imgObj.width || Math.round(imgWidth),
          naturalHeight: imgObj.height || Math.round(imgHeight),
          left: Math.round(topLeft[0]),
          top: Math.round(topLeft[1]),
          width: Math.round(imgWidth),
          height: Math.round(imgHeight),
          angle: Math.round(angle * 100) / 100,
          seq,
        });
      };

      for (let i = 0; i < opList.fnArray.length; i++) {
        const fn = opList.fnArray[i];
        const args = opList.argsArray[i];


        // One malformed operator must never abort extraction for the rest of
        // the page — that is how images used to vanish along with the strokes.
        try {
          switch (fn) {
            case OPS.save:
              matrixStack.push({
                matrix: [...currentMatrix],
                strokeColor,
                fillColor,
                lineWidth,
                lineCap,
                lineJoin,
                strokeAlpha,
                fillAlpha,
              });
              break;

            case OPS.restore: {
              const state = matrixStack.pop();
              if (state) {
                currentMatrix = state.matrix;
                strokeColor = state.strokeColor;
                fillColor = state.fillColor;
                lineWidth = state.lineWidth;
                lineCap = state.lineCap;
                lineJoin = state.lineJoin;
                strokeAlpha = state.strokeAlpha;
                fillAlpha = state.fillAlpha;
              }
              break;
            }

            case OPS.transform:
              // PDF `cm` concatenates as CTM_new = M * CTM_old. pdf.js may emit
              // one `cm` per component (a translate op then a scale op), so the
              // order matters: multiplying the other way round scales the
              // translation too and throws images far off the page.
              currentMatrix = multiplyTransform(args, currentMatrix);
              break;

            case OPS.setLineWidth:
              lineWidth = Math.max(1, Math.round(args[0] * scale));
              break;

            case OPS.setLineCap:
              lineCap = ["butt", "round", "square"][args[0]] || "round";
              break;

            case OPS.setLineJoin:
              lineJoin = ["miter", "round", "bevel"][args[0]] || "round";
              break;

            case OPS.setStrokeRGBColor:
              strokeColor = readPdfColor(args, strokeColor);
              strokeAlpha = 1;
              break;

            case OPS.setFillRGBColor:
              fillColor = readPdfColor(args, fillColor);
              fillAlpha = 1;
              break;

            case OPS.setStrokeTransparent:
              strokeColor = "transparent";
              break;

            case OPS.setFillTransparent:
              fillColor = "transparent";
              break;

            case OPS.setGState: {
              // Transparency lives in an ExtGState object, not in the op args.
              const name = Array.isArray(args[0]) ? args[0][0] : args[0];
              const gstate =
                (page.commonObjs && name && page.commonObjs.has(name) && page.commonObjs.get(name)) ||
                null;
              if (gstate && Number.isFinite(Number(gstate.fillAlpha))) {
                fillAlpha = Number(gstate.fillAlpha);
              }
              if (gstate && Number.isFinite(Number(gstate.strokeAlpha))) {
                strokeAlpha = Number(gstate.strokeAlpha);
              }
              break;
            }

            case OPS.constructPath: {
              // pdf.js >= 5: [paintOp, drawOps, minMax?]  — paintOp is a NUMBER.
              // pdf.js <  5: [ops[], coords[]]            — args[0] is an array.
              // Reading args[0] as the sub-path list throws "ops is not iterable"
              // on modern pdf.js, which used to kill every stroke and image.
              const flat = toFlatDrawOps(args);
              if (!flat) break;

              const paintOp = typeof args[0] === "number" ? args[0] : null;
              emitPath(buildPathData(flat), paintOp, i);
              break;
            }

            case OPS.stroke:
            case OPS.closeStroke:
              flushPending("stroke", i);
              break;

            case OPS.fill:
            case OPS.eoFill:
              flushPending("fill", i);
              break;

            case OPS.paintFormXObjectBegin:
              formDepth++;
              break;

            case OPS.paintFormXObjectEnd:
              formDepth = Math.max(0, formDepth - 1);
              break;

            case OPS.paintImageXObject:
              // The bytes arrive after the operator list, so only the id and
              // the matrix at paint time can be captured here.
              pendingImages.push({
                id: args[0],
                matrix: [...currentMatrix],
                seq: i,
              });
              break;

            case OPS.paintInlineImageXObject:
              // BI … ID … EI: the image data rides along with the operator
              // instead of living in an XObject, so it is already available.
              pendingImages.push({
                inline: args[0],
                matrix: [...currentMatrix],
                seq: i,
              });
              break;

            case OPS.showText:
            case OPS.showSpacedText:
              // Remember the fill colour in use for each text run. pdf.js does
              // not expose colour on text content items, so this is the only
              // way to recover it.
              textFills.push(fillColor);
              break;

            default: {
              const name = opNames[fn];
              if (name && UNSUPPORTED_OPS.has(name)) {
                unsupported.operators[name] = (unsupported.operators[name] || 0) + 1;
              }
              break;
            }
          }
        } catch (opErr) {
          warnings.push("operator-skipped");
          console.warn("Skipping unparsable PDF operator:", fn, opErr);
        }
      }
      // Image bytes are streamed in after the operator list resolves, so they
      // are fetched now, using the matrix that was current at paint time.
      for (const item of pendingImages) {
        try {
          const imgObj = item.inline || (await waitForImageObject(page, item.id));
          if (!imgObj || !(imgObj.data || imgObj.src || imgObj.bitmap)) {
            unsupported.images++;
            warnings.push("image-bytes-unavailable");
            continue;
          }
          await recordImage(imgObj, item.matrix, item.seq);
        } catch (imgErr) {
          unsupported.images++;
          warnings.push("image-extraction-failed");
          console.warn("Could not extract image XObject:", imgErr);
        }
      }
    } catch (err) {
      warnings.push("operator-stream-failed");
      console.warn("Failed to parse operator stream:", err);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Text runs, grouped into lines without merging separate columns.
  // ---------------------------------------------------------------------------

  const textObjects = [];

  // `if (extract)` on the try is deliberate: the whole block is skipped in
  // annotations mode rather than re-indented, so the diff stays readable.
  if (extract)
  try {
    const textContent = await page.getTextContent();

    // Only trust a recovered colour when every text run on the page agrees;
    // a single ambiguous colour is worse than the neutral default.
    const uniqueFills = Array.from(new Set(textFills));
    const pageTextFill = uniqueFills.length === 1 ? uniqueFills[0] : "#1e1e1e";
    if (uniqueFills.length > 1) warnings.push("text-colour-approximated");

    let currentLine = null;

    const flushLine = () => {
      if (currentLine) textObjects.push(currentLine);
      currentLine = null;
    };

    for (const item of textContent.items) {
      if (!item.str || item.str.trim() === "") continue;

      let rawFontName = null;
      let fallbackFamily = "sans-serif";

      if (page.commonObjs && page.commonObjs.has(item.fontName)) {
        const fontObj = page.commonObjs.get(item.fontName);
        rawFontName = fontObj?.name || fontObj?.loadedName;
        fallbackFamily = fontObj?.fallbackName || "sans-serif";
      }

      if (!rawFontName && textContent.styles && textContent.styles[item.fontName]) {
        const style = textContent.styles[item.fontName];
        rawFontName = style.fontFamily || style.fontSubstitution;
        fallbackFamily = style.fontFamily || "sans-serif";
      }

      const resolvedFont = normalizeFontFamily(rawFontName, fallbackFamily);
      const { fontWeight, fontStyle } = readFontStyle(rawFontName);

      const textLen = item.str.trim().length;
      fontUsage[resolvedFont] = (fontUsage[resolvedFont] || 0) + textLen;

      const [a, b, , d, e, f] = item.transform;
      const fontSize = Math.max(1, Math.hypot(a, b) * scale);

      // PDF y grows upward and the viewport flips it, so a rotation that is
      // counter-clockwise in PDF space reads as the negated angle to Fabric,
      // whose positive `angle` is clockwise on screen.
      const angle = -Math.atan2(b, a) * (180 / Math.PI);

      const [vx, vy] = viewport.convertToViewportPoint(e, f);
      const itemWidth = (item.width || item.str.length * (fontSize * 0.55)) * scale;
      const top = Math.max(0, vy - fontSize);

      const run = {
        kind: "text",
        text: item.str,
        left: Math.round(vx),
        top: Math.round(top),
        baseline: Math.round(vy),
        fontSize: Math.round(fontSize * 10) / 10,
        fontFamily: resolvedFont,
        fontWeight,
        fontStyle,
        fill: pageTextFill,
        angle: Math.round(angle * 100) / 100,
        sourceFontName: rawFontName || null,
        width: Math.round(itemWidth),
        height: Math.round(fontSize * 1.25),
      };

      const sameLine =
        currentLine &&
        Math.abs(currentLine.top - run.top) < fontSize * 0.45 &&
        Math.abs(currentLine.angle - run.angle) < 0.5 &&
        Math.abs(currentLine.fontSize - run.fontSize) < Math.max(1, fontSize * 0.2) &&
        run.left >= currentLine.left &&
        // Anything further apart than two characters' width is a new column or
        // a new text box, not the continuation of this run.
        run.left - (currentLine.left + currentLine.width) < fontSize * 2.0 &&
        currentLine.fontFamily === run.fontFamily;

      if (sameLine) {
        const gap = run.left - (currentLine.left + currentLine.width);
        currentLine.text += (gap > fontSize * 0.18 ? " " : "") + item.str;
        currentLine.width = run.left + run.width - currentLine.left;
      } else {
        flushLine();
        currentLine = { ...run };
      }
    }
    flushLine();

    for (const t of textObjects) candidates.push(t);
  } catch (err) {
    warnings.push("text-extraction-failed");
    console.warn("Failed to extract text content:", err);
  }

  // ---------------------------------------------------------------------------
  // 3. Display annotations.
  // ---------------------------------------------------------------------------

  // Annotations that can become native objects, held back until we know
  // whether the fallback raster can be rendered without annotation ink.
  const promotableAnnotations = [];
  const annotationsKeptInImage = [];
  const nonVisualAnnotations = [];

  /**
   * True when the fallback must be rendered *without* annotations.
   *
   * `page.render()` draws annotation appearances into the canvas. Promoting an
   * Ink or FreeText annotation while also rendering it into the fallback paints
   * the same ink twice, which reads as a bolder, blurred stroke. So annotations
   * are only promoted when every remaining annotation is non-visual — at which
   * point suppressing them in the raster loses nothing.
   */
  let suppressAnnotationsInFallback = false;

  // In annotations mode every annotation stays in the raster — nothing is
  // promoted, so there is nothing to double up and nothing to suppress.
  if (extract)
  try {
    const annotations = await page.getAnnotations({ intent: "display" });

    for (const annot of annotations || []) {
      // pdf.js reports `annotationType` as a number and, helpfully, also
      // exposes the string subtype. Prefer the string; fall back to the enum.
      const subtype = (
        annot.subtype ||
        ANNOTATION_TYPE_NAMES[annot.annotationType] ||
        ""
      ).toUpperCase();

      if (!subtype) continue;

      if (subtype === "INK") {
        // InkList is a list of strokes, each a list of points, in PDF space.
        const strokes = annot.inkLists || [];
        const parts = [];
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        for (const stroke of strokes) {
          if (!Array.isArray(stroke) || stroke.length === 0) continue;
          stroke.forEach((pt, idx) => {
            const [vx, vy] = viewport.convertToViewportPoint(pt.x, pt.y);
            if (vx < minX) minX = vx;
            if (vy < minY) minY = vy;
            if (vx > maxX) maxX = vx;
            if (vy > maxY) maxY = vy;
            parts.push(`${idx === 0 ? "M" : "L"} ${vx.toFixed(1)} ${vy.toFixed(1)}`);
          });
        }

        if (parts.length) {
          promotableAnnotations.push({
            kind: "path",
            pathData: parts.join(" "),
            bbox: {
              minX, minY, maxX, maxY,
              width: maxX - minX,
              height: maxY - minY,
            },
            stroke: rgbArrayToHex(annot.color, "#1e1e1e"),
            strokeWidth: Math.max(1, Math.round((annot.borderWidth || 1) * scale)),
            fill: "transparent",
            strokeLineCap: "round",
            strokeLineJoin: "round",
            opacity: 1,
            styleKey: `ink|${rgbArrayToHex(annot.color, "#1e1e1e")}`,
            seq: Number.MAX_SAFE_INTEGER - 1,
            nested: false,
            fromAnnotation: "Ink",
          });
        }
        continue;
      }

      if (subtype === "FREETEXT") {
        const rect = annot.rect;
        // pdf.js 6 exposes the text as `contentsObj.str`; older versions used a
        // plain `contents` string. Accept both.
        const contents = String(
          annot.contentsObj?.str ?? annot.contents ?? "",
        ).trim();
        if (rect && contents) {
          // rect is [x1, y1, x2, y2] in PDF space (y1 < y2).
          const [vx1, vy1] = viewport.convertToViewportPoint(rect[0], rect[3]);
          const [vx2, vy2] = viewport.convertToViewportPoint(rect[2], rect[1]);
          const appearance = annot.defaultAppearanceData || {};
          const fontSize = Math.max(
            8,
            (annot.fontSize || appearance.fontSize || 12) * scale,
          );

          promotableAnnotations.push({
            kind: "text",
            text: contents,
            left: Math.round(vx1),
            top: Math.round(vy1),
            baseline: Math.round(vy1 + fontSize),
            fontSize: Math.round(fontSize * 10) / 10,
            fontFamily: "Helvetica",
            fontWeight: "normal",
            fontStyle: "normal",
            fill: rgbArrayToHex(
              annot.fontColor || appearance.fontColor,
              "#1e1e1e",
            ),
            angle: 0,
            sourceFontName: null,
            width: Math.round(vx2 - vx1),
            height: Math.round(vy2 - vy1),
            fromAnnotation: "FreeText",
          });
        }
        continue;
      }

      // Two ways an annotation can be invisible: it is an interaction target
      // (link, popup), or it has no appearance stream for pdf.js to draw.
      //
      // `hasAppearance` is only consulted for these non-promotable types. Ink
      // and FreeText also report no appearance, yet pdf.js synthesises one from
      // their own properties and does draw them — which is why they are handled
      // above and never reach this test.
      if (NON_VISUAL_ANNOTATIONS.has(subtype) || annot.hasAppearance === false) {
        nonVisualAnnotations.push(subtype);
        continue;
      }

      // A stamp, highlight or form field *is* visible. It stays in the fallback,
      // and its presence keeps the page partial.
      annotationsKeptInImage.push(subtype);
    }

    suppressAnnotationsInFallback =
      annotationsKeptInImage.length === 0 && promotableAnnotations.length > 0;

    if (suppressAnnotationsInFallback) {
      candidates.push(...promotableAnnotations);
    }
    // Otherwise the annotations stay in the raster and the promotable ones are
    // deliberately not promoted, so nothing is drawn twice.
    unsupported.annotations = annotationsKeptInImage;
  } catch (err) {
    warnings.push("annotation-scan-failed");
    console.warn("Failed to read page annotations:", err);
  }

  // ---------------------------------------------------------------------------
  // 4. Fallback background snapshot + library thumbnail, both as compact blobs.
  //    These stay binary all the way to IndexedDB; they are never base64 in
  //    localStorage.
  // ---------------------------------------------------------------------------

  let backgroundBlob = null;
  let thumbnailBlob = null;

  try {
    if (typeof document !== "undefined") {
      const bgFactor = Math.min(1, BACKGROUND_MAX_EDGE / Math.max(width, height));
      const bgViewport = page.getViewport({ scale: scale * bgFactor });

      const bgCanvas = document.createElement("canvas");
      bgCanvas.width = Math.max(1, Math.round(bgViewport.width));
      bgCanvas.height = Math.max(1, Math.round(bgViewport.height));

      await page.render({
        canvasContext: bgCanvas.getContext("2d"),
        viewport: bgViewport,
        // Annotations are drawn into the raster by default — that is what keeps
        // a page whose ink lives in annotations from losing it. They are only
        // suppressed when every annotation was promoted to a native object, so
        // the same ink is never painted twice.
        annotationMode: suppressAnnotationsInFallback
          ? (pdfjs.AnnotationMode?.DISABLE ?? 0)
          : (pdfjs.AnnotationMode?.ENABLE ?? 1),
      }).promise;

      backgroundBlob = await canvasToBlob(bgCanvas, 0.8);

      const thumbFactor = Math.min(1, THUMBNAIL_MAX_EDGE / bgCanvas.width);
      const thumbCanvas = document.createElement("canvas");
      thumbCanvas.width = Math.max(1, Math.round(bgCanvas.width * thumbFactor));
      thumbCanvas.height = Math.max(1, Math.round(bgCanvas.height * thumbFactor));
      const thumbCtx = thumbCanvas.getContext("2d");
      thumbCtx.imageSmoothingQuality = "high";
      thumbCtx.drawImage(bgCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);

      thumbnailBlob = await canvasToBlob(thumbCanvas, 0.7);
    }
  } catch (err) {
    warnings.push("fallback-render-failed");
    console.warn("Failed to render background snapshot:", err);
  }

  let mostUsedFont = "sans-serif";
  let maxChars = 0;
  for (const [font, count] of Object.entries(fontUsage)) {
    if (count > maxChars) {
      maxChars = count;
      mostUsedFont = font;
    }
  }

  return {
    width,
    height,
    candidates,
    unsupported,
    nonVisualAnnotations,
    warnings,
    backgroundBlob,
    thumbnailBlob,
    detectedFonts: Object.keys(fontUsage),
    mostUsedFont,
    fontUsage,
  };
}

/**
 * Decomposes an entire PDF file into pages of editable elements.
 * Preserves exact page dimensions and aggregates font usage.
 *
 * `onPage` is invoked after each page is decomposed so the caller can persist
 * that page's binary assets immediately and drop the blob references, instead of
 * holding every page's background in memory until the whole document finishes.
 * Whatever it returns replaces the page record.
 */
export async function decomposePdf(arrayBuffer, scale = 1.333333, onPage, options = {}) {
  // "annotations" keeps the PDF as the document and only rasterizes each page;
  // "editable" additionally rebuilds its content as native objects.
  const mode = options.mode === "annotations" ? "annotations" : "editable";
  const extract = mode === "editable";

  const bytes = new Uint8Array(arrayBuffer);
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
  const pages = [];
  const globalFontUsage = {};

  for (let num = 1; num <= pdf.numPages; num++) {
    const page = await pdf.getPage(num);
    const decomposed = await decomposePage(page, scale, { extract });

    // Turn the raw operator-level candidates into the objects the editor will
    // actually receive: grouped where the evidence is strong, dropped into the
    // fallback where it is not.
    const grouped = extract
      ? groupPageCandidates(decomposed)
      : {
          objects: [],
          fallbackRegions: [],
          fallbackImage: null,
          // Nothing was recovered, so the page is a locked raster. Reported as
          // `fallback` rather than `partial` because that is what it is — the
          // user asked for an annotated PDF, not a recovered one.
          report: {
            status: "fallback",
            fallbackFromImage: false,
            mode: "annotations",
            textObjects: 0,
            vectorGroups: 0,
            imageObjects: 0,
            fallbackRegions: 0,
            backdropImages: 0,
            unsupportedOperators: 0,
            unsupportedAnnotations: [],
            nonVisualAnnotations: [],
            warnings: [],
            errors: [],
          },
          fallbackVisible: true,
        };

    let record = {
      pageNumber: num,
      width: decomposed.width,
      height: decomposed.height,
      importSchemaVersion: IMPORT_SCHEMA_VERSION,
      importedObjectVersion: IMPORTED_OBJECT_VERSION,
      ...grouped,
      backgroundBlob: decomposed.backgroundBlob,
      thumbnailBlob: decomposed.thumbnailBlob,
      detectedFonts: decomposed.detectedFonts,
      mostUsedFont: decomposed.mostUsedFont,
      fontUsage: decomposed.fontUsage,
    };

    if (typeof onPage === "function") {
      record = (await onPage(record, num - 1)) || record;
    }
    pages.push(record);

    if (decomposed.fontUsage) {
      for (const [font, count] of Object.entries(decomposed.fontUsage)) {
        globalFontUsage[font] = (globalFontUsage[font] || 0) + count;
      }
    }
  }

  let primaryFont = "sans-serif";
  let maxChars = 0;
  for (const [font, count] of Object.entries(globalFontUsage)) {
    if (count > maxChars) {
      maxChars = count;
      primaryFont = font;
    }
  }

  pages.mostUsedFont = primaryFont;
  pages.detectedFonts = Object.keys(globalFontUsage);

  return pages;
}
