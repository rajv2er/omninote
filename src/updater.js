/**
 * In-app software updates (Tauri updater, macOS).
 *
 * The release workflow publishes a signed `latest.json` to GitHub Releases;
 * the updater plugin polls that endpoint, verifies the signature against the
 * pubkey in `tauri.conf.json`, and swaps the .app in place. No App Store,
 * no Developer ID, no account needed.
 *
 * Everything here is a no-op outside the Tauri shell (plain `vite dev` in a
 * browser): the plugin modules are dynamically imported so the web build
 * never pays for them, and every entry point degrades to a toast.
 */
import { showToast, showConfirm } from "./ui/dialogs.js";

/** Baked in at build time by `vite.config.js` (`__APP_VERSION__`). */
export function appVersion() {
  try {
    if (typeof __APP_VERSION__ === "string" && __APP_VERSION__) {
      return __APP_VERSION__;
    }
  } catch {
    /* `__APP_VERSION__` is a build-time define; absent under plain node. */
  }
  return "0.0.0";
}

/** True only inside the installed app — the updater does not exist in a browser. */
export function isTauriApp() {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

// A check already running (auto-check racing a manual click) shares one flight.
let checkInFlight = null;

/** Loads the Tauri plugin bindings on demand; never statically imported. */
async function loadUpdater() {
  const [{ check }, { relaunch }] = await Promise.all([
    import("@tauri-apps/plugin-updater"),
    import("@tauri-apps/plugin-process"),
  ]);
  return { check, relaunch };
}

/**
 * Checks for an update, downloads and installs it with the user's consent,
 * and offers a restart to apply it.
 *
 * @param {{ silent?: boolean }} opts  `silent` reports nothing when there is
 *   no update (used by the automatic launch check); errors and found updates
 *   are always surfaced.
 */
export function checkForUpdates({ silent = false } = {}) {
  if (!isTauriApp()) {
    if (!silent) {
      showToast(
        "Running in a browser",
        "Update checks only run in the installed Mac app — grab new releases from GitHub.",
        "warn",
      );
    }
    return Promise.resolve({ status: "not-tauri" });
  }
  if (checkInFlight) return checkInFlight;

  checkInFlight = runCheck({ silent }).finally(() => {
    checkInFlight = null;
  });
  return checkInFlight;
}

async function runCheck({ silent }) {
  let update = null;
  try {
    const { check } = await loadUpdater();
    update = await check();
  } catch (err) {
    // Offline, no releases yet, or a bad signature — never block the app over it.
    console.warn("Update check failed:", err);
    if (!silent) {
      showToast("Could not check for updates", String(err?.message || err), "error");
    }
    return { status: "error", error: err };
  }

  if (!update) {
    if (!silent) {
      showToast(
        "You're up to date",
        `OmniNote ${appVersion()} is the latest version.`,
        "ok",
      );
    }
    return { status: "up-to-date" };
  }

  const notes =
    typeof update.body === "string" && update.body.trim()
      ? update.body.trim().slice(0, 300)
      : "";
  const wantIt = await showConfirm(
    `OmniNote ${update.version} is available (you have ${appVersion()}).${notes ? ` ${notes}` : ""} Download and install it?`,
    "Download & Install",
    "Later",
  );
  if (!wantIt) return { status: "deferred", version: update.version };

  const progress = showUpdateProgress(update.version);
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        progress.start(event.data.contentLength);
      } else if (event.event === "Progress") {
        progress.advance(event.data.chunkLength);
      }
    });
  } catch (err) {
    progress.done(false, "Download failed — try again later.");
    console.warn("Update download failed:", err);
    return { status: "error", error: err };
  }
  progress.done(true, "Download complete.");

  const restart = await showConfirm(
    `OmniNote ${update.version} is installed and will apply on restart. Restart now?`,
    "Restart",
    "Later",
  );
  if (restart) {
    const { relaunch } = await loadUpdater();
    await relaunch();
  }
  return { status: "installed", version: update.version };
}

/**
 * Persistent determinate progress card for the download. Own DOM node (not
 * `showToast`, which auto-dismisses and would flicker on every chunk).
 */
function showUpdateProgress(version) {
  document.querySelector(".update-progress")?.remove();

  const card = document.createElement("div");
  card.className = "omni-toast update-progress";
  card.setAttribute("role", "status");

  const heading = document.createElement("strong");
  heading.textContent = `Downloading OmniNote ${version}…`;
  card.appendChild(heading);

  const bar = document.createElement("div");
  bar.className = "update-progress-track";
  const fill = document.createElement("div");
  fill.className = "update-progress-fill";
  bar.appendChild(fill);
  card.appendChild(bar);

  const label = document.createElement("span");
  label.textContent = "Starting…";
  card.appendChild(label);

  document.body.appendChild(card);

  let total = 0;
  let received = 0;
  const fmt = (n) =>
    n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

  return {
    start(contentLength) {
      total = Number(contentLength) || 0;
    },
    advance(chunkLength) {
      received += Number(chunkLength) || 0;
      if (total > 0) {
        const pct = Math.min(100, Math.round((received / total) * 100));
        fill.style.width = `${pct}%`;
        label.textContent = `${fmt(received)} of ${fmt(total)} · ${pct}%`;
      } else {
        label.textContent = `${fmt(received)} downloaded…`;
      }
    },
    done(ok, message) {
      heading.textContent = ok ? heading.textContent.replace("…", "") : "Update failed";
      label.textContent = message;
      fill.style.width = ok ? "100%" : fill.style.width;
      setTimeout(() => card.remove(), ok ? 2500 : 6000);
    },
  };
}

// Throttle key for the automatic launch check (at most once per day).
const LAST_CHECK_KEY = "omninote-update-last-check";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Silent launch check: runs at most once a day, says nothing unless an update
 * is actually available (in which case the normal consent flow takes over).
 */
export function autoCheckForUpdates() {
  if (!isTauriApp()) return;
  try {
    const last = Number(localStorage.getItem(LAST_CHECK_KEY)) || 0;
    if (Date.now() - last < CHECK_INTERVAL_MS) return;
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
  } catch {
    /* A preferences write is never worth failing a launch over. */
  }
  checkForUpdates({ silent: true });
}
