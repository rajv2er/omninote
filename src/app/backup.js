import {
  collectNoteAssetIdsDeep,
  deleteAssets,
  getAsset,
  putAssetFromDataUrl,
} from "../storage/assets.js";
import { showConfirm, showToast } from "../ui/dialogs.js";
import { isTauriApp } from "../updater.js";

/**
 * Creates the whole-library backup and restore flow.
 *
 * A backup is self-contained: every notebook, folder, colour and IndexedDB
 * blob is inlined into one JSON file. Restore replaces the library atomically
 * and only then deletes the assets the old library owned.
 *
 * @param {object} options
 * @param {() => object[]} options.getNotes
 * @param {(notes: object[]) => void} options.setNotes
 * @param {() => object[]} options.getFolders
 * @param {(folders: object[]) => void} options.setFolders
 * @param {() => string[]} options.getCustomColors
 * @param {(colors: string[]) => void} options.setCustomColors
 * @param {(id: string|null) => void} options.setActiveId
 * @param {(page: object) => void} options.markPageHydrated
 * @param {() => void} options.saveFolders
 * @param {() => void} options.saveCustomColors
 * @param {(note: object) => object} options.normalizeNote
 * @param {(note: object, indexes?: number[]) => Promise<void>} options.hydrateNote
 * @param {() => void} options.saveNotes
 * @param {() => void} options.render
 * @param {(message: string) => void} options.setLoading
 * @param {() => void} options.clearLoading
 * @param {() => void} options.refreshLoading
 * @param {(value: string) => string} options.sanitizeColor
 * @param {string} options.defaultColor
 * @param {Set<string>} options.safePaperStyles
 */
export function createBackup({
  getNotes,
  setNotes,
  getFolders,
  setFolders,
  getCustomColors,
  setCustomColors,
  setActiveId,
  markPageHydrated,
  saveFolders,
  saveCustomColors,
  normalizeNote,
  hydrateNote,
  saveNotes,
  render,
  setLoading,
  clearLoading,
  refreshLoading,
  sanitizeColor,
  defaultColor,
  safePaperStyles,
}) {
  async function backupAllNotes() {
    setLoading("Preparing backup…");

    try {
      await Promise.all(getNotes().map((n) => hydrateNote(n, n.pages.map((_, i) => i))));

      const assetIds = new Set();
      for (const note of getNotes()) {
        for (const id of await collectNoteAssetIdsDeep(note)) {
          if (id) assetIds.add(id);
        }
      }

      const assets = {};
      for (const id of assetIds) {
        try {
          const blob = await getAsset(id);
          if (!blob) continue;
          assets[id] = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
        } catch {
          // A missing asset is recorded as absent; restore will simply skip it.
        }
      }

      const backup = {
        version: 1,
        exportedAt: Date.now(),
        notes: JSON.parse(JSON.stringify(getNotes())),
        folders: JSON.parse(JSON.stringify(getFolders())),
        customColors: JSON.parse(JSON.stringify(getCustomColors())),
        assets,
      };

      const json = JSON.stringify(backup);
      const cleanDate = new Date().toISOString().slice(0, 10);
      const saved = await saveBytes(new TextEncoder().encode(json), `omninote-backup-${cleanDate}.omninote`, [
        { name: "OmniNote Backup", extensions: ["omninote", "json"] },
      ]);

      if (saved) {
        showToast("Backup ready", `${getNotes().length} notebook${getNotes().length === 1 ? "" : "s"} exported.`, "ok");
      }
    } catch (err) {
      showToast("Backup failed", String(err?.message || err), "error");
      console.error(err);
    } finally {
      clearLoading();
      refreshLoading();
    }
  }

  /**
   * Replaces the current library with the notebooks stored in a backup file.
   */
  async function restoreFromBackup(file) {
    if (!file) return;
    const ok = await showConfirm(
      "Restore from backup? This replaces all notebooks currently in the library.",
      "Restore",
      "Cancel",
    );
    if (!ok) return;

    setLoading("Restoring backup…");

    try {
      const text = await file.text();
      const backup = JSON.parse(text);
      if (!Array.isArray(backup?.notes)) {
        throw new Error("This file is not an OmniNote backup.");
      }
      if (backup.notes.length > 10000) {
        throw new Error("Backup contains too many notebooks.");
      }

      // Remember what the current library owns so it can be cleaned up once the
      // restore succeeds, instead of orphaning every old blob in IndexedDB.
      const oldAssetIds = new Set();
      for (const n of getNotes()) {
        for (const id of await collectNoteAssetIdsDeep(n)) {
          if (id) oldAssetIds.add(id);
        }
      }

      for (const [id, dataUrl] of Object.entries(backup.assets || {})) {
        if (typeof id !== "string" || !id || typeof dataUrl !== "string") continue;
        try {
          await putAssetFromDataUrl(id, dataUrl);
        } catch {
          // Keep going; a single bad asset must not abort the whole restore.
        }
      }

      const newAssetIds = new Set(Object.keys(backup.assets || {}));
      setNotes((backup.notes || [])
        .filter((n) => {
          if (!n || typeof n !== "object" || Array.isArray(n)) return false;
          if (typeof n.id !== "string" || !n.id) return false;
          if (!Array.isArray(n.pages) || n.pages.length > 100000) return false;
          return true;
        })
        .map((n) => {
          // Sanitize page styles and dimensions before normalization.
          for (const p of n.pages || []) {
            if (!safePaperStyles.has(p?.paperStyle)) p.paperStyle = "plain";
            if (typeof p?.width === "number") p.width = Math.max(1, Math.min(10000, p.width));
            if (typeof p?.height === "number") p.height = Math.max(1, Math.min(10000, p.height));
          }
          return normalizeNote(n);
        }));
      if (Array.isArray(backup.folders)) {
        setFolders(backup.folders.filter(
          (f) => f && typeof f.id === "string" && typeof f.name === "string",
        ));
        saveFolders();
      }
      if (Array.isArray(backup.customColors)) {
        setCustomColors(backup.customColors.map(sanitizeColor));
        if (getCustomColors().length === 0) setCustomColors([defaultColor]);
        saveCustomColors();
      }
      for (const note of getNotes()) {
        for (const page of note.pages || []) markPageHydrated(page);
      }
      setActiveId(getNotes()[0]?.id || null);
      saveNotes();

      // Remove assets that belonged to the replaced library and are not part of
      // the restored one.
      const orphaned = [...oldAssetIds].filter((id) => !newAssetIds.has(id));
      await deleteAssets(orphaned);

      showToast("Restore complete", `${getNotes().length} notebook${getNotes().length === 1 ? "" : "s"} restored.`, "ok");
    } catch (err) {
      showToast("Restore failed", String(err?.message || err), "error");
      console.error(err);
    } finally {
      clearLoading();
      render();
    }
  }

  /**
   * Saves a byte buffer to a user-chosen location.
   *
   * Uses the native save dialog when running inside Tauri and falls back to a
   * browser download otherwise, so the same code path serves both builds.
   */
  async function saveBytes(bytes, filename, filters = null) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

    if (isTauriApp()) {
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const { writeFile } = await import("@tauri-apps/plugin-fs");
        const options = { defaultPath: filename };
        if (Array.isArray(filters) && filters.length) options.filters = filters;
        const path = await save(options);
        if (!path) return false;
        await writeFile(path, data);
        return true;
      } catch (err) {
        console.warn("Native save failed, falling back to download:", err);
      }
    }

    const blob = new Blob([data], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  }

  return { backupAllNotes, restoreFromBackup, saveBytes };
}
