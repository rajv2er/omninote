/**
 * Reproduction probe: annotate import -> "Make all editable" on a 10-page PDF.
 * Prints the page record at each stage to find where extra/blank pages appear.
 * Throwaway script — delete after use.
 */
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { PDFDocument, rgb } from "pdf-lib";
import { writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5211;

const BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];
const browserPath = BROWSERS.find((p) => existsSync(p));
if (!browserPath) {
  console.error("No Chrome-family browser found");
  process.exit(1);
}

// --- build a deterministic 10-page PDF ---
const doc = await PDFDocument.create();
for (let i = 0; i < 10; i++) {
  const p = doc.addPage([612, 792]);
  p.drawText("Page " + (i + 1), { x: 50, y: 700, size: 24, color: rgb(0, 0, 0) });
  p.drawRectangle({
    x: 50,
    y: 480,
    width: 220,
    height: 120,
    borderColor: rgb(0, 0, 0),
    borderWidth: 2,
  });
  p.drawLine({
    start: { x: 50, y: 400 },
    end: { x: 400, y: 380 },
    thickness: 2,
    color: rgb(0, 0, 0),
  });
}
const pdfPath =
  "/private/var/folders/3s/_zh_kk_n5xq0hz6jbzdt7ht00000gn/T/opencode/tenpage.pdf";
writeFileSync(pdfPath, await doc.save());

const server = await createServer({
  root: ROOT,
  logLevel: "warn",
  server: { host: "127.0.0.1", port: PORT, strictPort: true },
});
await server.listen();
const url = `http://127.0.0.1:${PORT}/`;

const browser = await chromium.launch({
  executablePath: browserPath,
  headless: true,
  args: ["--no-sandbox"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForFunction(() => Boolean(window.__omni));

if (await page.locator("#back-btn").count()) await page.click("#back-btn");
await page.waitForSelector("#pdf-input", { state: "attached" });

const before = await page.evaluate(() => window.__omni.getNotes().map((n) => n.id));
await page.selectOption("#import-mode", "annotations");
await page.setInputFiles("#pdf-input", pdfPath);
await page.waitForFunction(
  (n) => window.__omni.getNotes().length > n,
  before.length,
  { timeout: 180000 },
);
await page.waitForFunction(() => !document.querySelector(".loading-overlay"), undefined, {
  timeout: 180000,
});

const noteId = (
  await page.evaluate(() => window.__omni.getNotes().map((n) => n.id))
).find((id) => !before.includes(id));

const openNotebook = async () => {
  // The app may already have auto-opened the imported notebook.
  const alreadyOpen = await page.evaluate(
    (id) => window.__omni.getActiveId() === id,
    noteId,
  );
  if (alreadyOpen) {
    await page.waitForSelector("#omni-canvas-0");
    await page.waitForFunction(() => Boolean(window.__omni.inspectPage(0)));
    return;
  }
  if (await page.locator("#back-btn").count()) await page.click("#back-btn");
  await page.waitForSelector("#pdf-input", { state: "attached" });
  await page.click(`[data-open="${noteId}"]`);
  await page.waitForSelector("#omni-canvas-0");
  await page.waitForFunction(() => Boolean(window.__omni.inspectPage(0)));
};

const snap = async (label) => {
  const s = await page.evaluate(
    ({ id, label }) => {
      const n = window.__omni.getNotes().find((x) => x.id === id);
      return {
        label,
        pagesInRecord: n.pages.length,
        domWrappers: document.querySelectorAll(".page-container").length,
        pages: n.pages.map((p, i) => ({
          i,
          editMode: p.editMode,
          conv: p.conversionState,
          canvasJson: p.canvasJson ? 1 : 0,
          pending: p.pendingImportData ? 1 : 0,
          bg: p.backgroundAssetId ? 1 : 0,
          pdfPageIndex: p.pdfPageIndex ?? "-",
          id8: p.id.slice(0, 8),
        })),
      };
    },
    { id: noteId, label },
  );
  console.log("SNAP", JSON.stringify(s));
};

await snap("after-import");

await openNotebook();
await snap("after-open");

await page.waitForSelector("#make-all-editable-btn");
await page.click("#make-all-editable-btn");
await page.waitForFunction(
  (id) => {
    const n = window.__omni.getNotes().find((x) => x.id === id);
    return n && n.pages.every((p) => p.conversionState !== "converting");
  },
  noteId,
  { timeout: 300000 },
);
await page.waitForTimeout(1500);
await snap("after-promotion");

await page.click("#back-btn");
await page.waitForSelector("#pdf-input", { state: "attached" });
await page.click(`[data-open="${noteId}"]`);
await page.waitForSelector("#omni-canvas-0");
await page.waitForFunction(() => Boolean(window.__omni.inspectPage(0)));
await page.waitForTimeout(2000);
await snap("after-reopen");

// Dump the full page record for deep comparison
const deep = await page.evaluate((id) => {
  const n = window.__omni.getNotes().find((x) => x.id === id);
  return n.pages.map((p) => ({
    id: p.id,
    pageNumber: p.pageNumber,
    editMode: p.editMode,
    pdfPageIndex: p.pdfPageIndex ?? null,
    pending: p.pendingImportData ? Object.keys(p.pendingImportData) : null,
    canvasJsonObjects: Array.isArray(p.canvasJson?.objects)
      ? p.canvasJson.objects.length
      : null,
  }));
}, noteId);
console.log("DEEP", JSON.stringify(deep, null, 2));

const stored = await page.evaluate((id) => {
  const arr = JSON.parse(localStorage.getItem("omninote-notes-v2") || "[]");
  const n = arr.find((x) => x.id === id);
  return n ? { storedPages: n.pages.length } : null;
}, noteId);
console.log("STORED", JSON.stringify(stored));

await browser.close();
await server.close();
process.exit(0);