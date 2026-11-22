/**
 * Manual probe: capture screenshots of the running app for the final-review
 * presentation deck. Not part of the test suite.
 *
 *   node scripts/dev/ppt-shots.mjs
 *   OMNI_SHOTS=/tmp/shots override the output directory
 *
 * Captures: editor (annotate mode + ink), promoted editable page,
 * Page Manager, and the library with imported notebooks.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import {
  launchBrowser,
  generateFixtures,
  waitForApp,
  openLibrary,
  importPdf,
  openNote,
  drawStroke,
  focusPage,
  waitForPromotion,
} from "../../tests/lib/harness.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE_DIR = join(ROOT, "tests", ".fixtures");
const OUT = process.env.OMNI_SHOTS || "/tmp/ppt-shots";
const PORT = Number(process.env.OMNI_SHOT_PORT || 5211);

await mkdir(OUT, { recursive: true });
console.log(`Fixtures …`);
await generateFixtures(FIXTURE_DIR);

const server = await createServer({
  root: ROOT,
  logLevel: "warn",
  server: { host: "127.0.0.1", port: PORT, strictPort: true },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${PORT}/`;
console.log(`App served at ${baseUrl}`);

const browser = await launchBrowser();
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: 2,
  acceptDownloads: false,
});
const page = await ctx.newPage();
page.on("dialog", (d) => d.accept());
page.on("pageerror", (e) => console.log(`  ! pageerror: ${e.message}`));

await page.goto(baseUrl, { waitUntil: "networkidle" });
await waitForApp(page);

/* 1) Annotate-mode import + a pen stroke on the locked raster */
await openLibrary(page);
const annId = await importPdf(page, join(FIXTURE_DIR, "partial-backdrop.pdf"), {
  mode: "annotations",
});
await openNote(page, annId);
await drawStroke(page, 0);
await page.waitForTimeout(800);
await page.screenshot({ path: join(OUT, "editor-annotate.png") });
console.log("captured editor-annotate.png");

/* 2) Promote the same page to native objects ("Make editable") */
// Dismiss the import-report toasts so the shot is clean.
for (const btn of await page.locator(".import-report-close").all()) {
  await btn.click().catch(() => {});
}
await page.click("#make-editable-btn");
await waitForPromotion(page, annId, { timeout: 120000 });
await page.waitForTimeout(1800);
// Select a real object: read its coordinates from the live engine and click
// its centre, so the shot shows Fabric selection handles (proves editability).
const box = await page.locator("#omni-canvas-0").boundingBox();
const target = await page.evaluate(() => {
  const info = window.__omni.inspectPage(0);
  const objs = (info?.objects ?? []).map((o) => ({
    t: o.omniType || o.type,
    left: Number(o.left) || 0,
    top: Number(o.top) || 0,
    w: Number(o.width) || 0,
    h: Number(o.height) || 0,
  }));
  // Prefer the kept user ink (a plain path stroke); fall back to any object.
  return (
    objs.find((o) => o.t === "path" && o.w > 8 && o.w < 400 && o.h < 200) ||
    objs.find((o) => o.t !== "image" && o.w > 10) ||
    objs[0] ||
    null
  );
});
if (target) {
  // Switch to the select tool first — with the pen still active a click
  // would paint a dot instead of selecting.
  await page.click('[data-tool="select"]');
  await page.waitForTimeout(300);
  await page.mouse.click(
    box.x + target.left + target.w / 2,
    box.y + target.top + target.h / 2,
  );
} else {
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3);
}
await page.waitForTimeout(900);
// Dismiss the "page rebuilt" toast that the promotion raised.
for (const btn of await page.locator(".import-report-close").all()) {
  await btn.click().catch(() => {});
}
await page.waitForTimeout(300);
await page.screenshot({ path: join(OUT, "editor-promoted.png") });
console.log("captured editor-promoted.png");

/* 3) Multi-page notebook + Page Manager overlay */
await openLibrary(page);
const multiId = await importPdf(page, join(FIXTURE_DIR, "multipage.pdf"));
await openNote(page, multiId);
await focusPage(page, 1);
await page.click("#page-manager-btn");
await page.waitForSelector("#page-manager-overlay", { state: "visible" });
await page.waitForTimeout(2500); // page thumbnails
await page.screenshot({ path: join(OUT, "page-manager.png") });
console.log("captured page-manager.png");
await page.keyboard.press("Escape");
await page.waitForTimeout(500);

/* 4) Library with the imported notebooks + thumbnails */
await openLibrary(page);
await page.waitForTimeout(1800);
await page.screenshot({ path: join(OUT, "library.png") });
console.log("captured library.png");

/* 5) Rich editor state: ink + highlighter band + typed text, text selected */
await openLibrary(page);
const richId = await importPdf(page, join(FIXTURE_DIR, "partial-backdrop.pdf"), {
  mode: "annotations",
});
await openNote(page, richId);
const rbox = await page.locator("#omni-canvas-0").boundingBox();
// pen stroke
await page.click('[data-tool="pen"]');
const sx = rbox.x + 0.25 * rbox.width, sy = rbox.y + 0.55 * rbox.height;
await page.mouse.move(sx, sy);
await page.mouse.down();
for (let i = 0; i < 14; i++) {
  await page.mouse.move(sx + i * 12, sy + Math.sin(i / 2) * 18);
}
await page.mouse.up();
// highlighter band across the heading area
await page.click('[data-tool="marker"]');
const hy = rbox.y + 0.30 * rbox.height;
await page.mouse.move(rbox.x + 0.28 * rbox.width, hy);
await page.mouse.down();
await page.mouse.move(rbox.x + 0.65 * rbox.width, hy + 4, { steps: 8 });
await page.mouse.up();
// typed text object
await page.click('[data-tool="text"]');
await page.mouse.click(rbox.x + 0.38 * rbox.width, rbox.y + 0.42 * rbox.height);
await page.keyboard.type("Editable text object");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
// select the text so Fabric handles are visible
await page.click('[data-tool="select"]');
await page.mouse.click(rbox.x + 0.43 * rbox.width, rbox.y + 0.42 * rbox.height);
await page.waitForTimeout(1800);
for (const btn of await page.locator(".import-report-close").all()) {
  await btn.click().catch(() => {});
}
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, "richer-editor.png") });
console.log("captured richer-editor.png");

/* 6) Zoom window — the magnified writing strip */
await page.click("#zw-toggle");
await page.waitForSelector("#zoom-window:not([hidden])", { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(600);
// Alt-click moves the zoom target: park it over the ink stroke so the
// strip mirrors magnified content instead of empty paper.
await page.keyboard.down("Alt");
await page.mouse.click(sx + 60, sy);
await page.keyboard.up("Alt");
await page.waitForTimeout(1300);
await page.screenshot({ path: join(OUT, "zoom-strip.png") });
console.log("captured zoom-strip.png");
await page.click("#zw-toggle").catch(() => {});
await page.waitForTimeout(400);

/* 7) Page Manager with a multi-selection */
await openNote(page, multiId);
await focusPage(page, 0);
await page.click("#page-manager-btn");
await page.waitForSelector("#page-manager-overlay", { state: "visible" });
await page.waitForTimeout(2200);
const tiles = page.locator("#page-manager-grid .pm-tile");
await tiles.nth(0).click();
await tiles.nth(2).click();
await page.waitForTimeout(700);
await page.screenshot({ path: join(OUT, "page-manager-selected.png") });
console.log("captured page-manager-selected.png");

await browser.close();
await server.close();
console.log("DONE");
