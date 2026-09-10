/**
 * Conservative semantic grouping for imported PDF content.
 *
 * The decomposer hands us every path it could read out of the content stream.
 * Most handwriting exports emit one path operator per *segment*, so a single
 * pen stroke arrives as dozens of two-point paths. Loading those as-is gives
 * the user 40 unselectable slivers per stroke; merging too eagerly welds a
 * diagram, a shape and a stray underline into one unusable blob.
 *
 * The rule here is deliberately strict: merge only when several independent
 * pieces of evidence agree, and when in doubt leave the content in the locked
 * fallback rather than guessing. A wrong merge is unfixable by the user; a
 * missing merge merely costs one selection.
 */

/** Below this, an object is not offered as editable at all. */
export const MIN_CONFIDENCE = 0.5;

/**
 * Upper bound on the operator gap between two merged paths.
 *
 * A pen stroke is emitted as one path op per segment with `q`/`Q`, colour and
 * line-width operators in between, so consecutive segments are never adjacent
 * in the operator list. The real signal is that nothing *else* was drawn in
 * between, which `hasImageBetween` and the path ordering test cover; this cap
 * only stops a runaway merge across a whole page.
 */
const MAX_SEQ_GAP = 64;

/**
 * An image this large relative to the page is the page's own backdrop, not
 * content: a scan, a flattened export, or a paper template bitmap.
 *
 * Promoting it buys nothing — it is pixel-identical to the fallback raster —
 * and costs the safety net, because a page classified `complete` hides that
 * raster. So full-page images stay in the fallback and the page is never
 * allowed to claim full recovery.
 */
const BACKDROP_AREA_RATIO = 0.85;

/** Confidence assigned to each kind of recovered object. */
const CONFIDENCE = {
  text: 0.9,
  textAnnotation: 0.7,
  image: 0.85,
  singlePath: 0.7,
  groupedPath: 0.82,
  /** Geometry inside a form XObject is not independently addressable. */
  nestedPenalty: 0.15,
};

function newId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `omni-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

/** Grows `a` until it contains `b`. */
function unionBox(a, b) {
  if (!a) return { ...b };
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
    width: 0,
    height: 0,
  };
}

function sealBox(box) {
  if (!box) return null;
  return {
    ...box,
    width: Math.max(0, box.maxX - box.minX),
    height: Math.max(0, box.maxY - box.minY),
  };
}

/**
 * True when two bounding boxes are close enough to be one drawing gesture.
 *
 * `pad` scales with the stroke width: thick marker strokes legitimately leave
 * bigger gaps between their segments than a 1pt hairline does.
 */
function boxesAdjacent(a, b, pad) {
  const gapX = Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX);
  const gapY = Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY);
  return gapX <= pad && gapY <= pad;
}

function pathToChild(p) {
  return {
    pathData: p.pathData,
    stroke: p.stroke,
    strokeWidth: p.strokeWidth,
    fill: p.fill,
    strokeLineCap: p.strokeLineCap,
    strokeLineJoin: p.strokeLineJoin,
    opacity: p.opacity,
    bbox: p.bbox,
  };
}

/**
 * True when a shape spans essentially the whole page.
 *
 * Real exports carry page furniture as ordinary vector content: a white paper
 * rectangle, sometimes a black one underneath it. Promoting those as normal
 * objects makes them selectable, so dragging the paper away reveals whatever
 * was hiding beneath — a black page. They are kept, because they carry the
 * page's actual background colour, but they are locked.
 */
function coversPage(bbox, pageWidth, pageHeight) {
  if (!bbox) return false;
  const pageArea = Math.max(1, (pageWidth || 1) * (pageHeight || 1));
  return (bbox.width * bbox.height) / pageArea >= BACKDROP_AREA_RATIO;
}

/** Packs one or more path candidates into the object the editor will load. */
function buildVectorObject(paths) {
  const bbox = sealBox(paths.reduce((acc, p) => unionBox(acc, p.bbox), null));
  const shared = paths[0];
  const nested = paths.some((p) => p.nested);

  const base = {
    omniId: newId(),
    omniType: paths.length > 1 ? "vectorGroup" : "vector",
    sourceType: paths[0].fromAnnotation === "Ink" ? "inkAnnotation" : "path",
    stroke: shared.stroke,
    strokeWidth: shared.strokeWidth,
    fill: shared.fill,
    strokeLineCap: shared.strokeLineCap,
    strokeLineJoin: shared.strokeLineJoin,
    opacity: shared.opacity ?? 1,
    bbox,
    left: bbox ? Math.round(bbox.minX) : 0,
    top: bbox ? Math.round(bbox.minY) : 0,
    width: bbox ? Math.round(bbox.width) : 0,
    height: bbox ? Math.round(bbox.height) : 0,
    importConfidence:
      (paths.length > 1 ? CONFIDENCE.groupedPath : CONFIDENCE.singlePath) -
      (nested ? CONFIDENCE.nestedPenalty : 0),
  };

  if (paths.length > 1) {
    base.children = paths.map(pathToChild);
  } else {
    base.pathData = shared.pathData;
  }

  return base;
}

/**
 * Turns raw decomposer candidates into the objects the editor receives.
 *
 * @param {{width:number, height:number, candidates:Array, unsupported:object,
 *          warnings:string[]}} page
 * @returns {{objects:Array, report:object, fallbackVisible:boolean}}
 */
export function groupPageCandidates(page) {
  const candidates = Array.isArray(page.candidates) ? page.candidates : [];
  const unsupported = page.unsupported || { operators: {}, annotations: [], images: 0 };
  const warnings = [];

  const objects = [];
  const fallbackRegions = [];

  const textRuns = candidates.filter((c) => c.kind === "text");
  const images = candidates.filter((c) => c.kind === "image");
  const paths = candidates
    .filter((c) => c.kind === "path" && c.pathData)
    .sort((a, b) => a.seq - b.seq);

  // --- text -----------------------------------------------------------------
  for (const run of textRuns) {
    const confidence = run.fromAnnotation
      ? CONFIDENCE.textAnnotation
      : CONFIDENCE.text;

    if (confidence < MIN_CONFIDENCE) {
      fallbackRegions.push({
        minX: run.left,
        minY: run.top,
        maxX: run.left + (run.width || 0),
        maxY: run.top + (run.height || 0),
        width: run.width || 0,
        height: run.height || 0,
      });
      continue;
    }

    objects.push({
      omniId: newId(),
      omniType: "text",
      sourceType: run.fromAnnotation ? "annotation" : "text",
      importConfidence: confidence,
      text: run.text,
      left: run.left,
      top: run.top,
      fontSize: run.fontSize,
      fontFamily: run.fontFamily,
      fontWeight: run.fontWeight || "normal",
      fontStyle: run.fontStyle || "normal",
      fill: run.fill,
      angle: run.angle || 0,
      width: run.width,
      height: run.height,
      sourceFontName: run.sourceFontName || null,
    });
  }

  // --- images ---------------------------------------------------------------
  const pageArea = Math.max(1, (page.width || 1) * (page.height || 1));
  const backdropImages = [];

  for (const img of images) {
    const coverage = ((img.width || 0) * (img.height || 0)) / pageArea;
    if (coverage >= BACKDROP_AREA_RATIO) {
      backdropImages.push(img);
      fallbackRegions.push({
        minX: img.left,
        minY: img.top,
        maxX: img.left + img.width,
        maxY: img.top + img.height,
        width: img.width,
        height: img.height,
      });
      continue;
    }

    objects.push({
      omniId: newId(),
      omniType: "image",
      sourceType: img.kind === "image" ? "imageXObject" : "imageXObject",
      importConfidence: CONFIDENCE.image,
      blob: img.blob,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      left: img.left,
      top: img.top,
      width: img.width,
      height: img.height,
      angle: img.angle || 0,
    });
  }

  // --- vectors --------------------------------------------------------------
  // Images are real blockers: an image painted between two stroke segments
  // means the segments belong to different drawings.
  const imageSeqs = images.map((i) => i.seq).sort((a, b) => a - b);
  const hasImageBetween = (from, to) =>
    imageSeqs.some((s) => s > from && s < to);

  let group = [];

  const closeGroup = () => {
    if (group.length === 0) return;
    const obj = buildVectorObject(group);
    if (obj.importConfidence >= MIN_CONFIDENCE) {
      // Page furniture stays visible but must not be draggable.
      obj.locked = coversPage(obj.bbox, page.width, page.height);
      objects.push(obj);
    } else if (obj.bbox) {
      fallbackRegions.push(obj.bbox);
    }
    group = [];
  };

  for (const p of paths) {
    if (group.length === 0) {
      group.push(p);
      continue;
    }

    const prev = group[group.length - 1];
    const pad = Math.max(6, (prev.strokeWidth || 1) * 2);

    const contiguous =
      p.seq - prev.seq <= MAX_SEQ_GAP && !hasImageBetween(prev.seq, p.seq);
    const sameStyle = p.styleKey === prev.styleKey;
    const sameNesting = p.nested === prev.nested;
    const adjacent = boxesAdjacent(prev.bbox, p.bbox, pad);

    if (contiguous && sameStyle && sameNesting && adjacent) {
      group.push(p);
    } else {
      closeGroup();
      group.push(p);
    }
  }
  closeGroup();

  // --- honesty pass ---------------------------------------------------------
  const unsupportedOperatorCount = Object.values(unsupported.operators || {}).reduce(
    (a, b) => a + b,
    0,
  );
  const unsupportedAnnotations = Array.from(
    new Set(unsupported.annotations || []),
  );

  if (unsupportedOperatorCount > 0) {
    warnings.push("unsupported-graphics-operators");
  }
  if (unsupportedAnnotations.length > 0) {
    warnings.push("unsupported-annotations");
  }
  if ((unsupported.images || 0) > 0) {
    warnings.push("images-left-in-fallback");
  }
  if (fallbackRegions.length > 0) {
    warnings.push("low-confidence-regions-kept-in-fallback");
  }
  if (backdropImages.length > 0) {
    warnings.push("page-sized-images-kept-in-fallback");
  }
  for (const w of page.warnings || []) {
    if (!warnings.includes(w)) warnings.push(w);
  }

  const fullyRecovered =
    objects.length > 0 &&
    fallbackRegions.length === 0 &&
    unsupportedOperatorCount === 0 &&
    unsupportedAnnotations.length === 0 &&
    (unsupported.images || 0) === 0 &&
    backdropImages.length === 0;

  let status;
  if (objects.length === 0) {
    // Nothing was promoted, so the page is a locked picture — a scan, or a
    // flattened export. Honest, and still writable on top.
    status = "fallback";
  } else if (fullyRecovered) {
    status = "complete";
  } else {
    status = "partial";
  }

  /**
   * When the only thing left in the fallback is the page's own backdrop, the
   * extracted backdrop image can stand in for the whole-page render.
   *
   * This matters because a page render contains the content we *did* recover as
   * well, so drawing recovered objects over it paints everything twice — and
   * the two copies drift apart, because the raster uses pdf.js's substituted
   * font while the text object uses the browser's. Substituting the backdrop
   * leaves the fallback holding nothing but the paper, so there is nothing to
   * double up.
   *
   * The test is deliberately strict: any other unrecovered content (an
   * unsupported operator, a visible annotation, an unreadable image, a
   * low-confidence region) and the full page render is kept instead, because
   * that render is the only thing that still carries it.
   */
  const onlyBackdropUnrecovered =
    backdropImages.length > 0 &&
    fallbackRegions.length === backdropImages.length &&
    unsupportedOperatorCount === 0 &&
    unsupportedAnnotations.length === 0 &&
    (unsupported.images || 0) === 0;

  const fallbackImage = onlyBackdropUnrecovered ? backdropImages[0] : null;

  const report = {
    status,
    fallbackFromImage: Boolean(fallbackImage),
    textObjects: objects.filter((o) => o.omniType === "text").length,
    vectorGroups: objects.filter(
      (o) => o.omniType === "vectorGroup" || o.omniType === "vector",
    ).length,
    imageObjects: objects.filter((o) => o.omniType === "image").length,
    fallbackRegions: fallbackRegions.length,
    backdropImages: backdropImages.length,
    unsupportedOperators: unsupportedOperatorCount,
    unsupportedAnnotations,
    // Reported for transparency, but deliberately excluded from the
    // completeness decision: these carry no visible content.
    nonVisualAnnotations: Array.from(new Set(page.nonVisualAnnotations || [])),
    warnings: Array.from(new Set(warnings)),
    errors: [],
  };

  return {
    objects,
    fallbackRegions,
    // Set only when the backdrop can stand in for the whole-page render; the
    // importer composites it into a page-sized image and uses that as the
    // fallback asset instead of the render.
    fallbackImage,
    report,
    // Decision 6: no toggle UI this milestone. The fallback stays visible for
    // anything less than a fully recovered page so appearance is preserved.
    fallbackVisible: status !== "complete",
  };
}
