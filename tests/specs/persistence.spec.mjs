/**
 * Persistence and asset lifecycle.
 *
 * Two failure modes live here, both of which shipped:
 *   - a page whose object graph never landed in IndexedDB comes back blank;
 *   - delete-forever left every page payload and embedded image orphaned.
 */

import { join } from "node:path";
import {
  deleteForever,
  drawStroke,
  idbDelete,
  idbKeys,
  importPdf,
  inspectPage,
  noteSummary,
  objectCensus,
  openNote,
} from "../lib/harness.mjs";

export const name = "Persistence & asset lifecycle";

export default async function run({ page, fixtures, check }) {
  /* --- ink survives a save/reload ---------------------------------------- */
  const id = await importPdf(page, join(fixtures, "partial-backdrop.pdf"));
  await openNote(page, id);

  const before = await objectCensus(page);
  await drawStroke(page, 0);
  const drawn = await objectCensus(page);
  const total = (c) => Object.values(c).reduce((a, b) => a + b, 0);
  console.log(`      before ${JSON.stringify(before)}`);
  console.log(`      after draw ${JSON.stringify(drawn)}`);

  check(
    "drawing added an object to the page",
    total(drawn) > total(before),
    `${total(before)} -> ${total(drawn)}`,
  );

  await page.reload();
  await page.waitForFunction(() => Boolean(window.__omni));
  await page.waitForTimeout(2000);
  await openNote(page, id);
  const reopened = await objectCensus(page);
  console.log(`      after reopen ${JSON.stringify(reopened)}`);

  check(
    "ink, text, vectors and images all survive a reopen",
    total(drawn) > 0 && total(reopened) === total(drawn),
    `${total(drawn)} -> ${total(reopened)}`,
  );
  check(
    "the recovered text survived the reopen",
    (reopened.text || 0) === (drawn.text || 0) && (reopened.text || 0) > 0,
    `text ${drawn.text || 0} -> ${reopened.text || 0}`,
  );
  check(
    "the locked backdrop survived the reopen",
    (await inspectPage(page, 0)).hasBackground === true,
  );

  /* --- thumbnail refresh actually writes --------------------------------- */
  // The import path writes a thumbnail too, so delete it first: only then does
  // a missing thumbnail prove the refresh path failed.
  const thumbId = (await noteSummary(page, id)).thumbnailAssetIds[0];
  check("page 0 has a thumbnail asset id", Boolean(thumbId), String(thumbId));

  await idbDelete(page, thumbId);
  const afterDelete = await idbKeys(page);
  check("thumbnail asset removed to force a rewrite", !afterDelete.includes(thumbId));

  await drawStroke(page, 0);
  const afterDraw = await idbKeys(page);
  check(
    "drawing rewrites the library thumbnail",
    afterDraw.includes(thumbId),
    `asset ${thumbId} ${afterDraw.includes(thumbId) ? "present" : "MISSING"}`,
  );

  /* --- delete-forever cleans up, and only its own assets ------------------ */
  const victim = await importPdf(page, join(fixtures, "images.pdf"));
  const survivor = await importPdf(page, join(fixtures, "multipage.pdf"));

  // Image blobs are referenced from the recovered objects, so collect them
  // from the live engine rather than trusting the notebook record.
  await openNote(page, victim);
  const victimImageAssets = await page.evaluate(() => {
    const out = [];
    for (let i = 0; i < 64; i++) {
      const info = window.__omni.inspectPage(i);
      if (!info) break;
      for (const o of info.objects) {
        if (o.omniType === "image" && o.assetId) out.push(o.assetId);
      }
    }
    return out;
  });
  check(
    "the victim notebook has decoded image assets to clean up",
    victimImageAssets.length > 0,
    `${victimImageAssets.length}`,
  );

  const candidates = async (noteId, extra = []) => {
    const n = await noteSummary(page, noteId);
    const ids = [...extra];
    for (const p of n.pageIds) {
      ids.push(`canvas-${p}`, `pending-${p}`);
    }
    for (const a of n.backgroundAssetIds) if (a) ids.push(a);
    for (const a of n.thumbnailAssetIds) if (a) ids.push(a);
    return ids;
  };

  const keysBefore = await idbKeys(page);
  const present = (ids) => ids.filter((k) => keysBefore.includes(k));
  // Only assert on assets that actually exist — `pending-*` handoffs are
  // deliberately deleted once the import consumes them.
  const victimKeys = present(await candidates(victim, victimImageAssets));
  const survivorKeys = present(await candidates(survivor));
  console.log(
    `      victim has ${victimKeys.length} assets, survivor has ${survivorKeys.length}`,
  );

  await deleteForever(page, victim);
  const keysAfter = await idbKeys(page);
  console.log(`      idb keys ${keysBefore.length} -> ${keysAfter.length}`);

  const leftBehind = victimKeys.filter((k) => keysAfter.includes(k));
  const destroyed = survivorKeys.filter((k) => !keysAfter.includes(k));

  check(
    "the victim had real assets to remove (guard against a vacuous pass)",
    victimKeys.length >= 3,
    `${victimKeys.length}`,
  );
  check(
    "delete-forever removed every asset the victim owned",
    leftBehind.length === 0,
    leftBehind.length ? `left: ${leftBehind.join(", ")}` : `${victimKeys.length} removed`,
  );
  check(
    "delete-forever left every other notebook's assets alone",
    destroyed.length === 0,
    destroyed.length ? `destroyed: ${destroyed.join(", ")}` : `${survivorKeys.length} intact`,
  );
  check(
    "the surviving notebook is still listed",
    (await noteSummary(page, survivor)) !== null,
  );
}
