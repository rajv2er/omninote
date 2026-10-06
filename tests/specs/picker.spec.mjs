/**
 * Import-time page picker ("Choose pages…").
 *
 * The picker imports every page as an annotated PDF and decomposes only the
 * checked subset. These assertions guard the failure modes that are silent: a
 * page the user did not pick coming back editable, a picked page left as a
 * locked raster, and the un-picked pages losing the ability to promote later.
 */

import { join } from "node:path";
import {
  importPdf,
  inspectPage,
  noteSummary,
  objectCensus,
  openNote,
  focusPage,
  waitForEngine,
  waitForEngines,
} from "../lib/harness.mjs";

export const name = "Import page picker";

const recovered = (census) =>
  (census.text || 0) + (census.vectorGroup || 0) + (census.vector || 0);

export default async function run({ page, fixtures, check }) {
  /* --- the picker appears, and a subset is chosen ------------------------- */
  const { openLibrary, noteIds } = await import("../lib/harness.mjs");
  await openLibrary(page);
  await page.selectOption("#import-mode", "choose");

  const before = await noteIds(page);
  await page.setInputFiles("#pdf-input", join(fixtures, "multipage.pdf"));

  // The picker modal must appear before any notebook is created.
  await page.waitForSelector("#import-picker-overlay", { timeout: 30000 });
  check(
    "the page picker opens on 'Choose pages…'",
    (await page.locator("#import-picker-overlay").count()) === 1,
  );
  check(
    "the picker shows one tile per page",
    (await page.locator(".ip-tile").count()) === 3,
    `${await page.locator(".ip-tile").count()}`,
  );

  // The primary action is disabled until at least one page is checked.
  check(
    "'Make editable' starts disabled with nothing selected",
    await page.locator("#ip-import").isDisabled(),
  );

  // Pick page 2 only (index 1).
  await page.click('.ip-tile[data-index="1"]');
  check(
    "checking a page enables the import action",
    !(await page.locator("#ip-import").isDisabled()),
  );
  await page.click("#ip-import");

  // Import completes: one new notebook, picker gone.
  await page.waitForFunction(
    (n) => window.__omni.getNotes().length > n,
    before.length,
    { timeout: 180000 },
  );
  await page.waitForFunction(() => !document.querySelector(".loading-overlay"), {
    timeout: 180000,
  });
  const after = await noteIds(page);
  const created = after.filter((id) => !before.includes(id));
  const noteId = created[0];
  check("the picker import created one notebook", created.length === 1);

  /* --- only the chosen page is editable; the rest stay annotate ----------- */
  let summary = await noteSummary(page, noteId);
  console.log(`      choose-pages → modes ${JSON.stringify(summary.editModes)}`);
  check(
    "only the chosen page was decomposed",
    summary.editModes[0] === "annotate" &&
      summary.editModes[1] === "notes" &&
      summary.editModes[2] === "annotate",
    JSON.stringify(summary.editModes),
  );
  check(
    "the un-picked pages can still be promoted later",
    summary.conversionStates[0] === "idle" && summary.conversionStates[2] === "idle",
    JSON.stringify(summary.conversionStates),
  );

  /* --- the chosen page's objects are real after a reopen ------------------ */
  await openNote(page, noteId);
  // Scroll through all pages so each engine mounts for inspection.
  await waitForEngines(page, 3);

  const page1 = await inspectPage(page, 1);
  check(
    "the chosen page recovered real objects",
    recovered(await censusOf(page, 1)) >= 1,
    JSON.stringify(await censusOf(page, 1)),
  );
  check(
    "an un-picked page stays a locked raster",
    (await inspectPage(page, 0)).objects.length === 0,
  );

  await openNote(page, noteId);
  summary = await noteSummary(page, noteId);
  check(
    "the chosen page stays editable across a reopen",
    summary.editModes[1] === "notes",
    String(summary.editModes[1]),
  );
}

/** Counts recovered objects on a single page. */
async function censusOf(page, index) {
  const info = await inspectPage(page, index);
  const counts = {};
  for (const o of info?.objects || []) {
    const k = o.omniType || o.type;
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}
