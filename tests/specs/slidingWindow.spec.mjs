/**
 * Canvas sliding window regression tests.
 *
 * Only a small window of pages has live OmniCanvas engines at any time. These
 * assertions guard the user-visible breakage that causes: lost undo history,
 * edits not surviving scroll, pages failing to remount, zoom dying once the
 * window leaves page 0, blank/broken off-window previews, the toolbar showing
 * the wrong page's undo state, and page insert / delete shifting content onto
 * the wrong page.
 *
 * Each group runs inside `section(...)` so one broken precondition cannot hide
 * the state of the others.
 */

import { join } from "node:path";
import {
  importPdf,
  inspectPage,
  openNote,
  drawStroke,
  waitForEngines,
  confirmDialog,
} from "../lib/harness.mjs";

export const name = "Sliding window";

/**
 * Puts a page's top at the top of the scroll viewport without animation.
 *
 * `scrollIntoView` inherits `scroll-behavior: smooth` from the workspace, so
 * the observer sees a stream of intermediate scroll positions and the window
 * lands somewhere the test cannot predict. Writing `scrollTop` directly makes
 * "the page I asked for is the visible one" deterministic.
 */
const scrollPageToTop = (page, index) =>
  page.evaluate((i) => {
    const container = document.querySelector("#canvas-scroll-container");
    const el = document.querySelector(`#page-wrapper-${i}`);
    if (!container || !el) return;
    const prev = container.style.scrollBehavior;
    container.style.scrollBehavior = "auto";
    container.scrollTop = el.offsetTop - 40;
    container.style.scrollBehavior = prev;
  }, index);

/** Scrolls to `index` and waits for the engine window to match exactly. */
async function settle(page, index, total) {
  await scrollPageToTop(page, index);
  await page.waitForFunction(
    ({ i, n }) => {
      const note = window.__omni
        .getNotes()
        .find((x) => x.id === window.__omni.getActiveId());
      if (!note || note.currentPageIndex !== i) return false;
      const engines = window.__omni.getEngines();
      for (let k = 0; k < n; k++) {
        if (Boolean(engines[k]) !== (Math.abs(k - i) <= 1)) return false;
      }
      return true;
    },
    { i: index, n: total },
    { timeout: 10000 },
  );
}

/** Reads the zoom the live engine for `index` is actually rendering at. */
const engineZoom = (page, index) =>
  page.evaluate((i) => {
    const engine = window.__omni.getEngines()[i];
    return engine ? engine.currentZoom : null;
  }, index);

/** The static preview shown for a page that is outside the live window. */
const thumbnailState = (page, index) =>
  page.evaluate((i) => {
    const canvas = document.querySelector(`#omni-canvas-${i}`);
    const thumb = document.querySelector(`#omni-thumb-${i}`);
    if (!canvas || !thumb) return null;
    return {
      canvasHidden: canvas.hidden,
      thumbHidden: thumb.hidden,
      thumbWidth: thumb.naturalWidth,
      thumbHeight: thumb.naturalHeight,
    };
  }, index);

/** Page dimensions in CSS pixels, straight from the notebook record. */
const pageSizes = (page, noteId) =>
  page.evaluate((id) => {
    const note = window.__omni.getNotes().find((x) => x.id === id);
    return note.pages.map((p) => [Math.round(p.width), Math.round(p.height)]);
  }, noteId);

export default async function run({ page, fixtures, check }) {
  const noteId = await importPdf(page, join(fixtures, "multipage.pdf"), {
    mode: "annotations",
  });

  await openNote(page, noteId);
  await waitForEngines(page, 3);

  /** Runs one group, reporting a precondition failure as its own check. */
  const section = async (label, fn) => {
    try {
      await fn();
    } catch (err) {
      check(`${label} — group completed`, false, err.message.split("\n")[0]);
    }
  };

  /* ----------------------------------------------------------------- *
   * The original regression: an edit must survive scrolling away and back,
   * and so must the undo history for that page.
   * ----------------------------------------------------------------- */

  await section("edit + undo survive the window", async () => {
    await settle(page, 1, 3);
    await drawStroke(page, 1);
    const afterDraw = await inspectPage(page, 1);
    check(
      "page 1 captured the stroke",
      afterDraw.objects.length > 0,
      `${afterDraw.objects.length} object(s)`,
    );

    await settle(page, 0, 3);
    await settle(page, 2, 3);
    await settle(page, 1, 3);

    const back = await inspectPage(page, 1);
    check(
      "page 1 still has its objects after leaving the window",
      back.objects.length > 0,
      `${back.objects.length} object(s)`,
    );

    await page.click("#undo-btn");
    const undone = await inspectPage(page, 1);
    check(
      "undo history survived the page leaving the sliding window",
      undone.objects.length === 0,
      `${undone.objects.length} object(s)`,
    );
  });

  /* ----------------------------------------------------------------- *
   * Off-window pages must show a real static preview, not a broken image.
   * ----------------------------------------------------------------- */

  await section("off-window preview", async () => {
    await settle(page, 2, 3);

    const offWindow = await page.evaluate(() => !window.__omni.getEngines()[0]);
    check("page 0 has no engine while page 2 is on screen", offWindow);

    // The preview renders asynchronously; give it a chance to land.
    await page
      .waitForFunction(
        () => {
          const t = document.querySelector("#omni-thumb-0");
          return Boolean(t) && !t.hidden && t.naturalWidth > 0;
        },
        undefined,
        { timeout: 8000 },
      )
      .catch(() => {});

    const thumb = await thumbnailState(page, 0);
    check(
      "an off-window page is swapped to its static thumbnail",
      Boolean(thumb) && thumb.canvasHidden && !thumb.thumbHidden,
      JSON.stringify(thumb),
    );
    check(
      "the off-window thumbnail actually rendered pixels",
      Boolean(thumb) && thumb.thumbWidth > 0 && thumb.thumbHeight > 0,
      `natural ${thumb?.thumbWidth}×${thumb?.thumbHeight}`,
    );
  });

  /* ----------------------------------------------------------------- *
   * Zoom must keep working when the window no longer starts at page 0.
   * The engine array is sparse there, so anything that blindly iterates it
   * throws and every zoom control goes dead.
   * ----------------------------------------------------------------- */

  await section("zoom with a sparse engine array", async () => {
    await settle(page, 2, 3);

    const zoomBefore = await engineZoom(page, 2);
    await page.click("#zoom-in-btn");
    await page.waitForTimeout(200);
    const zoomAfter = await engineZoom(page, 2);
    check(
      "zooming still reaches the active engine after scrolling off page 0",
      zoomBefore != null && zoomAfter != null && zoomAfter > zoomBefore,
      `${zoomBefore} → ${zoomAfter}`,
    );

    // Zoom lock walks the same sparse array.
    await page.click("#zoom-lock-btn");
    await page.click("#zoom-lock-btn");
    await page.click("#zoom-reset-btn");
  });

  /* ----------------------------------------------------------------- *
   * The undo/redo buttons describe the page you are on. Changing pages has
   * to re-point them, or undo stays greyed out on a page with history.
   * ----------------------------------------------------------------- */

  await section("toolbar follows the active page", async () => {
    await settle(page, 1, 3);
    await drawStroke(page, 1);
    await settle(page, 2, 3);
    await settle(page, 1, 3);

    const undoDisabled = await page.evaluate(
      () => document.querySelector("#undo-btn").disabled,
    );
    check(
      "undo is enabled again after returning to a page with history",
      undoDisabled === false,
      `disabled=${undoDisabled}`,
    );
  });

  /* ----------------------------------------------------------------- *
   * Inserting a page must not copy the previous page's content onto the new
   * blank page (engines are keyed by index, and the pages shift under them).
   * ----------------------------------------------------------------- */

  await section("insert a page", async () => {
    await settle(page, 2, 3);
    await drawStroke(page, 2);
    const pageTwo = await inspectPage(page, 2);
    check(
      "page 2 captured its own stroke",
      pageTwo.objects.length > 0,
      `${pageTwo.objects.length} object(s)`,
    );

    await settle(page, 1, 3);
    await page.click("#add-page-btn");
    await page.waitForSelector("#page-wrapper-3");
    await settle(page, 2, 4);

    const inserted = await inspectPage(page, 2);
    check(
      "a newly inserted page starts blank",
      inserted != null && inserted.objects.length === 0,
      `${inserted?.objects.length} object(s)`,
    );
    const shifted = await inspectPage(page, 3);
    check(
      "inserting a page keeps the following page's content on it",
      shifted != null && shifted.objects.length > 0,
      `${shifted?.objects.length} object(s)`,
    );
  });

  /* ----------------------------------------------------------------- *
   * Deleting a page must not shift a neighbour's content onto another page.
   * The blank page sits between two pages; deleting it must leave the page
   * that follows untouched.
   * ----------------------------------------------------------------- */

  await section("delete a page", async () => {
    await settle(page, 2, 4);
    await page.click("#delete-page-btn");
    await confirmDialog(page);
    await page.waitForFunction(
      () => document.querySelectorAll(".page-container").length === 3,
    );
    await settle(page, 2, 3);

    const afterDelete = await inspectPage(page, 2);
    check(
      "deleting a page keeps the next page's content intact",
      afterDelete != null && afterDelete.objects.length > 0,
      `${afterDelete?.objects.length} object(s)`,
    );
  });

  /* ----------------------------------------------------------------- *
   * Page Manager ops act on pages the user is not looking at. Rotating a
   * page two or more away from the current one used to silently do nothing,
   * because only the windowed pages had an engine to rotate.
   * ----------------------------------------------------------------- */

  await section("rotate an off-window page", async () => {
    await settle(page, 0, 3);
    const before = await pageSizes(page, noteId);

    await page.click("#page-manager-btn");
    await page.waitForSelector("#page-manager-overlay", { timeout: 15000 });
    await page.click('.pm-tile[data-index="2"]');
    await page.click("#pm-rotate");

    await page
      .waitForFunction(
        ({ id, w, h }) => {
          const note = window.__omni.getNotes().find((x) => x.id === id);
          return (
            note &&
            Math.round(note.pages[2].width) === h &&
            Math.round(note.pages[2].height) === w
          );
        },
        { id: noteId, w: before[2][0], h: before[2][1] },
        { timeout: 20000 },
      )
      .catch(() => {});

    const after = await pageSizes(page, noteId);
    check(
      "rotating a page outside the window swaps its dimensions",
      after[2][0] === before[2][1] && after[2][1] === before[2][0],
      `${JSON.stringify(before[2])} → ${JSON.stringify(after[2])}`,
    );
    const rotatedRaster = await page.evaluate(async (id) => {
      const note = window.__omni.getNotes().find((n) => n.id === id);
      const p = note.pages[2];
      if (!p.backgroundAssetId) return null;
      const req = indexedDB.open("omninote-assets", 1);
      return new Promise((resolve) => {
        req.onsuccess = () => {
          const get = req.result.transaction("assets").objectStore("assets").get(p.backgroundAssetId);
          get.onsuccess = async () => {
            if (!(get.result instanceof Blob)) return resolve(null);
            const bitmap = await createImageBitmap(get.result);
            const size = [bitmap.width, bitmap.height];
            bitmap.close();
            resolve(size);
          };
          get.onerror = () => resolve(null);
        };
        req.onerror = () => resolve(null);
      });
    }, noteId);
    check(
      "rotating an off-window PDF stores a raster in the new orientation",
      rotatedRaster?.[0] > rotatedRaster?.[1],
      JSON.stringify(rotatedRaster),
    );

    await page.click("#pm-close");
    await page.waitForFunction(
      () => !document.querySelector("#page-manager-overlay"),
      { timeout: 15000 },
    );
  });
}
