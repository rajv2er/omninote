/**
 * Lazy, on-demand re-rasterization of imported PDF pages.
 *
 * OmniNote decomposes a PDF at import time and keeps a single snapshot per page
 * as the locked background layer. That snapshot is deliberately small (capped
 * at 1600px) because it is only meant to be a fallback while the decomposed
 * objects take over — but it means zooming in magnifies a bitmap.
 *
 * This module is the Google Drive behaviour: keep the source document around
 * and re-render the page with pdf.js at whatever resolution is currently on
 * screen. The zoom itself is instant (viewport transform); the sharper pixels
 * arrive a moment later.
 */

import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.mjs?url";
import { getAsset } from "../storage/assets.js";
import { canvasToBlob } from "./canvasBlob.js";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

/**
 * One open document per imported notebook. `getDocument` parses the whole file,
 * so re-opening on every zoom step would be far too slow.
 * @type {Map<string, Promise<import("pdfjs-dist").PDFDocumentProxy>>}
 */
const docs = new Map();

/** Never let a mis-reported page size push pdf.js into a huge allocation. */
const MAX_SCALE = 10;
const MIN_SCALE = 0.1;

async function getPdfDoc(assetId) {
  if (docs.has(assetId)) return docs.get(assetId);

  const pending = (async () => {
    const blob = await getAsset(assetId);
    if (!blob) throw new Error("Source PDF is no longer in the asset store");
    const data = new Uint8Array(await blob.arrayBuffer());
    return pdfjs.getDocument({ data }).promise;
  })();

  docs.set(assetId, pending);
  // Do not cache a failure — a retry after the asset is restored should work.
  pending.catch(() => docs.delete(assetId));
  return pending;
}


/**
 * Renders one page of a stored PDF at approximately `targetWidth` device pixels.
 *
 * @param {string} assetId  IndexedDB id of the source PDF file
 * @param {number} pageIndex  Zero-based page index
 * @param {number} targetWidth  Desired width in device pixels
 * @returns {Promise<{blob: Blob, width: number, height: number} | null>}
 */
export async function renderPdfPageBlob(assetId, pageIndex, targetWidth) {
  if (!assetId) return null;

  try {
    const doc = await getPdfDoc(assetId);
    const page = await doc.getPage((pageIndex || 0) + 1);

    const base = page.getViewport({ scale: 1 });
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, (targetWidth || base.width) / base.width));
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));

    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    page.cleanup();

    const blob = await canvasToBlob(canvas);
    if (!blob) return null;

    return { blob, width: canvas.width, height: canvas.height };
  } catch (err) {
    console.warn("Could not re-render PDF page:", err);
    return null;
  }
}

/** Drops a cached document, e.g. when its notebook is deleted. */
export async function invalidatePdfDoc(assetId) {
  if (!assetId) return;
  const pending = docs.get(assetId);
  docs.delete(assetId);
  if (pending) {
    try {
      (await pending).destroy();
    } catch {
      // Already torn down; nothing to release.
    }
  }
}
