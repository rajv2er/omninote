import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

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
    const val = Math.max(0, Math.min(255, Math.round(c <= 1 ? c * 255 : c)));
    return val.toString(16).padStart(2, "0");
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

let webpSupport = null;

function supportsWebp() {
  if (webpSupport !== null) return webpSupport;
  try {
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    webpSupport = probe.toDataURL("image/webp").indexOf("data:image/webp") === 0;
  } catch {
    webpSupport = false;
  }
  return webpSupport;
}

/** Longest edge for the fallback background. Keeps a full page legible without huge files. */
const BACKGROUND_MAX_EDGE = 1600;
/** Longest edge for the library thumbnail. */
const THUMBNAIL_MAX_EDGE = 320;

function canvasToBlob(canvas, quality) {
  const type = supportsWebp() ? "image/webp" : "image/jpeg";
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Decomposes a single PDF page into editable text, image, and vector path objects.
 * Scale 1.333333 converts PDF 72 DPI points to standard 96 DPI CSS pixels.
 */
export async function decomposePage(page, scale = 1.333333) {
  const viewport = page.getViewport({ scale });
  const width = Math.round(viewport.width);
  const height = Math.round(viewport.height);

  const textObjects = [];
  const pathObjects = [];
  const imageObjects = [];
  const fontUsage = {};

  let opList = null;

  // 1. Get operator list first to populate commonObjs (fonts & images)
  try {
    opList = await page.getOperatorList();
  } catch (e) {
    console.warn("Could not load operator list:", e);
  }

  // 2. Extract and group text runs with font detection
  try {
    const textContent = await page.getTextContent();
    let currentLine = null;

    for (const item of textContent.items) {
      if (!item.str || item.str.trim() === "") continue;

      // Detect Font Family
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

      // Track font usage by character count
      const textLen = item.str.trim().length;
      fontUsage[resolvedFont] = (fontUsage[resolvedFont] || 0) + textLen;

      const tx = item.transform[4];
      const ty = item.transform[5];
      const [vx, vy] = viewport.convertToViewportPoint(tx, ty);

      const fontSize = Math.max(
        9,
        Math.round(Math.hypot(item.transform[0], item.transform[1]) * scale)
      );

      const itemWidth = (item.width || item.str.length * (fontSize * 0.55)) * scale;
      const itemHeight = fontSize * 1.25;
      const top = Math.max(0, vy - fontSize);

      if (
        currentLine &&
        Math.abs(currentLine.top - top) < fontSize * 0.45 &&
        vx >= currentLine.left &&
        vx - (currentLine.left + currentLine.width) < fontSize * 2.0 &&
        currentLine.fontFamily === resolvedFont
      ) {
        const spaceNeeded = vx - (currentLine.left + currentLine.width) > fontSize * 0.18;
        currentLine.text += (spaceNeeded ? " " : "") + item.str;
        currentLine.width = vx + itemWidth - currentLine.left;
      } else {
        if (currentLine) textObjects.push(currentLine);
        currentLine = {
          type: "text",
          text: item.str,
          left: Math.round(vx),
          top: Math.round(top),
          fontSize,
          fontFamily: resolvedFont,
          width: Math.round(itemWidth),
          height: Math.round(itemHeight),
          fill: "#1e1e1e",
        };
      }
    }
    if (currentLine) textObjects.push(currentLine);
  } catch (err) {
    console.warn("Failed to extract text content:", err);
  }

  // Calculate most used font for this page
  let mostUsedFont = "sans-serif";
  let maxChars = 0;
  for (const [font, count] of Object.entries(fontUsage)) {
    if (count > maxChars) {
      maxChars = count;
      mostUsedFont = font;
    }
  }
  const detectedFonts = Object.keys(fontUsage);

  // 3. Extract vector paths and images from the PDF operator stream
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
      let pendingPathSegments = [];

      const toViewport = (x, y) => {
        const [px, py] = transformPoint([x, y], currentMatrix);
        return viewport.convertToViewportPoint(px, py);
      };

      /**
       * Turns sub-path commands into SVG path data.
       *
       * pdf.js >= 5 already hands us a flat DrawOPS array; older versions used a
       * pair of arrays (`[ops[], coords[]]`). Both are normalised to the flat
       * form so there is only one parser to keep correct.
       */
      const buildPathData = (flat) => {
        const svgParts = [];
        const f = (n) => Number(n).toFixed(1);
        let k = 0;

        while (k < flat.length) {
          const sub = flat[k++];
          if (sub === DRAW.moveTo) {
            const [vx, vy] = toViewport(flat[k], flat[k + 1]);
            k += 2;
            svgParts.push(`M ${f(vx)} ${f(vy)}`);
          } else if (sub === DRAW.lineTo) {
            const [vx, vy] = toViewport(flat[k], flat[k + 1]);
            k += 2;
            svgParts.push(`L ${f(vx)} ${f(vy)}`);
          } else if (sub === DRAW.curveTo) {
            const [c1x, c1y] = toViewport(flat[k], flat[k + 1]);
            const [c2x, c2y] = toViewport(flat[k + 2], flat[k + 3]);
            const [vx, vy] = toViewport(flat[k + 4], flat[k + 5]);
            k += 6;
            svgParts.push(
              `C ${f(c1x)} ${f(c1y)}, ${f(c2x)} ${f(c2y)}, ${f(vx)} ${f(vy)}`
            );
          } else if (sub === DRAW.quadraticCurveTo) {
            const [cx, cy] = toViewport(flat[k], flat[k + 1]);
            const [vx, vy] = toViewport(flat[k + 2], flat[k + 3]);
            k += 4;
            svgParts.push(`Q ${f(cx)} ${f(cy)}, ${f(vx)} ${f(vy)}`);
          } else if (sub === DRAW.closePath) {
            svgParts.push("Z");
          } else {
            // An unknown command would desync the coordinate cursor, so stop.
            break;
          }
        }

        return svgParts.length > 0 ? svgParts.join(" ") : null;
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

      /**
       * Emits a path object, or defers it when the operator did not say how to
       * paint (older pdf.js emitted a separate stroke/fill operator afterwards).
       */
      const emitPath = (pathData, paintOp) => {
        if (!pathData) return;

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
          if (paintOp === null) pendingPathSegments.push(pathData);
          return;
        }

        pathObjects.push({
          type: "path",
          pathData,
          stroke: isStrokeOp ? strokeColor : null,
          strokeWidth: isStrokeOp ? lineWidth : 0,
          fill: isFillOp ? fillColor : "transparent",
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
              matrixStack.push([...currentMatrix]);
              break;

            case OPS.restore:
              if (matrixStack.length > 0) currentMatrix = matrixStack.pop();
              break;

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

            case OPS.setStrokeRGBColor:
              strokeColor = rgbToHex(args[0], args[1], args[2]);
              break;

            case OPS.setFillRGBColor:
              fillColor = rgbToHex(args[0], args[1], args[2]);
              break;

            case OPS.constructPath: {
              // pdf.js >= 5: [paintOp, drawOps, minMax?]  — paintOp is a NUMBER.
              // pdf.js <  5: [ops[], coords[]]            — args[0] is an array.
              // Reading args[0] as the sub-path list throws "ops is not iterable"
              // on modern pdf.js, which used to kill every stroke and image.
              const flat = toFlatDrawOps(args);
              if (!flat) break;

              const paintOp = typeof args[0] === "number" ? args[0] : null;
              emitPath(buildPathData(flat), paintOp);
              break;
            }

            case OPS.stroke:
            case OPS.closeStroke: {
              if (pendingPathSegments.length > 0) {
                const pathData = pendingPathSegments.join(" ");
                pathObjects.push({
                  type: "path",
                  pathData,
                  stroke: strokeColor,
                  strokeWidth: lineWidth,
                  fill: "transparent",
                });
                pendingPathSegments = [];
              }
              break;
            }

            case OPS.fill:
            case OPS.eoFill: {
              if (pendingPathSegments.length > 0) {
                const pathData = pendingPathSegments.join(" ");
                pathObjects.push({
                  type: "path",
                  pathData,
                  stroke: null,
                  strokeWidth: 0,
                  fill: fillColor,
                });
                pendingPathSegments = [];
              }
              break;
            }

            case OPS.paintImageXObject: {
              const imgId = args[0];
              try {
                let imgObj = null;
                if (page.objs && page.objs.has(imgId)) {
                  imgObj = page.objs.get(imgId);
                } else if (page.commonObjs && page.commonObjs.has(imgId)) {
                  imgObj = page.commonObjs.get(imgId);
                }

                if (imgObj && (imgObj.data || imgObj.src || imgObj.bitmap)) {
                  const [p0x, p0y] = toViewport(0, 1);
                  const [p1x, p1y] = toViewport(1, 0);
                  const imgLeft = Math.round(Math.min(p0x, p1x));
                  const imgTop = Math.round(Math.min(p0y, p1y));
                  const imgWidth = Math.round(Math.abs(p1x - p0x));
                  const imgHeight = Math.round(Math.abs(p1y - p0y));

                  let imgSrc = null;
                  if (imgObj.src) {
                    imgSrc = imgObj.src;
                  } else if (imgObj.bitmap && typeof document !== "undefined") {
                    const canvas = document.createElement("canvas");
                    canvas.width = imgObj.width;
                    canvas.height = imgObj.height;
                    const ctx = canvas.getContext("2d");
                    ctx.drawImage(imgObj.bitmap, 0, 0);
                    imgSrc = canvas.toDataURL("image/png");
                  } else if (imgObj.data && typeof document !== "undefined") {
                    const canvas = document.createElement("canvas");
                    canvas.width = imgObj.width;
                    canvas.height = imgObj.height;
                    const ctx = canvas.getContext("2d");
                    const imgData = ctx.createImageData(imgObj.width, imgObj.height);
                    const src = imgObj.data;
                    const dst = imgData.data;

                    if (src.length === imgObj.width * imgObj.height * 3) {
                      let s = 0, d = 0;
                      while (s < src.length) {
                        dst[d] = src[s];
                        dst[d + 1] = src[s + 1];
                        dst[d + 2] = src[s + 2];
                        dst[d + 3] = 255;
                        s += 3;
                        d += 4;
                      }
                    } else if (src.length === imgObj.width * imgObj.height * 4) {
                      dst.set(src);
                    }
                    ctx.putImageData(imgData, 0, 0);
                    imgSrc = canvas.toDataURL("image/png");
                  }

                  if (imgSrc) {
                    imageObjects.push({
                      type: "image",
                      src: imgSrc,
                      left: imgLeft,
                      top: imgTop,
                      width: imgWidth,
                      height: imgHeight,
                    });
                  }
                }
              } catch (imgErr) {
                console.warn("Could not extract image XObject:", imgErr);
              }
              break;
            }
          }
        } catch (opErr) {
          console.warn("Skipping unparsable PDF operator:", fn, opErr);
        }
      }
    } catch (err) {
      console.warn("Failed to parse operator stream:", err);
    }
  }

  // 4. Fallback background snapshot + library thumbnail, both as compact blobs.
  // These stay binary all the way to IndexedDB; they are never base64 in localStorage.
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
    console.warn("Failed to render background snapshot:", err);
  }

  return {
    width,
    height,
    textObjects,
    pathObjects,
    imageObjects,
    backgroundBlob,
    thumbnailBlob,
    detectedFonts,
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
export async function decomposePdf(arrayBuffer, scale = 1.333333, onPage) {
  const bytes = new Uint8Array(arrayBuffer);
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
  const pages = [];
  const globalFontUsage = {};

  for (let num = 1; num <= pdf.numPages; num++) {
    const page = await pdf.getPage(num);
    const decomposed = await decomposePage(page, scale);

    let record = { pageNumber: num, ...decomposed };
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

  // Find document-wide primary font
  let primaryFont = "sans-serif";
  let maxChars = 0;
  for (const [font, count] of Object.entries(globalFontUsage)) {
    if (count > maxChars) {
      maxChars = count;
      primaryFont = font;
    }
  }
  const allDetectedFonts = Object.keys(globalFontUsage);

  // Return augmented array
  pages.mostUsedFont = primaryFont;
  pages.detectedFonts = allDetectedFonts;

  return pages;
}
