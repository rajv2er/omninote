import { PDFDocument } from "pdf-lib";
import { StaticCanvas } from "fabric";
import { getAssetUrl } from "../storage/assets.js";

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
    const backgroundUrl = page.backgroundAssetId
      ? await getAssetUrl(page.backgroundAssetId).catch(() => null)
      : null;

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
      // Inactive page with serialized Fabric JSON. Note the stored shape is
      // { width, height, paperStyle, canvasData }; loadFromJSON needs the inner
      // canvasData, otherwise the page exports blank.
      const canvasData = page.canvasJson.canvasData || page.canvasJson;
      const staticCanvas = new StaticCanvas(null, { width, height });
      await staticCanvas.loadFromJSON(canvasData);
      const contentDataUrl = staticCanvas.toDataURL({
        format: "png",
        multiplier: scale,
      });
      staticCanvas.dispose();
      await drawImageToContext(ctx, contentDataUrl, width, height);
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
  const blob = new Blob([pdfBytes], { type: "application/pdf" });
  const downloadUrl = URL.createObjectURL(blob);

  const downloadLink = document.createElement("a");
  const cleanTitle = (note.title || "OmniNote_Document").replace(/[/\\?%*:|"<>]/g, "-");
  downloadLink.href = downloadUrl;
  downloadLink.download = `${cleanTitle}.pdf`;
  document.body.appendChild(downloadLink);
  downloadLink.click();
  document.body.removeChild(downloadLink);

  setTimeout(() => URL.revokeObjectURL(downloadUrl), 4000);
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
export async function renderPageThumbnail(page, targetWidth = 260) {
  const width = page.width || 800;
  const height = page.height || 1130;
  const paperStyle = page.paperStyle || "plain";
  const scale = targetWidth / width;

  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(width * scale));
  out.height = Math.max(1, Math.round(height * scale));
  const ctx = out.getContext("2d");
  ctx.scale(scale, scale);

  const backgroundUrl = page.backgroundAssetId
    ? await getAssetUrl(page.backgroundAssetId).catch(() => null)
    : null;

  if (backgroundUrl) {
    await drawImageToContext(ctx, backgroundUrl, width, height);
  } else {
    drawPaperPattern(ctx, width, height, paperStyle);
  }

  const canvasData = page.canvasJson?.canvasData || page.canvasJson;
  if (canvasData) {
    const staticCanvas = new StaticCanvas(null, { width, height });
    await staticCanvas.loadFromJSON(canvasData);
    // PNG keeps the ink's transparency so the paper underneath shows through
    // instead of the JPEG's no-alpha black background masking the page.
    const inkUrl = staticCanvas.toDataURL({ format: "png" });
    staticCanvas.dispose();
    await drawImageToContext(ctx, inkUrl, width, height);
  }

  return out.toDataURL("image/jpeg", 0.7);
}
