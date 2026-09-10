/**
 * Canvas → Blob encoding, shared by the import and re-rasterization paths.
 *
 * WebP is preferred because page rasters and thumbnails are the largest thing
 * an imported notebook stores. But encoder support is not universal — Safari
 * and WKWebView have historically lacked `canvas.toBlob("image/webp")`, and a
 * webview is exactly what Tauri uses on macOS. Per spec an unsupported type
 * falls back to PNG, which is several times larger, so the capability is probed
 * once and JPEG chosen explicitly rather than relying on that silent fallback.
 */

let webpSupport = null;

/** Probes once whether this engine can actually encode WebP. */
export function supportsWebp() {
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

/**
 * Encodes a canvas as a blob, or resolves `null` when the engine cannot.
 *
 * An empty blob is treated as failure so callers can degrade instead of
 * storing a zero-byte asset.
 */
export function canvasToBlob(canvas, quality = 0.9) {
  return new Promise((resolve) => {
    if (!canvas || typeof canvas.toBlob !== "function") {
      resolve(null);
      return;
    }

    const type = supportsWebp() ? "image/webp" : "image/jpeg";
    try {
      canvas.toBlob(
        (blob) => resolve(blob && blob.size ? blob : null),
        type,
        quality,
      );
    } catch {
      resolve(null);
    }
  });
}
