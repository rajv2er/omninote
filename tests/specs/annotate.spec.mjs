/**
 * Annotate-first import and per-page "Make editable".
 *
 * An annotate import must produce pages that are nothing but a locked raster:
 * no recovered objects, nothing selectable, and immediately writable. Promotion
 * then swaps one page's raster for native objects — and must not cost the user
 * the ink they had already put on that page, because that ink is the whole
 * reason the page was usable before promotion.
 *
 * Every assertion here guards a failure mode that is silent: a lost stroke, a
 * page left half-converted, a batch that reports success while doing nothing.
 */

import { join } from "node:path";
import {
  importPdf,
  inspectPage,
  noteSummary,
  objectCensus,
  openNote,
  drawStroke,
  makeEditableCurrentPage,
  makeAllEditable,
  waitForEngines,
} from "../lib/harness.mjs";

export const name = "Annotate-first import & promotion";

/** Objects the user drew themselves carry no import metadata. */
const ownObjects = (info) => info.objects.filter((o) => !o.omniType);
const recovered = (census) =>
  (census.text || 0) + (census.vectorGroup || 0) + (census.vector || 0);

export default async function run({ page, fixtures, check }) {
  const noteId = await importPdf(page, join(fixtures, "multipage.pdf"), {
    mode: "annotations",
  });

  /* --- annotate mode is a raster, not a recovery -------------------------- */
  let summary = await noteSummary(page, noteId);
  console.log(`      annotate import → modes ${JSON.stringify(summary.editModes)}`);

  check(
    "annotate import leaves every page as an annotated PDF",
    summary.editModes.length === 3 &&
      summary.editModes.every((m) => m === "annotate"),
    JSON.stringify(summary.editModes),
  );
  check(
    "annotate import recovered nothing",
    summary.statuses.every((s) => s === "fallback"),
    JSON.stringify(summary.statuses),
  );
  check(
    "every annotated page has a raster in the asset store",
    summary.backgroundAssetIds.every(Boolean),
  );

  await openNote(page, noteId);
  let live = await inspectPage(page, 0);

  // Guard against every emptiness assertion below passing on a dead engine.
  check("page 0 has a live canvas engine", Boolean(live));
  check(
    "the annotated page paints its locked raster",
    live.hasBackground === true && live.backgroundVisible === true,
    `hasBackground=${live.hasBackground} visible=${live.backgroundVisible}`,
  );
  check(
    "the annotated page has no native objects at all",
    live.objects.length === 0,
    `${live.objects.length} object(s)`,
  );

  /* --- the promotion control is offered, and says what it will do --------- */
  check(
    "the current page offers 'Make editable'",
    (await page.locator("#make-editable-btn").count()) === 1,
  );
  check(
    "the batch control counts the remaining pages",
    (await page.locator("#make-all-editable-btn").count()) === 1,
  );

  /* --- ink drawn on the raster must survive promotion --------------------- */
  await drawStroke(page, 0);
  live = await inspectPage(page, 0);
  const drawn = ownObjects(live).length;
  check("the user's stroke landed on the annotated page", drawn === 1, `${drawn}`);

  await makeEditableCurrentPage(page, noteId);

  summary = await noteSummary(page, noteId);
  console.log(
    `      after promotion → mode ${summary.editModes[0]}, state ${summary.conversionStates[0]}`,
  );
  check(
    "promotion flips the page to notes",
    summary.editModes[0] === "notes",
    String(summary.editModes[0]),
  );
  check(
    "promotion settles out of the converting state",
    summary.conversionStates[0] === "idle",
    String(summary.conversionStates[0]),
  );

  live = await inspectPage(page, 0);
  let census = await objectCensus(page);
  console.log(`      after promotion → census ${JSON.stringify(census)}`);

  check(
    "promotion recovered real objects, not an empty page",
    recovered(census) >= 2,
    JSON.stringify(census),
  );
  check(
    "the ink the user had drawn is still there",
    ownObjects(live).length === 1,
    `${ownObjects(live).length} of the user's object(s)`,
  );
  check(
    "a rebuilt page no longer offers promotion",
    (await page.locator("#make-editable-btn").count()) === 0,
  );

  /* --- all of it survives a reopen --------------------------------------- */
  await openNote(page, noteId);
  await waitForEngines(page, 3);

  live = await inspectPage(page, 0);
  census = await objectCensus(page);
  check(
    "the rebuilt page keeps its recovered objects across a reopen",
    recovered(census) >= 2,
    JSON.stringify(census),
  );
  check(
    "the ink drawn before promotion survived the reopen",
    ownObjects(live).length === 1,
    `${ownObjects(live).length} of the user's object(s)`,
  );

  /* --- batch promotion --------------------------------------------------- */
  check(
    "the batch control is still offered for the two remaining pages",
    (await page.locator("#make-all-editable-btn").count()) === 1,
  );

  await makeAllEditable(page, noteId);

  summary = await noteSummary(page, noteId);
  console.log(`      after batch → modes ${JSON.stringify(summary.editModes)}`);
  check(
    "batch promotion rebuilt every remaining page",
    summary.editModes.every((m) => m === "notes"),
    JSON.stringify(summary.editModes),
  );
  check(
    "no page was left mid-conversion",
    summary.conversionStates.every((s) => s !== "converting"),
    JSON.stringify(summary.conversionStates),
  );
  check(
    "the promotion controls disappear once nothing is left to rebuild",
    (await page.locator("#promote-controls").count()) === 0,
  );

  // Batch stores a handoff rather than instantiating, so the objects only have
  // to be real after the pages are opened again.
  await openNote(page, noteId);
  await waitForEngines(page, 3);
  census = await objectCensus(page);
  console.log(`      after reopen → census ${JSON.stringify(census)}`);
  check(
    "every page has its objects after the batch handoff is consumed",
    (census.text || 0) === 3,
    JSON.stringify(census),
  );
}
