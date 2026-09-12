/**
 * PDF import regressions.
 *
 * These guard the differentiator: that a PDF's content is recovered as native
 * objects, that the locked fallback stays behind them, and that both survive a
 * reopen. Every case here corresponds to a bug that actually shipped.
 */

import { join } from "node:path";
import {
  importPdf,
  idbKeys,
  inspectPage,
  noteSummary,
  objectCensus,
  openNote,
} from "../lib/harness.mjs";

export const name = "PDF import";

export default async function run({ page, fixtures, check }) {
  /* --- embedded images are decoded and kept ------------------------------- */
  const imagesId = await importPdf(page, join(fixtures, "images.pdf"));
  const images = await noteSummary(page, imagesId);
  console.log(`      images.pdf → statuses ${JSON.stringify(images.statuses)}`);

  await openNote(page, imagesId);
  const live = await inspectPage(page, 0);
  const census = await objectCensus(page);
  console.log(`      census ${JSON.stringify(census)}`);

  // Guard against every later assertion passing vacuously on a dead engine.
  check("page 0 has a live canvas engine", live !== null && live !== undefined);

  check(
    "images.pdf imports as a single notebook",
    images.pages === 1,
    `${images.pages} page(s)`,
  );
  check(
    "image objects were recovered, not just a raster",
    (census.image || 0) >= 1,
    `${census.image || 0} image object(s)`,
  );

  const imageAssets = await page.evaluate(() => {
    const out = [];
    for (let i = 0; i < 8; i++) {
      const info = window.__omni.inspectPage(i);
      if (!info) break;
      for (const o of info.objects) {
        if (o.omniType === "image" && o.assetId) out.push(o.assetId);
      }
    }
    return out;
  });
  const keys = await idbKeys(page);
  check(
    "every recovered image has its blob in IndexedDB",
    imageAssets.length > 0 && imageAssets.every((id) => keys.includes(id)),
    `${imageAssets.filter((id) => keys.includes(id)).length}/${imageAssets.length} present`,
  );

  /* --- and they come back after a reopen --------------------------------- */
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__omni));
  await page.waitForTimeout(1500);
  await openNote(page, imagesId);
  const censusAfter = await objectCensus(page);
  console.log(`      census after reopen ${JSON.stringify(censusAfter)}`);
  check(
    "recovered images survive a reopen",
    (census.image || 0) > 0 && (censusAfter.image || 0) === (census.image || 0),
    `${census.image || 0} -> ${censusAfter.image || 0}`,
  );

  /* --- a scanned page stays a locked raster ------------------------------- */
  const scannedId = await importPdf(page, join(fixtures, "scanned.pdf"));
  const scanned = await noteSummary(page, scannedId);
  await openNote(page, scannedId);
  const scannedInfo = await inspectPage(page, 0);
  const scannedCensus = await objectCensus(page);
  console.log(
    `      scanned.pdf → status=${scanned.statuses[0]} census=${JSON.stringify(scannedCensus)}`,
  );

  check(
    "scanned.pdf page has a live canvas engine",
    scannedInfo !== null && scannedInfo !== undefined,
  );
  check(
    "scanned.pdf is classified fallback, not editable",
    scanned.statuses[0] === "fallback",
    `status=${scanned.statuses[0]}`,
  );
  check(
    "scanned.pdf recovered no objects",
    (scannedInfo?.objects?.length ?? -1) === 0,
    `${scannedInfo?.objects?.length} object(s)`,
  );
  check(
    "scanned.pdf keeps its locked raster as the page background",
    scannedInfo?.hasBackground === true,
  );

  /* --- partial pages keep their furniture behind recovered objects -------- */
  const partialId = await importPdf(page, join(fixtures, "partial-backdrop.pdf"));
  const partial = await noteSummary(page, partialId);
  await openNote(page, partialId);
  const partialInfo = await inspectPage(page, 0);
  const partialCensus = await objectCensus(page);
  console.log(
    `      partial-backdrop.pdf → status=${partial.statuses[0]} census=${JSON.stringify(partialCensus)}`,
  );

  check(
    "partial-backdrop.pdf is classified partial",
    partial.statuses[0] === "partial",
    `status=${partial.statuses[0]}`,
  );
  check(
    "partial-backdrop.pdf recovered text and vectors",
    (partialCensus.text || 0) >= 1 &&
      (partialCensus.vectorGroup || 0) + (partialCensus.vector || 0) >= 1,
    JSON.stringify(partialCensus),
  );
  check(
    "partial-backdrop.pdf keeps the backdrop behind the recovered objects",
    partialInfo.hasBackground === true && partialInfo.backgroundVisible === true,
    `hasBackground=${partialInfo.hasBackground} visible=${partialInfo.backgroundVisible}`,
  );

  /* --- multi-page order and dimensions survive a reopen ------------------- */
  const multiId = await importPdf(page, join(fixtures, "multipage.pdf"));
  const multi = await noteSummary(page, multiId);
  console.log(`      multipage.pdf → sizes ${JSON.stringify(multi.pageSizes)}`);

  check("multipage.pdf yields three pages", multi.pages === 3, `${multi.pages}`);

  const [p1, p2, p3] = multi.pageSizes;
  check(
    "page orientations follow the source (portrait, landscape, portrait)",
    p1[1] > p1[0] && p2[0] > p2[1] && p3[1] > p3[0],
    JSON.stringify(multi.pageSizes),
  );
  check(
    "the third page is the largest, as in the source",
    p3[1] > p1[1] && p3[0] >= p1[0],
    `p1=${p1[1]} p3=${p3[1]}`,
  );

  await page.reload();
  await page.waitForFunction(() => Boolean(window.__omni));
  await page.waitForTimeout(1500);
  const multiAfter = await noteSummary(page, multiId);
  check(
    "page order and dimensions survive a reopen",
    JSON.stringify(multiAfter.pageSizes) === JSON.stringify(multi.pageSizes),
    JSON.stringify(multiAfter.pageSizes),
  );
}
