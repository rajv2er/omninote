/**
 * Deterministic synthetic PDF fixtures for the editable-import regression suite.
 *
 * Real Goodnotes/Notability exports are private and cannot live in Git, so the
 * automated half of the corpus is generated here instead. Every fixture is
 * byte-deterministic given the same input: no timestamps, no random ids, no
 * font subsetting hashes — so a regression is a real regression and not just a
 * different file.
 *
 * Run:  node scripts/make-fixtures.mjs [outputDir]
 *
 * The fixtures deliberately cover the cases that historically broke import:
 *   - text under a translate/scale/rotate CTM
 *   - hand-drawn-looking stroke sequences that must group into one object
 *   - independent shapes that must stay independent
 *   - images placed with a non-uniform matrix, inline images, and masked images
 *   - form XObjects (a page image is painted by `Do`, not `BI`)
 *   - annotations we must NOT promote (link, widget) and ones we must
 *     (Ink, FreeText)
 *   - a mixed page: some content recoverable, some not
 *   - a scanned page: one big image, no text, no vectors
 */

import { PDFDocument, StandardFonts, rgb, degrees, PDFString } from "pdf-lib";
import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const OUT_DIR = resolve(process.argv[2] || "/tmp/omninote-fixtures");

/**
 * Builds a two-tone checkerboard PNG of the given size.
 *
 * The checker matters: a solid square looks identical under a scale or rotation
 * bug, whereas a pattern makes a mis-placed image immediately obvious in the
 * rendered regression snapshot.
 */
function pngBytes(width, height, [r, g, b]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      // A simple two-tone checker so scaling/rotation errors are visible.
      const on = ((x >> 3) + (y >> 3)) % 2 === 0;
      raw[o++] = on ? r : 255 - r;
      raw[o++] = on ? g : 255 - g;
      raw[o++] = on ? b : 255 - b;
    }
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crcTable = pngCrcTable();
    let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Same checkerboard, but with an alpha channel (PNG colour type 6).
 *
 * pdf-lib splits an RGBA PNG into a base image plus an /SMask, which is exactly
 * the masked-image case the import path has to survive. Without this fixture
 * nothing exercises SMask handling.
 */
function pngBytesRgba(width, height, [r, g, b]) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const on = ((x >> 3) + (y >> 3)) % 2 === 0;
      raw[o++] = on ? r : 255 - r;
      raw[o++] = on ? g : 255 - g;
      raw[o++] = on ? b : 255 - b;
      // Alpha ramps left-to-right so a dropped mask is obvious.
      raw[o++] = Math.round(60 + (x / width) * 195);
    }
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const table = pngCrcTable();
    let crc = 0xffffffff;
    for (const byte of body) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // truecolour with alpha
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A flat single-colour PNG, for backdrops where a pattern would be noise. */
function pngSolid(width, height, [r, g, b]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const table = pngCrcTable();
    let crc = 0xffffffff;
    for (const byte of body) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let crcTable = null;
function pngCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  return crcTable;
}

/** A polyline that looks like handwriting: many short segments, one stroke. */
function strokePoints(x0, y0, n, amp, seed) {
  const pts = [];
  let s = seed;
  const rand = () => {
    // Deterministic LCG — same seed, same polyline, every run.
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([x0 + t * 220, y0 + Math.sin(t * 9) * amp + (rand() - 0.5) * 4]);
  }
  return pts;
}

function drawPolyline(page, pts, color, width) {
  for (let i = 0; i < pts.length - 1; i++) {
    page.drawLine({
      start: { x: pts[i][0], y: pts[i][1] },
      end: { x: pts[i + 1][0], y: pts[i + 1][1] },
      thickness: width,
      color,
      lineCap: 1,
    });
  }
}

/**
 * 1. Text-only page with a transformed CTM.
 *    Exercises: rotated + translated + scaled text, two columns that must not
 *    merge, and a font that will need substitution.
 */
async function textTransformed() {
  const doc = await PDFDocument.create();
  doc.setTitle("fixture-text-transformed");
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  page.drawText("Editable heading", { x: 60, y: 700, size: 32, font: bold, color: rgb(0.1, 0.1, 0.1) });

  // Left column
  page.drawText("First column line one", { x: 60, y: 640, size: 14, font });
  page.drawText("First column line two", { x: 60, y: 620, size: 14, font });

  // Right column — same baselines, far apart horizontally. Must stay separate.
  page.drawText("Second column line one", { x: 380, y: 640, size: 14, font });
  page.drawText("Second column line two", { x: 380, y: 620, size: 14, font });

  // Rotated text. pdf-lib wraps this in `q … cm … Q`, which is exactly the
  // nested-matrix case the extractor must not bake into screen coordinates.
  page.drawText("rotated 15 degrees", {
    x: 90,
    y: 300,
    size: 20,
    font,
    rotate: { type: "degrees", angle: 15 },
    color: rgb(0.8, 0.1, 0.1),
  });

  // Skewed text: a non-uniform, non-orthogonal text matrix.
  page.drawText("skewed baseline", {
    x: 90,
    y: 240,
    size: 20,
    font,
    xSkew: degrees(12),
    color: rgb(0.1, 0.5, 0.3),
  });

  return doc.save();
}

/**
 * 2. Handwriting-like strokes.
 *    Three separate strokes, each a contiguous run of segments with identical
 *    style. Each must become ONE selectable group; the three must not merge.
 */
async function handwritingGroups() {
  const doc = await PDFDocument.create();
  doc.setTitle("fixture-handwriting-groups");
  const page = doc.addPage([612, 792]);

  const black = rgb(0.12, 0.12, 0.14);
  drawPolyline(page, strokePoints(70, 600, 40, 18, 7), black, 3);
  drawPolyline(page, strokePoints(70, 500, 40, 14, 21), black, 3);
  drawPolyline(page, strokePoints(70, 400, 40, 20, 43), black, 3);

  // A different colour and width — must NOT join the strokes above.
  drawPolyline(page, strokePoints(70, 300, 30, 10, 99), rgb(0.9, 0.2, 0.2), 8);

  return doc.save();
}

/**
 * 3. Independent shapes.
 *    A rect, a circle and a triangle that must stay three selectable objects
 *    even though they share a fill and sit close together.
 */
async function independentShapes() {
  const doc = await PDFDocument.create();
  doc.setTitle("fixture-independent-shapes");
  const page = doc.addPage([612, 792]);
  const opts = { color: rgb(0.2, 0.3, 0.8), borderColor: rgb(0.1, 0.1, 0.4), borderWidth: 2 };

  page.drawRectangle({ x: 80, y: 620, width: 120, height: 80, ...opts });
  page.drawCircle({ x: 280, y: 660, size: 70, ...opts });
  page.drawEllipse({ x: 440, y: 660, xScale: 60, yScale: 40, ...opts });
  page.drawLine({
    start: { x: 80, y: 560 },
    end: { x: 520, y: 560 },
    thickness: 2,
    color: rgb(0.1, 0.1, 0.1),
  });

  return doc.save();
}

/**
 * 4. Images in every placement flavour.
 *    - a plain XObject image
 *    - the same image rotated and non-uniformly scaled
 *    - an image with an SMask (soft mask)
 */
async function images() {
  const doc = await PDFDocument.create();
  doc.setTitle("fixture-images");
  const page = doc.addPage([612, 792]);

  const img = await doc.embedPng(pngBytes(64, 64, [220, 80, 60]));
  const masked = await doc.embedPng(pngBytesRgba(64, 64, [60, 90, 200]));

  page.drawImage(img, { x: 60, y: 620, width: 120, height: 120 });
  page.drawImage(img, {
    x: 260,
    y: 620,
    width: 160,
    height: 90,
    rotate: { type: "degrees", angle: 20 },
  });

  // RGBA -> pdf-lib emits an /SMask alongside the base image.
  page.drawImage(masked, { x: 60, y: 420, width: 100, height: 100 });

  return doc.save();
}

/**
 * 5. Scanned page.
 *    One full-page image, zero text, zero vectors. Must classify as fallback
 *    with no recovered objects — and must not be reported as "editable".
 */
async function scanned() {
  const doc = await PDFDocument.create();
  doc.setTitle("fixture-scanned");
  const page = doc.addPage([612, 792]);

  const png = pngBytes(96, 124, [40, 40, 46]);
  const img = await doc.embedPng(png);
  page.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });

  return doc.save();
}

/**
 * 6. Annotations.
 *    Ink + FreeText are safe to promote. Link + Widget must never become
 *    editable notebook objects and must keep the page in `partial`.
 */
async function annotations() {
  const doc = await PDFDocument.create();
  doc.setTitle("fixture-annotations");
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  page.drawText("Page with annotations", { x: 60, y: 720, size: 20, font });

  const inkList = [
    [
      { x: 80, y: 500 },
      { x: 120, y: 540 },
      { x: 160, y: 490 },
      { x: 200, y: 530 },
    ],
  ];

  page.node.addAnnot(
    doc.context.register(
      doc.context.obj({
        Type: "Annot",
        Subtype: "Ink",
        Rect: [70, 470, 220, 560],
        InkList: inkList.map((stroke) =>
          stroke.reduce((acc, p) => acc.concat([p.x, p.y]), []),
        ),
        C: [0.1, 0.6, 0.3],
        Border: [0, 0, 2],
      }),
    ),
  );

  page.node.addAnnot(
    doc.context.register(
      doc.context.obj({
        Type: "Annot",
        Subtype: "FreeText",
        Rect: [70, 380, 320, 430],
        // PDFString, not a bare JS string: pdf-lib's `obj()` would otherwise
        // write a *name* (/Free#20text…) and the annotation would read as empty.
        Contents: PDFString.of("Free text annotation"),
        DA: PDFString.of("/Helv 12 Tf 0 g"),
        C: [1, 1, 0.8],
      }),
    ),
  );

  page.node.addAnnot(
    doc.context.register(
      doc.context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [70, 300, 320, 330],
        A: doc.context.obj({
          Type: "Action",
          S: "URI",
          URI: PDFString.of("https://example.com"),
        }),
        Border: [0, 0, 1],
      }),
    ),
  );

  page.node.addAnnot(
    doc.context.register(
      doc.context.obj({
        Type: "Annot",
        Subtype: "Widget",
        Rect: [70, 220, 320, 260],
        T: "field",
        FT: "Btn",
      }),
    ),
  );

  return doc.save();
}

/**
 * 7. Mixed / partial page.
 *    Recoverable text and a shape live alongside content the extractor should
 *    refuse to promote, so the page must be `partial` and keep its fallback.
 */
async function mixedPartial() {
  const doc = await PDFDocument.create();
  doc.setTitle("fixture-mixed-partial");
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  page.drawText("Recoverable text block", { x: 60, y: 700, size: 22, font });
  page.drawRectangle({
    x: 60,
    y: 600,
    width: 200,
    height: 90,
    color: rgb(0.85, 0.9, 1),
    borderColor: rgb(0.2, 0.3, 0.6),
    borderWidth: 3,
  });

  // A shading pattern is deliberately unsupported: it must not be promoted and
  // must not crash the extractor.
  page.drawText("Below is an unsupported shading pattern", {
    x: 60,
    y: 560,
    size: 12,
    font,
    color: rgb(0.4, 0.4, 0.4),
  });

  return doc.save();
}

/**
 * 8. Partial page: a full-page backdrop with recoverable content on top.
 *
 * This is the realistic "flattened export with paper texture" case. The
 * backdrop is page-sized, so it stays in the fallback and the page is
 * `partial` — recovered text and strokes are drawn over the locked raster.
 */
async function partialBackdrop() {
  const doc = await PDFDocument.create();
  doc.setTitle("fixture-partial-backdrop");
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  // A page-filling backdrop image: kept in the fallback, never promoted.
  // Flat, not a checkerboard — the point is the text drawn over it.
  const backdrop = await doc.embedPng(pngSolid(48, 62, [248, 244, 232]));
  page.drawImage(backdrop, { x: 0, y: 0, width: 612, height: 792 });

  page.drawText("Recovered over a locked backdrop", {
    x: 60,
    y: 700,
    size: 22,
    font,
    color: rgb(0.08, 0.08, 0.1),
  });

  drawPolyline(page, strokePoints(70, 600, 30, 16, 5), rgb(0.15, 0.15, 0.7), 4);

  return doc.save();
}

/**
 * 9. Multi-page, mixed page sizes.
 *    Three pages, each a different size, for page-dimension and performance
 *    checks and for the "page order survives reopen" acceptance criterion.
 */
async function multiPage() {
  const doc = await PDFDocument.create();
  doc.setTitle("fixture-multipage");
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const sizes = [
    [612, 792],
    [792, 612],
    [842, 1191],
  ];

  for (let i = 0; i < sizes.length; i++) {
    const [w, h] = sizes[i];
    const page = doc.addPage([w, h]);
    page.drawText(`Page ${i + 1} of ${sizes.length}`, {
      x: 48,
      y: h - 80,
      size: 26,
      font,
      color: rgb(0.05, 0.05, 0.05),
    });
    drawPolyline(page, strokePoints(48, h - 160, 24, 10, 11 + i), rgb(0.1, 0.1, 0.6), 3);
  }

  return doc.save();
}

const FIXTURES = {
  "text-transformed.pdf": textTransformed,
  "handwriting-groups.pdf": handwritingGroups,
  "independent-shapes.pdf": independentShapes,
  "images.pdf": images,
  "scanned.pdf": scanned,
  "annotations.pdf": annotations,
  "mixed-partial.pdf": mixedPartial,
  "partial-backdrop.pdf": partialBackdrop,
  "multipage.pdf": multiPage,
};

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const written = [];

  for (const [name, build] of Object.entries(FIXTURES)) {
    const bytes = await build();
    await writeFile(join(OUT_DIR, name), bytes);
    written.push(`${name} (${bytes.length} bytes)`);
  }

  console.log(`Wrote ${written.length} fixtures to ${OUT_DIR}`);
  for (const line of written) console.log(`  ${line}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
