/**
 * In-editor page selection for decomposition.
 *
 * An annotate-first import can be opened and written on immediately; the user
 * then picks which pages to rebuild as editable objects from the Page Manager,
 * without leaving the notebook. These assertions guard the failure modes that
 * are silent: a selected page left as a locked raster, an unselected page
 * decomposed anyway, or the notebook forgetting the result on reopen.
 */

import { join } from "node:path";
import {
  importPdf,
  inspectPage,
  noteSummary,
  openNote,
  waitForEngines,
} from "../lib/harness.mjs";

export const name = "In-editor page selection (Page Manager)";

export default async function run({ page, fixtures, check }) {
  // Import as annotate-first: every page starts as a locked raster.
  const noteId = await importPdf(page, join(fixtures, "multipage.pdf"), {
    mode: "annotations",
  });

  let summary = await noteSummary(page, noteId);
  check(
    "annotate import leaves every page as an annotated PDF",
    summary.editModes.every((m) => m === "annotate"),
    JSON.stringify(summary.editModes),
  );

  await openNote(page, noteId);
  await waitForEngines(page, 3);

  /* --- open the Page Manager and select a subset --------------------------- */
  await page.click("#page-manager-btn");
  await page.waitForSelector("#page-manager-overlay", { timeout: 15000 });

  check(
    "the Page Manager offers 'Make editable' for an annotate notebook",
    (await page.locator("#pm-make-editable").count()) === 1,
  );
  check(
    "'Make editable' starts disabled with nothing selected",
    await page.locator("#pm-make-editable").isDisabled(),
  );

  // Select pages 1 and 3 (indices 0 and 2), leaving page 2 annotate-mode.
  await page.click('.pm-tile[data-index="0"]');
  await page.click('.pm-tile[data-index="2"]');
  check(
    "selecting pages enables the op",
    !(await page.locator("#pm-make-editable").isDisabled()),
  );

  await page.click("#pm-make-editable");

  // The overlay re-renders after the op; wait until both pages settle out of
  // the converting state.
  await page.waitForFunction(
    (id) => {
      const n = window.__omni.getNotes().find((x) => x.id === id);
      return (
        n &&
        n.pages.every((p) => p.conversionState !== "converting") &&
        n.pages[0].editMode === "notes" &&
        n.pages[2].editMode === "notes"
      );
    },
    noteId,
    { timeout: 180000 },
  );

  summary = await noteSummary(page, noteId);
  console.log(`      pm-make-editable → modes ${JSON.stringify(summary.editModes)}`);
  check(
    "only the selected pages were decomposed",
    summary.editModes[0] === "notes" &&
      summary.editModes[1] === "annotate" &&
      summary.editModes[2] === "notes",
    JSON.stringify(summary.editModes),
  );
  check(
    "no page was left mid-conversion",
    summary.conversionStates.every((s) => s !== "converting"),
    JSON.stringify(summary.conversionStates),
  );

  /* --- the result survives a reopen ---------------------------------------- */
  // The op leaves the Page Manager open; close it before navigating back to
  // the library, or the overlay swallows the open-notebook click.
  await page.click("#pm-close");
  await page.waitForFunction(
    () => !document.querySelector("#page-manager-overlay"),
    { timeout: 15000 },
  );

  await openNote(page, noteId);
  await waitForEngines(page, 3);

  const p0 = await inspectPage(page, 0);
  const p1 = await inspectPage(page, 1);
  const p2 = await inspectPage(page, 2);
  check(
    "a decomposed page has recovered objects after reopen",
    (p0.objects.length > 0) && (p2.objects.length > 0),
    `p0=${p0.objects.length} p2=${p2.objects.length}`,
  );
  check(
    "the skipped page stays a locked raster",
    p1.objects.length === 0,
    `${p1.objects.length} object(s)`,
  );

  summary = await noteSummary(page, noteId);
  check(
    "the modes persist across a reopen",
    summary.editModes[0] === "notes" &&
      summary.editModes[1] === "annotate" &&
      summary.editModes[2] === "notes",
    JSON.stringify(summary.editModes),
  );
}
