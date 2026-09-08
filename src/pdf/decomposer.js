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

      for (let i = 0; i < opList.fnArray.length; i++) {
        const fn = opList.fnArray[i];
        const args = opList.argsArray[i];

        switch (fn) {
          case OPS.save:
            matrixStack.push([...currentMatrix]);
            break;

          case OPS.restore:
            if (matrixStack.length > 0) currentMatrix = matrixStack.pop();
            break;

          case OPS.transform:
            currentMatrix = multiplyTransform(currentMatrix, args);
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
            const ops = args[0];
            const coords = args[1];
            let coordIdx = 0;
            const svgParts = [];

            for (const subOp of ops) {
              if (subOp === OPS.moveTo) {
                const [vx, vy] = toViewport(coords[coordIdx], coords[coordIdx + 1]);
                svgParts.push(`M ${vx.toFixed(1)} ${vy.toFixed(1)}`);
                coordIdx += 2;
              } else if (subOp === OPS.lineTo) {
                const [vx, vy] = toViewport(coords[coordIdx], coords[coordIdx + 1]);
                svgParts.push(`L ${vx.toFixed(1)} ${vy.toFixed(1)}`);
                coordIdx += 2;
              } else if (subOp === OPS.curveTo) {
                const [cp1x, cp1y] = toViewport(coords[coordIdx], coords[coordIdx + 1]);
                const [cp2x, cp2y] = toViewport(coords[coordIdx + 2], coords[coordIdx + 3]);
                const [vx, vy] = toViewport(coords[coordIdx + 4], coords[coordIdx + 5]);
                svgParts.push(
                  `C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${vx.toFixed(1)} ${vy.toFixed(1)}`
                );
                coordIdx += 6;
              } else if (subOp === OPS.closePath) {
                svgParts.push("Z");
              } else if (subOp === OPS.rectangle) {
                const rx = coords[coordIdx];
                const ry = coords[coordIdx + 1];
                const rw = coords[coordIdx + 2];
                const rh = coords[coordIdx + 3];
                const [p1x, p1y] = toViewport(rx, ry);
                const [p2x, p2y] = toViewport(rx + rw, ry);
                const [p3x, p3y] = toViewport(rx + rw, ry + rh);
                const [p4x, p4y] = toViewport(rx, ry + rh);
                svgParts.push(
                  `M ${p1x.toFixed(1)} ${p1y.toFixed(1)} L ${p2x.toFixed(1)} ${p2y.toFixed(1)} L ${p3x.toFixed(1)} ${p3y.toFixed(1)} L ${p4x.toFixed(1)} ${p4y.toFixed(1)} Z`
                );
                coordIdx += 4;
              }
            }

            if (svgParts.length > 0) {
              pendingPathSegments.push(svgParts.join(" "));
            }
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
      }
    } catch (err) {
      console.warn("Failed to parse operator stream:", err);
    }
  }

  // 4. Fallback background snapshot
  let backgroundDataUrl = null;
  try {
    if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      await page.render({
        canvasContext: ctx,
        viewport,
      }).promise;
      backgroundDataUrl = canvas.toDataURL("image/jpeg", 0.65);
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
    backgroundDataUrl,
    detectedFonts,
    mostUsedFont,
    fontUsage,
  };
}

/**
 * Decomposes an entire PDF file into pages of editable elements.
 * Preserves exact page dimensions and aggregates font usage.
 */
export async function decomposePdf(arrayBuffer, scale = 1.333333) {
  const bytes = new Uint8Array(arrayBuffer);
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
  const pages = [];
  const globalFontUsage = {};

  for (let num = 1; num <= pdf.numPages; num++) {
    const page = await pdf.getPage(num);
    const decomposed = await decomposePage(page, scale);
    pages.push({
      pageNumber: num,
      ...decomposed,
    });

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
