/**
 * Probe a PDF's page tree the way OmniNote's importer sees it.
 * Prints numPages plus per-page size and a content-richness signal,
 * so interleaved blank pages become visible.
 *
 * Usage: node scripts/.probe-pdf.mjs /path/to/file.pdf
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/.probe-pdf.mjs <file.pdf>");
  process.exit(1);
}

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const data = new Uint8Array(readFileSync(file));
const pdf = await pdfjs.getDocument({ data }).promise;

console.log(`file: ${file}`);
console.log(`pdf.js numPages: ${pdf.numPages}`);

for (let num = 1; num <= pdf.numPages; num++) {
  const page = await pdf.getPage(num);
  const vp = page.getViewport({ scale: 1 });
  let textChars = 0;
  let textItems = 0;
  try {
    const tc = await page.getTextContent();
    textItems = tc.items.length;
    textChars = tc.items.reduce((a, it) => a + (it.str?.length || 0), 0);
  } catch {}
  let ops = 0;
  try {
    ops = (await page.getOperatorList()).fnArray.length;
  } catch {}
  const w = Math.round(vp.width);
  const h = Math.round(vp.height);
  const sparse = ops < 12 && textChars === 0;
  console.log(
    `page ${String(num).padStart(2)}: ${w}x${h} ops=${ops} textItems=${textItems} textChars=${textChars}${sparse ? "  <-- looks BLANK/empty" : ""}`,
  );
}