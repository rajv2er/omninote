/**
 * Toast notifications, warnings, and import summary dialogs.
 */

export const IMPORT_WARNING_TEXT = {
  "unsupported-graphics-operators": "Some graphics could not be converted.",
  "unsupported-annotations": "Some annotations stayed in the page image.",
  "images-left-in-fallback": "Some images could not be extracted.",
  "page-sized-images-kept-in-fallback": "Full-page images stayed in the page image.",
  "low-confidence-regions-kept-in-fallback": "Uncertain regions were kept as an image.",
  "text-colour-approximated": "Text colours were approximated.",
  "text-extraction-failed": "Text could not be read on this page.",
  "operator-stream-failed": "Part of the page could not be read.",
  "fallback-render-failed": "The page image could not be rendered.",
  "operator-list-unavailable": "The page content stream was unreadable.",
  "annotation-scan-failed": "Annotations could not be inspected.",
};

/**
 * Folds every page's import report into one notebook-level summary.
 *
 * Counts describe objects that were actually created, never operators that
 * were merely inspected — the whole point is that the report can be trusted.
 */
export function summarizeImport(pages) {
  const report = {
    pages: pages.length,
    textObjects: 0,
    vectorGroups: 0,
    imageObjects: 0,
    completePages: 0,
    partialPages: 0,
    fallbackPages: 0,
    fallbackRegions: 0,
    warnings: [],
    errors: [],
  };

  for (const page of pages) {
    const r = page.report;
    if (!r) continue;

    report.textObjects += r.textObjects || 0;
    report.vectorGroups += r.vectorGroups || 0;
    report.imageObjects += r.imageObjects || 0;
    report.fallbackRegions += r.fallbackRegions || 0;

    if (r.status === "complete") report.completePages++;
    else if (r.status === "fallback") report.fallbackPages++;
    else report.partialPages++;

    for (const w of r.warnings || []) {
      if (!report.warnings.includes(w)) report.warnings.push(w);
    }
    for (const e of r.errors || []) {
      if (!report.errors.includes(e)) report.errors.push(e);
    }
  }

  if (report.fallbackPages === report.pages) {
    report.status = "fallback";
  } else if (report.partialPages > 0 || report.fallbackPages > 0) {
    report.status = "partial";
  } else {
    report.status = "complete";
  }

  return report;
}

/**
 * Non-blocking completion card.
 *
 * Deliberately a corner toast rather than a modal: the notebook is usable the
 * moment the import finishes, and nothing here waits for the user.
 */
export function showImportReport(report) {
  // Only clears a previous *completion* toast; a storage warning is a
  // different, more important message and must survive this.
  document.querySelector(".import-report")?.remove();

  const lines = [];
  lines.push(`${report.pages} ${report.pages === 1 ? "page" : "pages"} imported`);

  const recovered = [];
  if (report.textObjects) recovered.push(`${report.textObjects} editable text`);
  if (report.imageObjects) recovered.push(`${report.imageObjects} image${report.imageObjects === 1 ? "" : "s"}`);
  if (report.vectorGroups) recovered.push(`${report.vectorGroups} ink group${report.vectorGroups === 1 ? "" : "s"}`);
  lines.push(recovered.length ? recovered.join(" · ") : "No editable content recovered");

  if (report.fallbackPages > 0) {
    lines.push(
      `${report.fallbackPages} ${report.fallbackPages === 1 ? "page kept" : "pages kept"} as an image`,
    );
  } else if (report.partialPages > 0) {
    lines.push(
      `${report.partialPages} partial ${report.partialPages === 1 ? "page" : "pages"} keep their original image underneath`,
    );
  }

  const card = document.createElement("div");
  card.className = `import-report import-report--${report.status}`;
  card.setAttribute("role", "status");

  const title = document.createElement("strong");
  title.textContent =
    report.status === "complete"
      ? "Import complete"
      : report.status === "fallback"
        ? "Imported as page images"
        : "Import finished with gaps";
  card.appendChild(title);

  for (const line of lines) {
    const p = document.createElement("span");
    p.textContent = line;
    card.appendChild(p);
  }

  const notes = (report.warnings || [])
    .map((w) => IMPORT_WARNING_TEXT[w] || w)
    .filter(Boolean);
  if (notes.length) {
    const list = document.createElement("em");
    list.textContent = notes.slice(0, 3).join(" ");
    card.appendChild(list);
  }

  const close = document.createElement("button");
  close.type = "button";
  close.className = "import-report-close";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => card.remove());
  card.appendChild(close);

  document.body.appendChild(card);

  setTimeout(() => card.remove(), 9000);
}

/**
 * Storage warning toast when localStorage quota is exceeded.
 */
export function showStorageWarning(error) {
  // Dedupe on presence rather than a flag: the import report toast removes
  // itself from the DOM, and a flag would then suppress the warning forever.
  if (document.querySelector(".storage-warning")) return;

  const card = document.createElement("div");
  // Its own class, deliberately NOT `.import-report` — the completion toast
  // clears anything with that class and would wipe this warning out.
  card.className = "storage-warning";
  card.setAttribute("role", "alert");

  const title = document.createElement("strong");
  title.textContent = "This notebook is too large to save";
  card.appendChild(title);

  const detail = document.createElement("span");
  detail.textContent =
    "It is open and editable, but changes will be lost when you reload. " +
    "Export it to PDF to keep a copy, or split it into smaller notebooks.";
  card.appendChild(detail);

  const reason = document.createElement("em");
  reason.textContent = String(error?.name || error?.message || "Storage is full");
  card.appendChild(reason);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "import-report-close";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => card.remove());
  card.appendChild(close);

  document.body.appendChild(card);
  // Deliberately not auto-dismissed: this one matters.
}

/** Clears the warning once a save finally succeeds. */
export function clearStorageWarning() {
  document.querySelector(".storage-warning")?.remove();
}

/**
 * Small non-blocking corner toast for an action that reports its own outcome.
 *
 * Deliberately its own class rather than reusing `.import-report`: that toast is
 * cleared whenever a new import finishes, and the storage warning must survive
 * one. This only replaces a previous toast of its own kind.
 *
 * @param {string} title  Headline, e.g. "Page rebuilt"
 * @param {string} detail  Optional second line
 * @param {"ok"|"warn"|"error"} tone  Drives the accent colour
 */
export function showToast(title, detail = "", tone = "ok") {
  document.querySelector(".omni-toast")?.remove();

  const card = document.createElement("div");
  card.className = `omni-toast omni-toast--${tone}`;
  card.setAttribute("role", "status");

  const heading = document.createElement("strong");
  heading.textContent = title;
  card.appendChild(heading);

  if (detail) {
    const line = document.createElement("span");
    line.textContent = detail;
    card.appendChild(line);
  }

  const close = document.createElement("button");
  close.type = "button";
  close.className = "import-report-close";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => card.remove());
  card.appendChild(close);

  document.body.appendChild(card);
  setTimeout(() => card.remove(), 6000);
}
