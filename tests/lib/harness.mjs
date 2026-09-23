/**
 * Shared plumbing for the OmniNote browser regression suite.
 *
 * The suite drives the real app in a real browser against deterministic
 * synthetic fixtures, because every regression worth guarding here has been a
 * rendering or persistence bug that only shows up when the whole pipeline runs.
 *
 * A browser is required but not bundled: `playwright-core` drives whatever
 * Chrome-family binary is already on the machine. Override with OMNI_BROWSER.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const execFileAsync = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const BROWSER_CANDIDATES = [
  process.env.OMNI_BROWSER,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

export function resolveBrowserPath() {
  const found = BROWSER_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      "No Chrome-family browser found. Set OMNI_BROWSER to an executable path.\n" +
        "Looked in:\n  " +
        BROWSER_CANDIDATES.join("\n  "),
    );
  }
  return found;
}

export function launchBrowser() {
  return chromium.launch({
    executablePath: resolveBrowserPath(),
    headless: !process.env.OMNI_HEADED,
    args: ["--no-sandbox"],
  });
}

/** Minimal reporter: every assertion prints, failures are collected. */
export function createChecker(specName) {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok });
    console.log(`    ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };
  return { specName, check, results };
}

/* ------------------------------------------------------------------ *
 * IndexedDB probes, evaluated inside the page.
 * ------------------------------------------------------------------ */

export const IDB_KEYS = `async () => {
  return new Promise((resolve) => {
    const req = indexedDB.open("omninote-assets", 1);
    req.onerror = () => resolve([]);
    req.onsuccess = () => {
      const tx = req.result.transaction("assets", "readonly");
      const keys = tx.objectStore("assets").getAllKeys();
      keys.onsuccess = () => resolve(keys.result.map(String));
      keys.onerror = () => resolve([]);
    };
  });
}`;

export const IDB_DELETE = `async (key) => {
  return new Promise((resolve) => {
    const req = indexedDB.open("omninote-assets", 1);
    req.onerror = () => resolve(false);
    req.onsuccess = () => {
      const tx = req.result.transaction("assets", "readwrite");
      tx.objectStore("assets").delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    };
  });
}`;

export const idbKeys = (page) => page.evaluate(eval(`(${IDB_KEYS})`));
export const idbDelete = (page, key) => page.evaluate(eval(`(${IDB_DELETE})`), key);

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/**
 * Generates the synthetic PDF corpus. Deterministic, so a failure is a real
 * regression rather than a different input file.
 */
export async function generateFixtures(outDir) {
  await execFileAsync(
    process.execPath,
    [join(REPO_ROOT, "scripts", "make-fixtures.mjs"), outDir],
    { cwd: REPO_ROOT },
  );
  return outDir;
}

/* ------------------------------------------------------------------ *
 * App driving
 * ------------------------------------------------------------------ */

/** Waits for the app shell, which is assigned before the first render. */
export async function waitForApp(page) {
  await page.waitForFunction(() => Boolean(window.__omni));
}

/**
 * The library view. A profile with no saved notebooks is seeded with a sample
 * one and opens straight into the editor, so step back first.
 */
export async function openLibrary(page) {
  if (await page.locator("#back-btn").count()) {
    await page.click("#back-btn");
  }
  await page.waitForSelector("#pdf-input", { state: "attached" });
}

export const noteIds = (page) =>
  page.evaluate(() => window.__omni.getNotes().map((n) => n.id));

/**
 * Imports a PDF and returns the id of the notebook it created.
 *
 * Waits on the notebook count rather than the loading overlay: the overlay is
 * removed and re-added around work, so counting notebooks is the only
 * unambiguous "the import finished" signal.
 */
export async function importPdf(page, file, { timeout = 180000, mode = null } = {}) {
  // The import control only exists in the library view.
  await openLibrary(page);
  // "editable" is the default; "annotations" imports the page as a locked
  // raster the user can promote one page at a time.
  if (mode) await page.selectOption("#import-mode", mode);
  const before = await noteIds(page);
  await page.setInputFiles("#pdf-input", file);
  await page.waitForFunction(
    (n) => window.__omni.getNotes().length > n,
    before.length,
    { timeout },
  );
  await page.waitForFunction(() => !document.querySelector(".loading-overlay"), {
    timeout,
  });

  const after = await noteIds(page);
  const created = after.filter((id) => !before.includes(id));
  if (created.length !== 1) {
    throw new Error(`expected 1 new notebook, got ${created.length}`);
  }
  return created[0];
}

/**
 * Waits until the canvas engine for `index` exists.
 *
 * `initEditor` is async and runs after the canvas element is in the DOM, so a
 * freshly opened notebook briefly has a `<canvas>` with no engine behind it.
 * `inspectPage` returns null in that window — inspecting too early reads as
 * "the page is empty" and silently passes every emptiness assertion.
 */
export async function waitForEngine(page, index = 0) {
  await page.waitForFunction(
    (i) => Boolean(window.__omni.inspectPage(i)),
    index,
    { timeout: 30000 },
  );
}

/** Opens a notebook from the library grid. */
export async function openNote(page, noteId) {
  await openLibrary(page);
  await page.click(`[data-open="${noteId}"]`);
  await page.waitForSelector(`#omni-canvas-0`);
  await waitForEngine(page, 0);
}

/**
 * Waits until every one of `count` pages has a live engine.
 *
 * `initEditor` builds engines one page at a time, so waiting on page 0 alone
 * means a later `objectCensus` can silently stop at the first missing engine and
 * under-report.
 */
export async function waitForEngines(page, count) {
  await page.waitForFunction(
    (n) => {
      for (let i = 0; i < n; i++) {
        if (!window.__omni.inspectPage(i)) return false;
      }
      return true;
    },
    count,
    { timeout: 30000 },
  );
}

/** Page-level facts that live in the notebook record, not the engine. */
export const noteSummary = (page, noteId) =>
  page.evaluate((id) => {
    const n = window.__omni.getNotes().find((x) => x.id === id);
    if (!n) return null;
    return {
      id: n.id,
      title: n.title,
      isPdf: n.isPdf,
      pages: n.pages.length,
      pageIds: n.pages.map((p) => p.id),
      pageSizes: n.pages.map((p) => [Math.round(p.width), Math.round(p.height)]),
      statuses: n.pages.map((p) => p.importReport?.status ?? null),
      reports: n.pages.map((p) => p.importReport ?? null),
      backgroundAssetIds: n.pages.map((p) => p.backgroundAssetId ?? null),
      thumbnailAssetIds: n.pages.map((p) => p.thumbnailAssetId ?? null),
      editModes: n.pages.map((p) => p.editMode ?? null),
      conversionStates: n.pages.map((p) => p.conversionState ?? null),
      decomposed: n.pages.map((p) => p.decomposedObjects === true),
    };
  }, noteId);

/** What the live canvas engine actually holds for a page. */
export const inspectPage = (page, index) =>
  page.evaluate((i) => window.__omni.inspectPage(i), index);

/** Counts live objects by `omniType` across the currently open notebook. */
export const objectCensus = (page) =>
  page.evaluate(() => {
    const counts = {};
    for (let i = 0; i < 64; i++) {
      const info = window.__omni.inspectPage(i);
      if (!info) break;
      for (const o of info.objects) {
        const k = o.omniType || o.type;
        counts[k] = (counts[k] || 0) + 1;
      }
    }
    return counts;
  });

/** Draws a stroke on page `index` with the pen tool. */
export async function drawStroke(page, index = 0, { dx = 14, steps = 12 } = {}) {
  await page.click('[data-tool="pen"]');
  const box = await page.locator(`#omni-canvas-${index}`).boundingBox();
  const x0 = box.x + 120;
  const y0 = box.y + 160;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 0; i < steps; i++) {
    await page.mouse.move(x0 + i * dx, y0 + Math.sin(i / 2) * 22);
  }
  await page.mouse.up();
  // Payload writes are async; thumbnails are debounced 600 ms.
  await page.waitForTimeout(2200);
}

/** Moves a notebook to the trash, then deletes it forever. */
export async function deleteForever(page, noteId) {
  await openLibrary(page);
  await page.click(`[data-delete-note="${noteId}"]`);
  await page.waitForTimeout(300);
  await page.click('.side[data-folder="trashed"]');
  await page.waitForSelector(`[data-delete-note="${noteId}"]`);
  await page.click(`[data-delete-note="${noteId}"]`);
  await page.waitForTimeout(2200);
}

/* ------------------------------------------------------------------ *
 * Promotion ("Make editable")
 * ------------------------------------------------------------------ */

/**
 * Waits until no page of `noteId` is mid-conversion.
 *
 * Promotion runs asynchronously and updates the control in place rather than
 * re-rendering, so the only trustworthy completion signal is the page records
 * settling back out of "converting".
 */
export async function waitForPromotion(page, noteId, { timeout = 120000 } = {}) {
  await page.waitForFunction(
    (id) => {
      const n = window.__omni.getNotes().find((x) => x.id === id);
      if (!n) return false;
      return n.pages.every((p) => p.conversionState !== "converting");
    },
    noteId,
    { timeout },
  );
}

/** Promotes the page currently on screen. */
export async function makeEditableCurrentPage(page, noteId, opts = {}) {
  await page.click("#make-editable-btn");
  await waitForPromotion(page, noteId, opts);
}

/** Promotes every remaining annotated page. */
export async function makeAllEditable(page, noteId, opts = {}) {
  await page.click("#make-all-editable-btn");
  await waitForPromotion(page, noteId, opts);
}

/** Collects page errors and console errors for the "nothing threw" assertion. */
export function watchErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 160)}`);
  });
  return errors;
}
