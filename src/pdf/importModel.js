/**
 * Shared shape of the objects produced by the PDF import pipeline.
 *
 * Import produces two things that must never be mixed up:
 *
 *   - binary assets (page fallbacks, embedded images), which live in IndexedDB
 *     and are referenced by id;
 *   - the object graph (text, vectors, groups), which is small enough to sit in
 *     `localStorage` as Fabric JSON.
 *
 * The helpers here keep that boundary intact across every save/load path:
 * object URLs are resolved to ids on serialize and ids back to URLs on load.
 */

import {
  Circle,
  Ellipse,
  FabricImage,
  Group,
  IText,
  Line,
  Path,
  Rect,
  Textbox,
  Triangle,
} from "fabric";
import { getAssetUrl } from "../storage/assets.js";
import { canvasToBlob } from "./canvasBlob.js";

/**
 * Non-default Fabric properties that must survive `toJSON()`/`loadFromJSON()`.
 * Fabric only serialises properties it knows about unless they are listed.
 */
export const IMPORT_OBJECT_PROPS = [
  "omniId",
  "omniType",
  "sourceType",
  "importConfidence",
  "sourceFontName",
  "assetId",
  "naturalWidth",
  "naturalHeight",
  // Page furniture must stay locked across a save/reload.
  "omniLocked",
];

/**
 * Stand-in for an imported image whose bytes live in IndexedDB.
 *
 * A 1x1 transparent PNG is used rather than `null` because Fabric's image
 * loader needs something it can actually load; the real source is swapped in
 * before the canvas is ever shown.
 */
export const PLACEHOLDER_IMAGE_SRC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Recursively maps over every object in a Fabric canvas document, including
 * the children of groups.
 */
function walkObjects(node, visit) {
  if (!isPlainObject(node)) return node;

  if (Array.isArray(node.objects)) {
    node.objects = node.objects.map((child) => walkObjects(child, visit));
  }

  if (node.type) visit(node);
  return node;
}

/**
 * Returns a copy of a Fabric canvas document with every imported image's
 * temporary object URL replaced by the placeholder.
 *
 * Object URLs die with the document that created them, so persisting one makes
 * the image unloadable on the next visit. The asset id is the durable
 * reference.
 */
export function stripVolatileSources(canvasData) {
  if (!isPlainObject(canvasData)) return canvasData;

  const clone = JSON.parse(JSON.stringify(canvasData));
  walkObjects(clone, (obj) => {
    if (obj.omniType === "image" && obj.assetId) {
      obj.src = PLACEHOLDER_IMAGE_SRC;
    } else if (obj.type === "image" && !obj.assetId && String(obj.src || "").startsWith("blob:")) {
      // Defensive: an image that slipped through without an asset id would
      // otherwise persist a dead URL and break the whole load.
      obj.src = PLACEHOLDER_IMAGE_SRC;
    }
  });

  return clone;
}

/**
 * Returns a copy of a Fabric canvas document with every imported image's
 * asset id resolved back to a usable object URL.
 *
 * Must be awaited *before* `loadFromJSON`, so Fabric builds each image from its
 * real bytes and the persisted scale factors stay correct.
 */
export async function hydrateCanvasJson(canvasData) {
  if (!isPlainObject(canvasData)) return canvasData;

  const clone = JSON.parse(JSON.stringify(canvasData));
  const pending = [];

  walkObjects(clone, (obj) => {
    if (obj.omniType === "image" && obj.assetId) {
      pending.push(
        getAssetUrl(obj.assetId)
          .catch(() => null)
          .then((url) => {
            if (url) obj.src = url;
          }),
      );
    }
  });

  await Promise.all(pending);
  return clone;
}

/**
 * Properties that must survive compaction even when they match the default.
 * `type` selects the class on load; `version` drives Fabric's own migrations.
 */
const ALWAYS_KEEP = new Set(["type", "version"]);

/** Probe instances, built once, used to learn this Fabric version's defaults. */
let defaultProps = null;

function buildDefaultProps() {
  if (defaultProps) return defaultProps;

  const cache = {};

  const probe = (type, factory) => {
    try {
      const instance = factory();
      const json = instance.toObject();
      delete json.type;
      delete json.version;
      cache[type] = json;
      instance.dispose?.();
    } catch {
      // A type we cannot probe simply is not compacted — correctness first.
    }
  };

  probe("Path", () => new Path("M 0 0"));
  probe("Group", () => new Group([]));
  probe("IText", () => new IText(""));
  probe("Textbox", () => new Textbox(""));
  probe("Rect", () => new Rect());
  probe("Circle", () => new Circle());
  probe("Triangle", () => new Triangle());
  probe("Ellipse", () => new Ellipse());
  probe("Line", () => new Line([0, 0, 1, 1]));

  defaultProps = cache;
  return cache;
}

function compactObject(node, defaults) {
  if (Array.isArray(node.objects)) {
    node.objects = node.objects.map((child) => compactObject(child, defaults));
  }

  const typeDefaults = defaults[node.type];
  if (!typeDefaults) return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (value === undefined) continue;
    if (ALWAYS_KEEP.has(key)) {
      out[key] = value;
      continue;
    }
    // Drop anything still sitting at its class default. Fabric restores it on
    // load, so the only thing lost is bytes.
    if (key in typeDefaults && JSON.stringify(typeDefaults[key]) === JSON.stringify(value)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Strips every property that is still at its Fabric default value.
 *
 * Fabric's `toObject()` emits its full property surface — around 36 fields —
 * on every object. On a real 14-page handwriting import that is roughly 1400
 * child paths per page, and the boilerplate alone came to 8.7 MB, well past the
 * ~5 MB localStorage quota, so the notebook silently failed to save. Real path
 * data was a small fraction of it.
 *
 * Defaults are learned from probe instances rather than hard-coded, so this
 * cannot drift when Fabric changes its property set.
 */
export function compactCanvasJson(canvasData) {
  if (!isPlainObject(canvasData)) return canvasData;

  const defaults = buildDefaultProps();
  if (Array.isArray(canvasData.objects)) {
    canvasData.objects = canvasData.objects.map((o) => compactObject(o, defaults));
  }
  return canvasData;
}

/**
 * Converts a pre-schema `pendingDecomposedData` record into the current
 * object shape.
 *
 * Notebooks imported before the versioned import schema keep their original
 * `textObjects` / `pathObjects` / `imageObjects` arrays. They are mapped onto
 * the new structure here rather than re-decomposed, so an old notebook opens
 * exactly as it did before.
 */
export function legacyCandidatesFromDecomposed(decomposed) {
  if (!decomposed || typeof decomposed !== "object") return [];

  const objects = [];
  let n = 0;
  const nextId = () => `legacy-${n++}`;

  for (const t of decomposed.textObjects || []) {
    objects.push({
      omniId: nextId(),
      omniType: "text",
      sourceType: "text",
      importConfidence: 0.6,
      text: t.text,
      left: t.left,
      top: t.top,
      fontSize: t.fontSize,
      fontFamily: t.fontFamily || "sans-serif",
      fontWeight: "normal",
      fontStyle: "normal",
      fill: t.fill || "#1e1e1e",
      angle: 0,
      width: t.width,
      height: t.height,
      sourceFontName: null,
    });
  }

  for (const p of decomposed.pathObjects || []) {
    objects.push({
      omniId: nextId(),
      omniType: "vector",
      sourceType: "path",
      importConfidence: 0.6,
      pathData: p.pathData,
      stroke: p.stroke,
      strokeWidth: p.strokeWidth,
      fill: p.fill || "transparent",
      strokeLineCap: "round",
      strokeLineJoin: "round",
      opacity: 1,
      width: 0,
      height: 0,
    });
  }

  for (const img of decomposed.imageObjects || []) {
    objects.push({
      omniId: nextId(),
      omniType: "image",
      sourceType: "imageXObject",
      importConfidence: 0.6,
      assetId: img.assetId || null,
      left: img.left,
      top: img.top,
      width: img.width,
      height: img.height,
    });
  }

  return objects;
}

/**
 * Draws an extracted backdrop image into a page-sized canvas and returns it as
 * a blob, so it can serve as the page's fallback layer.
 *
 * The engine draws its fallback stretched to the page box, so the fallback has
 * to *be* page-sized and carry the backdrop at its true placement — otherwise
 * an inset or offset backdrop would be silently stretched to fill the page.
 */
export async function composePageSizedFallback(
  imageBlob,
  placement,
  pageWidth,
  pageHeight,
) {
  if (typeof document === "undefined" || !imageBlob) return null;

  const width = Math.max(1, Math.round(pageWidth || 1));
  const height = Math.max(1, Math.round(pageHeight || 1));
  const url = URL.createObjectURL(imageBlob);

  try {
    const img = await new Promise((resolve) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => resolve(null);
      el.src = url;
    });
    if (!img) return null;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    const p = placement || { left: 0, top: 0, width, height, angle: 0 };
    ctx.save();
    ctx.translate(p.left || 0, p.top || 0);
    if (p.angle) ctx.rotate((p.angle * Math.PI) / 180);
    ctx.drawImage(img, 0, 0, p.width || width, p.height || height);
    ctx.restore();

    return await canvasToBlob(canvas, 0.9);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Object counts by type, for the import report. */
export function summarizeObjects(objects) {
  const list = Array.isArray(objects) ? objects : [];
  return {
    textObjects: list.filter((o) => o.omniType === "text").length,
    vectorGroups: list.filter(
      (o) => o.omniType === "vectorGroup" || o.omniType === "vector",
    ).length,
    imageObjects: list.filter((o) => o.omniType === "image").length,
  };
}
