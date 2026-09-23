/**
 * Regression suite runner.
 *
 * Boots Vite itself rather than assuming a dev server is already up, so
 * `npm test` works from a cold checkout. Each spec gets a fresh browser
 * context — no shared localStorage, no leaked IndexedDB between cases.
 *
 *   npm test              run everything
 *   npm test -- import    run specs whose file name matches "import"
 *   OMNI_BROWSER=...      pick a Chrome-family binary
 *   OMNI_HEADED=1         watch it happen
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import {
  createChecker,
  generateFixtures,
  launchBrowser,
  openLibrary,
  waitForApp,
  watchErrors,
} from "./lib/harness.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SPEC_DIR = join(ROOT, "tests", "specs");
const FIXTURE_DIR = join(ROOT, "tests", ".fixtures");

const ALL_SPECS = [
  "import.spec.mjs",
  "persistence.spec.mjs",
  "annotate.spec.mjs",
];

const filter = process.argv[2];
const specs = filter
  ? ALL_SPECS.filter((s) => s.includes(filter))
  : ALL_SPECS;

if (specs.length === 0) {
  console.error(`No spec matches "${filter}". Known: ${ALL_SPECS.join(", ")}`);
  process.exit(1);
}

const PORT = Number(process.env.OMNI_TEST_PORT || 5199);

let server;
let browser;
let failed = 0;

try {
  console.log("Generating fixtures…");
  // Fixtures are byte-deterministic and simply overwritten. Deleting the
  // directory first is both unnecessary and hostile to safe-delete guards.
  await mkdir(FIXTURE_DIR, { recursive: true });
  await generateFixtures(FIXTURE_DIR);

  server = await createServer({
    root: ROOT,
    logLevel: "warn",
    // Bind IPv4 explicitly. Vite's default host is `localhost`, which on a
    // dual-stack machine resolves to `::1` only — the server then binds IPv6
    // and the `http://127.0.0.1` URL below is refused. Naming the host makes
    // the address the browser is given the address the server actually holds.
    server: { host: "127.0.0.1", port: PORT, strictPort: true },
  });
  await server.listen();
  const baseUrl = `http://127.0.0.1:${PORT}/`;
  console.log(`App served at ${baseUrl}\n`);

  browser = await launchBrowser();

  for (const specFile of specs) {
    const mod = await import(join(SPEC_DIR, specFile));
    const { check, results } = createChecker(mod.name);
    console.log(`  ${mod.name}`);

    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      acceptDownloads: false,
    });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    page.on("dialog", (d) => d.accept());

    try {
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      await waitForApp(page);
      await openLibrary(page);
      await mod.default({ page, baseUrl, fixtures: FIXTURE_DIR, check });
    } catch (err) {
      check(`spec ran to completion (${specFile})`, false, err.message.split("\n")[0]);
    }

    check("nothing threw while running this spec", errors.length === 0);
    for (const e of errors.slice(0, 5)) console.log(`      ! ${e}`);

    const specFailed = results.filter((r) => !r.ok).length;
    failed += specFailed;
    console.log(
      `    ${results.length - specFailed}/${results.length} passed\n`,
    );

    await ctx.close();
  }
} catch (err) {
  console.error(`\nSuite could not run: ${err.message}`);
  failed += 1;
} finally {
  await browser?.close();
  await server?.close();
}

console.log(failed === 0 ? "SUITE PASSED" : `SUITE FAILED (${failed} check(s))`);
process.exit(failed === 0 ? 0 : 1);
