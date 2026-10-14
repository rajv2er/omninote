/**
 * Dark-PDF thumbnail regression (real-world PDF via OMNI_DARK_PDF).
 *
 * Covers the "blank white pages" failure: off-window static previews must
 * show the page's actual appearance — never a blank white sheet.
 *
 * Stage A (cold annotate notebook): pages beyond the live window have no
 * background asset yet, so their preview can only come from the source PDF.
 * Stage B (after "Make all editable"): batch-promoted pages wait on an
 * import handoff with fallbackVisible=false; their preview must still show
 * the fallback raster until the handoff materialises on open.
 *
 * Run: OMNI_DARK_PDF=/path/to.pdf npm test -- darkThumbs
 */
import { importPdf, openNote, noteSummary, drawStroke } from "../lib/harness.mjs";

export const name = "Dark-PDF thumbnails";

const DARK_PDF = process.env.OMNI_DARK_PDF || null;
/** Black slides render far below this; blank paper sits far above it. */
const DARK_ENOUGH = 150;

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

/** Parks on `index` and waits until the engine window matches exactly. */
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
    { timeout: 15000 },
  );
}

const thumbInfo = (page, index) =>
  page.evaluate((i) => {
    const canvas = document.querySelector(`#omni-canvas-${i}`);
    const thumb = document.querySelector(`#omni-thumb-${i}`);
    if (!canvas || !thumb) return null;
    // Computed display, not the `hidden` property: a CSS display rule beats
    // the UA `[hidden]{display:none}`, and the property alone once hid a
    // full-page phantom-white-sheet bug from this very assertion.
    const thumbShown = getComputedStyle(thumb).display !== "none";
    const live = getComputedStyle(canvas).display !== "none";
    let brightness = null;
    if (thumbShown && thumb.naturalWidth > 0) {
      try {
        const c = document.createElement("canvas");
        c.width = 32;
        c.height = 32;
        const x = c.getContext("2d");
        x.drawImage(thumb, 0, 0, 32, 32);
        const d = x.getImageData(0, 0, 32, 32).data;
        let s = 0;
        for (let k = 0; k < d.length; k += 4) s += (d[k] + d[k + 1] + d[k + 2]) / 3;
        brightness = Math.round(s / (d.length / 4));
      } catch {
        brightness = -1;
      }
    }
    return {
      live,
      thumbShown,
      thumbW: thumb.naturalWidth,
      hasSrc: Boolean(thumb.getAttribute("src")),
      brightness,
    };
  }, index);

const pageFlags = (page, noteId) =>
  page.evaluate((id) => {
    const n = window.__omni.getNotes().find((x) => x.id === id);
    if (!n) return null;
    return n.pages.map((p) => ({
      bg: Boolean(p.backgroundAssetId),
      json: Boolean(p.canvasJson),
      pending: Boolean(p.pendingImportData || p.pendingDecomposedData),
      fallback: p.fallbackVisible,
      mode: p.editMode,
    }));
  }, noteId);

export default async function run({ page, check }) {
  if (!DARK_PDF) {
    check("OMNI_DARK_PDF is set (diagnosis skipped)", true, "no PDF provided");
    return;
  }

  const noteId = await importPdf(page, DARK_PDF, { mode: "annotations" });
  const afterImport = await noteSummary(page, noteId);
  check("imported 10 pages", afterImport.pages === 10, `${afterImport.pages}`);
  const n = afterImport.pages;

  await openNote(page, noteId);

  /* ---- Stage A: cold notebook, distant pages have no raster yet ---- */
  await settle(page, 0, n);
  // Previews render asynchronously; give every off-window page a chance.
  await page
    .waitForFunction(
      (count) => {
        for (let k = 2; k < count; k++) {
          const t = document.querySelector(`#omni-thumb-${k}`);
          if (
            !t ||
            getComputedStyle(t).display === "none" ||
            t.naturalWidth === 0
          ) {
            return false;
          }
        }
        return true;
      },
      n,
      { timeout: 20000 },
    )
    .catch(() => {});

  const coldRows = [];
  const coldWhite = [];
  for (let i = 0; i < n; i++) {
    const t = await thumbInfo(page, i);
    coldRows.push(`${i}:${t.live ? "live" : `thumb/b=${t.brightness}`}`);
    if (!t.live && t.brightness != null && t.brightness > DARK_ENOUGH) {
      coldWhite.push(`${i}(b=${t.brightness}${t.hasSrc ? "" : ",no-src"})`);
    }
  }
  console.log(`      cold thumbs → ${coldRows.join(" ")}`);
  check(
    "cold off-window previews show the dark pages, not blank sheets",
    coldWhite.length === 0,
    coldWhite.length ? `white: ${coldWhite.join(" ")}` : "all dark",
  );

  /* ---- Stage B: batch promotion leaves handoffs on unopened pages ---- */
  await settle(page, 0, n);
  await page.click("[data-promote-all]");
  await page
    .waitForFunction(
      (id) => {
        const nn = window.__omni.getNotes().find((x) => x.id === id);
        return nn && nn.pages.every((p) => p.conversionState !== "converting");
      },
      noteId,
      { timeout: 180000 },
    )
    .catch(() => {});
  // Reopen so the window rebuilds around page 0 with the new page records.
  await openNote(page, noteId);
  await settle(page, 0, n);
  await page.waitForTimeout(2500);

  const flagsB = await pageFlags(page, noteId);
  console.log(`      promoted flags → ${JSON.stringify(flagsB)}`);

  const warmRows = [];
  const warmWhite = [];
  for (let i = 0; i < n; i++) {
    const t = await thumbInfo(page, i);
    warmRows.push(`${i}:${t.live ? "live" : `thumb/b=${t.brightness}`}`);
    if (!t.live && t.brightness != null && t.brightness > DARK_ENOUGH) {
      warmWhite.push(`${i}(b=${t.brightness}${t.hasSrc ? "" : ",no-src"})`);
    }
  }
  console.log(`      promoted thumbs → ${warmRows.join(" ")}`);
  check(
    "pending-handoff pages still preview their content, not blank sheets",
    warmWhite.length === 0,
    warmWhite.length ? `white: ${warmWhite.join(" ")}` : "all dark",
  );

  /* ---- Stage C: aged record — handoff still pending, empty graph saved ----
   *
   * Older builds persisted an empty canvasJson for pages whose handoff had
   * not been consumed yet (a teardown save with no materialised objects).
   * That record shape must still preview from its fallback raster, not as a
   * blank sheet. The library round-trip drops the in-memory thumbnail cache,
   * so the preview below renders fresh from the planted record.
   */
  await page.evaluate((id) => {
    const nn = window.__omni.getNotes().find((x) => x.id === id);
    const donor = nn.pages.find((p) => p.backgroundAssetId);
    const target = nn.pages[5];
    target.pendingImportData = { objects: [], report: null };
    target.pendingDecomposedData = null;
    target.fallbackVisible = false;
    target.editMode = "notes";
    target.backgroundAssetId = donor ? donor.backgroundAssetId : null;
    target.canvasJson = {
      width: target.width,
      height: target.height,
      paperStyle: target.paperStyle || "plain",
      canvasData: { version: "7.0.0", objects: [] },
    };
  }, noteId);

  await openNote(page, noteId);
  await settle(page, 0, n);
  await page.waitForTimeout(2500);

  const aged = await thumbInfo(page, 5);
  console.log(`      aged-record thumb → ${JSON.stringify(aged)}`);
  check(
    "an aged pending+empty record previews its raster, not a blank sheet",
    Boolean(aged) &&
      !aged.live &&
      aged.thumbShown &&
      aged.brightness != null &&
      aged.brightness <= DARK_ENOUGH,
    JSON.stringify(aged),
  );

  /* ---- Stage D: imported page furniture stays locked after a reload ----
   *
   * Full-page fills are recovered as locked objects (selectable=false).
   * Fabric does not serialise selectability, so every loadFromJSON must
   * re-apply the lock from the surviving `omniLocked` marker — otherwise
   * the page background becomes clickable and deletable after any remount.
   */
  const lockRows = await page.evaluate(() => {
    const engines = window.__omni.getEngines();
    return engines.map((e) => {
      if (!e) return null;
      const objs = e.canvas.getObjects();
      return {
        total: objs.length,
        locked: objs.filter((o) => o.omniLocked).length,
        unlockedFurniture: objs.filter(
          (o) => o.omniLocked && (o.selectable !== false || o.evented !== false),
        ).length,
      };
    });
  });
  console.log(`      furniture locks → ${JSON.stringify(lockRows)}`);
  const liveRows = lockRows.filter(Boolean);
  const lockedTotal = liveRows.reduce((a, r) => a + r.locked, 0);
  const unlockedTotal = liveRows.reduce((a, r) => a + r.unlockedFurniture, 0);
  check(
    "recovered page furniture exists in this notebook",
    lockedTotal > 0,
    `${lockedTotal} locked object(s) across live engines`,
  );
  check(
    "locked furniture is not selectable after reload + remounts",
    unlockedTotal === 0,
    `${unlockedTotal} unlocked furniture object(s)`,
  );

  /* ---- Stage E: aged-user flow — ink, promote, reload, full traversal ----
   *
   * Draws on annotate pages, batch-promotes, reloads, then visits every
   * page. Each visited page must finish with a live engine holding real
   * objects. A mount that throws used to abort the whole window update and
   * leave every later page engine-less (persistently white, including the
   * current page); mounts are now isolated per page.
   *
   * Uses a fresh import: the first notebook is already fully promoted.
   */
  const noteId2 = await importPdf(page, DARK_PDF, { mode: "annotations" });
  await openNote(page, noteId2);
  await settle(page, 0, n);
  await drawStroke(page, 0);
  await settle(page, 1, n);
  await drawStroke(page, 1);
  await settle(page, 0, n);
  await page.click("[data-promote-all]");
  await page
    .waitForFunction(
      (id) => {
        const nn = window.__omni.getNotes().find((x) => x.id === id);
        return nn && nn.pages.every((p) => p.conversionState !== "converting");
      },
      noteId2,
      { timeout: 180000 },
    )
    .catch(() => {});

  // Payload writes are async: reloading while the handoffs are still in
  // flight would test the unload race, not promotion. Drain first.
  const drainSamples = [];
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(5000);
    const left = await page.evaluate(() => window.__omni.pendingWrites());
    drainSamples.push(left);
    if (left === 0) break;
  }
  console.log(`      payload drain over time: [${drainSamples.join(" → ")}]`);
  const drained = drainSamples[drainSamples.length - 1];
  const pendingSizes = await page.evaluate((id) => {
    const nn = window.__omni.getNotes().find((x) => x.id === id);
    return nn.pages.map((p) =>
      p.pendingImportData ? JSON.stringify(p.pendingImportData).length : 0,
    );
  }, noteId2);
  console.log(`      pending handoff sizes: [${pendingSizes.join(", ")}]`);

  await page.reload();
  await page.waitForFunction(() => Boolean(window.__omni)), null, {
    timeout: 30000,
  };
  await openNote(page, noteId2);

  const flagsR = await page.evaluate((id) => {
    const nn = window.__omni.getNotes().find((x) => x.id === id);
    return nn.pages.map((p) => ({
      bg: Boolean(p.backgroundAssetId),
      json: Boolean(p.canvasJson),
      pending: Boolean(p.pendingImportData || p.pendingDecomposedData),
      fallback: p.fallbackVisible,
      mode: p.editMode,
    }));
  }, noteId2);
  console.log(`      post-reload flags → ${JSON.stringify(flagsR)}`);

  const dead = [];
  for (let i = 0; i < n; i++) {
    await settle(page, i, n);
    const hasEngine = await page.evaluate(
      (k) => Boolean(window.__omni.getEngines()[k]),
      i,
    );
    if (!hasEngine) {
      dead.push(`${i}(no-engine)`);
      continue;
    }
    // The lazy background raster lands ~180ms after the mount; give it a
    // moment before judging a raster-only page empty.
    const s = await page
      .waitForFunction(
        (k) => {
          const e = window.__omni.getEngines()[k];
          if (!e) return false;
          const objects = e.canvas.getObjects().length;
          const hasBg = Boolean(e.canvas.backgroundImage);
          return objects > 0 || hasBg ? { objects, hasBg } : false;
        },
        i,
        { timeout: 8000 },
      )
      .then((h) => h.jsonValue())
      .catch(() => null);
    if (!s || (s.objects === 0 && !s.hasBg)) {
      dead.push(`${i}(empty)`);
    }
  }
  console.log(`      post-reload traversal → dead: [${dead.join(" ")}]`);
  check(
    "every page mounts a live engine with content after reload",
    dead.length === 0,
    dead.length ? `dead: ${dead.join(" ")}` : `${n}/${n} live`,
  );

  /* ---- Stage F: furniture deletion ⇒ truthful white previews ----
   *
   * Simulates what the old build allowed (selectable backgrounds): remove
   * every locked furniture object from every page, then re-render previews.
   * A white preview of an emptied page is correct rendering, not a
   * renderer bug — this stage documents the before/after per page.
   */
  const noteId3 = await importPdf(page, DARK_PDF, { mode: "editable" });
  await openNote(page, noteId3);
  for (let i = 0; i < n; i++) {
    await settle(page, i, n);
    await page.evaluate((k) => {
      const e = window.__omni.getEngines()[k];
      if (!e) return 0;
      const furn = e.canvas.getObjects().filter((o) => o.omniLocked);
      for (const o of furn) e.canvas.remove(o);
      e.canvas.requestRenderAll();
      return furn.length;
    }, i);
  }
  const counts = await page.evaluate((id) => {
    const nn = window.__omni.getNotes().find((x) => x.id === id);
    return nn.pages.map((p) => {
      const data = p.canvasJson?.canvasData || p.canvasJson;
      return data?.objects?.length ?? -1;
    });
  }, noteId3);
  console.log(`      objects remaining per page → [${counts.join(", ")}]`);

  await openNote(page, noteId3);
  await settle(page, 0, n);
  await page.waitForTimeout(2500);
  const paleRows = [];
  for (let i = 0; i < n; i++) {
    const t = await thumbInfo(page, i);
    paleRows.push(`${i}:${t.live ? "live" : `b=${t.brightness}`}`);
  }
  console.log(`      post-deletion thumbs → ${paleRows.join(" ")}`);
  check("post-deletion sweep completed", true, `${paleRows.length} pages`);
}
