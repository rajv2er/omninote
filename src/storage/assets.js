/**
 * IndexedDB-backed blob store for OmniNote page assets.
 *
 * Page backgrounds and thumbnails are binary and large. Keeping them as base64
 * dataURLs inside localStorage exhausts the ~5MB quota after only a handful of
 * imported pages, so every binary asset lives here instead and only its id is
 * persisted with the notebook record.
 */

const DB_NAME = "omninote-assets";
const DB_VERSION = 1;
const STORE = "assets";

let dbPromise = null;

/** Object URLs are cached so re-rendering the library does not reload blobs. */
const urlCache = new Map();

function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable in this browser"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

function withStore(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        let out;

        try {
          out = fn(transaction.objectStore(STORE));
        } catch (err) {
          reject(err);
          return;
        }

        transaction.oncomplete = () => {
          resolve(out && typeof out === "object" && "result" in out ? out.result : out);
        };
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      })
  );
}

/** Converts a dataURL string into a Blob so it can be stored as binary. */
export function dataUrlToBlob(dataUrl) {
  const [header, base64] = String(dataUrl).split(",");
  const mimeMatch = /data:([^;]+)/.exec(header || "");
  const mime = mimeMatch ? mimeMatch[1] : "application/octet-stream";
  const binary = atob(base64 || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

export function putAsset(id, blob) {
  return withStore("readwrite", (store) => store.put(blob, id));
}

export async function putAssetFromDataUrl(id, dataUrl) {
  return putAsset(id, dataUrlToBlob(dataUrl));
}

export function getAsset(id) {
  return withStore("readonly", (store) => store.get(id));
}

export function deleteAsset(id) {
  if (urlCache.has(id)) {
    URL.revokeObjectURL(urlCache.get(id));
    urlCache.delete(id);
  }
  return withStore("readwrite", (store) => store.delete(id));
}

export async function deleteAssets(ids) {
  const list = (ids || []).filter(Boolean);
  await Promise.all(list.map((id) => deleteAsset(id).catch(() => {})));
}

/**
 * Resolves an asset id to a usable object URL, caching it for repeat renders.
 * Returns null when the asset is missing so callers can degrade gracefully.
 */
export async function getAssetUrl(id) {
  if (!id) return null;
  if (urlCache.has(id)) return urlCache.get(id);

  const blob = await getAsset(id);
  if (!blob) return null;

  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  return url;
}

export function getCachedAssetUrl(id) {
  return id ? urlCache.get(id) || null : null;
}

/** Collects every asset id referenced by a notebook, for cleanup on delete. */
export function collectNoteAssetIds(note) {
  const ids = [];
  for (const page of note?.pages || []) {
    if (page.backgroundAssetId) ids.push(page.backgroundAssetId);
    if (page.thumbnailAssetId) ids.push(page.thumbnailAssetId);
  }
  if (note?.thumbnailAssetId) ids.push(note.thumbnailAssetId);
  // Source PDF, kept so pages can be re-rendered crisply when zoomed.
  if (note?.pdfAssetId) ids.push(note.pdfAssetId);
  return ids;
}

/**
 * IndexedDB key for a page's Fabric object graph.
 *
 * Derived from the page id rather than stored, so a cloned page (which gets a
 * fresh id) can never end up sharing — and overwriting — its source's graph.
 */
export function canvasKeyForPage(page) {
  return page?.id ? `canvas-${page.id}` : null;
}

/** IndexedDB key for a page's one-shot import handoff. */
export function pendingKeyForPage(page) {
  return page?.id ? `pending-${page.id}` : null;
}

/**
 * Stores a JSON payload under a page key.
 *
 * The object graph is far too large for localStorage — a real 14-page
 * handwriting import measured 6.8 MB against a hard 5 MB ceiling — so it lives
 * here alongside the other document data.
 */
export function putPagePayload(key, json) {
  return withStore("readwrite", (store) => store.put(json, key));
}

export function getPagePayload(key) {
  return withStore("readonly", (store) => store.get(key));
}

/**
 * Collects asset ids belonging to a single page.
 *
 * Imported pages reference image assets from inside their object graph, not
 * just through `backgroundAssetId`, so those are collected too — otherwise
 * deleting one page would orphan the images still used by its copies.
 */
export function collectPageAssetIds(page) {
  const ids = [];
  if (page?.backgroundAssetId) ids.push(page.backgroundAssetId);
  if (page?.thumbnailAssetId) ids.push(page.thumbnailAssetId);

  // The page's own object graph and import handoff.
  const canvasKey = canvasKeyForPage(page);
  if (canvasKey) ids.push(canvasKey);
  const pendingKey = pendingKeyForPage(page);
  if (pendingKey) ids.push(pendingKey);

  const pending = page?.pendingImportData || page?.pendingDecomposedData;
  for (const obj of pending?.objects || []) {
    if (obj?.assetId) ids.push(obj.assetId);
  }
  // Pre-schema records kept images in a separate array.
  for (const img of pending?.imageObjects || []) {
    if (img?.assetId) ids.push(img.assetId);
  }

  return ids;
}
