import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { StaticCanvas } from "fabric";
import { getAssetUrl } from "../storage/assets.js";
import { getPdfDoc } from "./raster.js";
import { hydrateCanvasJson } from "./importModel.js";
import { renderPdfPageBlob } from "./raster.js";

/**
 * True when the page should render its locked imported raster underneath the
 * editable objects.
 *
 * A page is only allowed to drop its fallback when import proved the whole
 * page was recovered; anything partial keeps the raster so unsupported content
 * does not silently vanish from the export.
 *
 * A page waiting on its import handoff has no materialised objects yet — the
 * raster is still the only thing carrying its appearance, even when the
 * finished state will hide it. Without this, batch-promoted pages preview as
 * blank white sheets until they are first opened.
 */
function pageShowsFallback(page) {
  if (page?.pendingImportData || page?.pendingDecomposedData) return true;
  return page?.fallbackVisible !== false;
}

async function resolveFallbackUrl(page) {
  if (!pageShowsFallback(page)) return null;
  if (!page?.backgroundAssetId) return null;
  return getAssetUrl(page.backgroundAssetId).catch(() => null);
}

/** Loads a stored Fabric document, resolving imported image assets first. */
async function renderStoredCanvas(canvasJson, width, height) {
  const canvasData = canvasJson?.canvasData || canvasJson;
  if (!canvasData) return null;

  const staticCanvas = new StaticCanvas(null, { width, height });
  await staticCanvas.loadFromJSON(await hydrateCanvasJson(canvasData));
  return staticCanvas;
}

/**
 * Draws paper template patterns (ruled lines, grid, dots) onto a 2D context.
 */
function drawPaperPattern(ctx, width, height, style) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  if (style === "lined") {
    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 1;
    for (let y = 36; y < height; y += 28) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  } else if (style === "grid") {
    ctx.strokeStyle = "#edf2f7";
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 24) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += 24) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  } else if (style === "dotted") {
    ctx.fillStyle = "#cbd5e1";
    for (let x = 12; x < width; x += 24) {
      for (let y = 12; y < height; y += 24) {
        ctx.beginPath();
        ctx.arc(x, y, 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (style === "cornell") {
    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 1;
    for (let y = 28; y < height; y += 28) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(width * 0.3, 0);
    ctx.lineTo(width * 0.3, height);
    ctx.stroke();
  } else if (style === "music") {
    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 1;
    for (let y = 20; y < height; y += 12) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }
}

/**
 * Converts a base64 DataURL to Uint8Array.
 */
function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Exports an entire multi-page notebook into a single downloadable PDF document.
 */
export async function exportNotebookToPdf(note, activeCanvasEngine, onProgress = () => {}, pagesToExport = null) {
  const pdfDoc = await PDFDocument.create();
  const textFont = await pdfDoc.embedFont(StandardFonts.Helvetica).catch(() => null);
  const allPages = note.pages && note.pages.length > 0 ? note.pages : [{
    width: 800,
    height: 1130,
    paperStyle: "plain",
    canvasJson: null,
  }];
  const indices = pagesToExport && pagesToExport.length ? pagesToExport.slice() : allPages.map((_, i) => i);

  for (let k = 0; k < indices.length; k++) {
    const idx = indices[k];
    const page = allPages[idx];
    onProgress(k + 1, indices.length);

    const width = page.width || 800;
    const height = page.height || 1130;
    const paperStyle = page.paperStyle || "plain";

    // 1 CSS px (96 DPI) = 0.75 pt (72 DPI)
    const ptWidth = Math.round(width * 0.75);
    const ptHeight = Math.round(height * 0.75);

    const pdfPage = pdfDoc.addPage([ptWidth, ptHeight]);

    // Render page snapshot offscreen with 2x retina scaling for sharp lines
    const offscreen = document.createElement("canvas");
    const scale = 2;
    offscreen.width = width * scale;
    offscreen.height = height * scale;
    const ctx = offscreen.getContext("2d");
    ctx.scale(scale, scale);

    // The imported-page fallback already contains the page's own paper, so it
    // replaces the template rather than sitting on top of it.
    const backgroundUrl = await resolveFallbackUrl(page);

    if (backgroundUrl) {
      await drawImageToContext(ctx, backgroundUrl, width, height);
    } else {
      drawPaperPattern(ctx, width, height, paperStyle);
    }

    // Draw canvas layer
    if (idx === note.currentPageIndex && activeCanvasEngine) {
      const contentDataUrl = activeCanvasEngine.canvas.toDataURL({
        format: "png",
        multiplier: scale,
      });
      await drawImageToContext(ctx, contentDataUrl, width, height);
    } else if (page.canvasJson) {
      // Inactive page with serialized Fabric JSON. Image assets are resolved
      // from IndexedDB before `loadFromJSON`, otherwise imported images are
      // blank on export.
      const staticCanvas = await renderStoredCanvas(page.canvasJson, width, height);
      if (staticCanvas) {
        const contentDataUrl = staticCanvas.toDataURL({
          format: "png",
          multiplier: scale,
        });
        staticCanvas.dispose();
        await drawImageToContext(ctx, contentDataUrl, width, height);
      }
    }

    // Invisible text layer: makes the exported PDF searchable even though the
    // visible page is rasterised. Only text objects that are already in the
    // page's object graph are used; annotate-only pages keep their raster.
    if (textFont) {
      const textObjects = [];
      if (idx === note.currentPageIndex && activeCanvasEngine) {
        for (const obj of activeCanvasEngine.canvas.getObjects()) {
          if (
            (obj.type === "i-text" ||
              obj.type === "text" ||
              obj.type === "textbox") &&
            typeof obj.text === "string"
          ) {
            textObjects.push({
              text: obj.text,
              left: obj.left || 0,
              top: obj.top || 0,
              fontSize: obj.fontSize || 16,
            });
          }
        }
      } else {
        const canvasData = page.canvasJson?.canvasData || page.canvasJson;
        const walk = (node) => {
          if (!node || typeof node !== "object") return;
          if (Array.isArray(node.objects)) node.objects.forEach(walk);
          if (
            (node.type === "i-text" ||
              node.type === "text" ||
              node.type === "textbox") &&
            typeof node.text === "string"
          ) {
            textObjects.push({
              text: node.text,
              left: node.left || 0,
              top: node.top || 0,
              fontSize: node.fontSize || 16,
            });
          }
        };
        walk(canvasData);
      }

      for (const t of textObjects) {
        try {
          const size = Math.max(4, (t.fontSize || 16) * 0.75);
          pdfPage.drawText(String(t.text), {
            x: (t.left || 0) * 0.75,
            y: (height - (t.top || 0) - (t.fontSize || 16) * 0.8) * 0.75,
            size,
            font: textFont,
            color: rgb(0, 0, 0),
            opacity: 0,
          });
        } catch {
          // A single bad text object must not fail the whole export.
        }
      }
    }

    // Searchable text layer from the source PDF. This makes annotate-only pages
    // searchable too, using the original (not substituted) text positions.
    if (textFont && note?.pdfAssetId && Number.isInteger(page.pdfPageIndex)) {
      try {
        const doc = await getPdfDoc(note.pdfAssetId);
        const sourcePage = await doc.getPage(page.pdfPageIndex + 1);
        const content = await sourcePage.getTextContent();
        for (const item of content.items || []) {
          if (!item || typeof item.str !== "string" || !item.str.trim()) continue;
          const transform = Array.isArray(item.transform) ? item.transform : [];
          const x = Number(transform[4]) || 0;
          const y = Number(transform[5]) || 0;
          const fontSize = Math.max(
            4,
            Math.hypot(
              Number(transform[2]) || 0,
              Number(transform[3]) || 0,
            ) || Number(item.height) || 12,
          );
          try {
            pdfPage.drawText(String(item.str), {
              x,
              y,
              size: fontSize,
              font: textFont,
              color: rgb(0, 0, 0),
              opacity: 0,
            });
          } catch {
            // A single bad text item must not fail the whole export.
          }
        }
        sourcePage.cleanup();
      } catch {
        // Text extraction is a best-effort enhancement.
      }
    }

    // Photographic page backgrounds compress far better as JPEG; pure line art
    // stays lossless as PNG.
    let embeddedImage;
    if (backgroundUrl) {
      const jpegBytes = dataUrlToBytes(offscreen.toDataURL("image/jpeg", 0.9));
      embeddedImage = await pdfDoc.embedJpg(jpegBytes);
    } else {
      const pngBytes = dataUrlToBytes(offscreen.toDataURL("image/png"));
      embeddedImage = await pdfDoc.embedPng(pngBytes);
    }

    pdfPage.drawImage(embeddedImage, {
      x: 0,
      y: 0,
      width: ptWidth,
      height: ptHeight,
    });
  }

  const pdfBytes = await pdfDoc.save();
  return pdfBytes;
}

function drawImageToContext(ctx, dataUrl, width, height) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      ctx.drawImage(img, 0, 0, width, height);
      resolve();
    };
    img.onerror = () => resolve();
    img.src = dataUrl;
  });
}

/**
 * Renders a single page (paper or imported background + ink) to a JPEG data URL
 * at roughly `targetWidth` CSS pixels. Used by the Page Manager grid, which is
 * independent of the live Fabric engines so it stays correct even mid-edit.
 */
export async function renderPageThumbnail(page, targetWidth = 320, options = {}) {
  const width = page.width || 800;
  const height = page.height || 1130;
  const paperStyle = page.paperStyle || "plain";
  const scale = targetWidth / width;

  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(width * scale));
  out.height = Math.max(1, Math.round(height * scale));
  const ctx = out.getContext("2d");
  ctx.scale(scale, scale);

  let backgroundUrl = await resolveFallbackUrl(page);
  let transientBackgroundUrl = null;

  // Lazy annotated imports intentionally do not retain a full-page raster for
  // every page. A promoted page can also be waiting to materialise its native
  // objects, which means it has neither a raster nor canvas JSON yet. The Page
  // Manager must still show the document, not a misleading blank sheet.
  // Render a small one-shot preview from the source PDF for precisely those
  // states. Once a fully recovered page has serialized canvas JSON, that JSON
  // remains authoritative and is rendered over ordinary paper below.
  const hasCanvasJson = Boolean(page.canvasJson?.canvasData || page.canvasJson);
  const hasPendingHandoff = Boolean(
    page.pendingImportData || page.pendingDecomposedData,
  );
  const canUseSourcePdf =
    !backgroundUrl &&
    options.pdfAssetId &&
    Number.isInteger(page.pdfPageIndex) &&
    (page.fallbackVisible !== false || !hasCanvasJson || hasPendingHandoff);
  if (canUseSourcePdf) {
    const raster = await renderPdfPageBlob(
      options.pdfAssetId,
      page.pdfPageIndex,
      Math.max(1, Math.round(targetWidth)),
    );
    if (raster?.blob) {
      transientBackgroundUrl = URL.createObjectURL(raster.blob);
      backgroundUrl = transientBackgroundUrl;
    }
  }

  try {
    if (backgroundUrl) {
      await drawImageToContext(ctx, backgroundUrl, width, height);
    } else {
      drawPaperPattern(ctx, width, height, paperStyle);
    }

    const canvasData = page.canvasJson?.canvasData || page.canvasJson;
    if (canvasData) {
      const staticCanvas = await renderStoredCanvas(page.canvasJson, width, height);
      if (staticCanvas) {
        // PNG keeps the ink's transparency so the paper underneath shows through
        // instead of the JPEG's no-alpha black background masking the page.
        const inkUrl = staticCanvas.toDataURL({ format: "png" });
        staticCanvas.dispose();
        await drawImageToContext(ctx, inkUrl, width, height);
      }
    }

    return out.toDataURL("image/jpeg", 0.7);
  } finally {
    if (transientBackgroundUrl) URL.revokeObjectURL(transientBackgroundUrl);
  }
}
