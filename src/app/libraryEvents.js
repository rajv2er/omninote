import { invalidatePdfDoc } from "../pdf/raster.js";
import {
  collectNoteAssetIdsDeep,
  deleteAssets,
  getAssetUrl,
} from "../storage/assets.js";
import { showConfirm, showPrompt, showShortcutsHelp } from "../ui/dialogs.js";
import { checkForUpdates, isTauriApp } from "../updater.js";

/**
 * Creates the library screen's event wiring: cards, sidebar folders, pin/
 * restore/trash actions, search, bulk selection, backup/restore and PDF import.
 *
 * Library view state stays in the app shell (the template reads it); this
 * module mutates it through the injected getters/setters.
 *
 * @param {object} options
 * @param {() => object[]} options.getNotes
 * @param {(notes: object[]) => void} options.setNotes
 * @param {() => string|null} options.getActiveId
 * @param {(id: string|null) => void} options.setActiveId
 * @param {() => object[]} options.getFolders
 * @param {(folders: object[]) => void} options.setFolders
 * @param {() => string} options.getActiveFolder
 * @param {(folder: string) => void} options.setActiveFolder
 * @param {() => boolean} options.isSelectionMode
 * @param {(on: boolean) => void} options.setSelectionMode
 * @param {() => Set<string>} options.getSelectedNoteIds
 * @param {() => void} options.saveNotes
 * @param {() => void} options.saveFolders
 * @param {() => void} options.render
 * @param {(id: string) => object|null} options.folderById
 * @param {() => object[]} options.notesInCurrentView
 * @param {(note: object, indexes?: number[]) => Promise<void>} options.hydrateNote
 * @param {() => Promise<void>} options.backupAllNotes
 * @param {(file: File) => Promise<void>} options.restoreFromBackup
 * @param {(file: File) => Promise<void>} options.handlePdfImport
 * @param {() => Promise<File|null>} options.pickPdfFileNative
 * @param {(page: object) => void} options.markPageHydrated
 * @param {(note: object) => void} options.markNoteNormalized
 * @param {string} options.folderPrefix
 */
export function createLibraryEvents({
  getNotes,
  setNotes,
  getActiveId,
  setActiveId,
  getFolders,
  setFolders,
  getActiveFolder,
  setActiveFolder,
  isSelectionMode,
  setSelectionMode,
  getSelectedNoteIds,
  saveNotes,
  saveFolders,
  render,
  folderById,
  notesInCurrentView,
  hydrateNote,
  backupAllNotes,
  restoreFromBackup,
  handlePdfImport,
  pickPdfFileNative,
  markPageHydrated,
  markNoteNormalized,
  folderPrefix: FOLDER_PREFIX,
}) {
  /** Fills library card previews from IndexedDB once the grid is in the DOM. */
  async function hydrateThumbnails() {
    const nodes = [...document.querySelectorAll("img[data-thumb]")];
    await Promise.all(
      nodes.map(async (node) => {
        const assetId = node.dataset.thumb;
        if (!assetId) return;
        try {
          const url = await getAssetUrl(assetId);
          if (url) node.src = url;
        } catch {
          // Leave the placeholder in place if the asset is missing.
        }
      }),
    );
  }

  function updateSelectionToolbar() {
    const toolbar = document.querySelector(".selection-toolbar span");
    if (toolbar) toolbar.textContent = `${getSelectedNoteIds().size} selected`;
    const trashBtn = document.querySelector("#bulk-trash-btn");
    if (trashBtn) trashBtn.disabled = getSelectedNoteIds().size === 0;
  }

  function bindLibraryEvents() {
    hydrateThumbnails();

    // Manual update check (sidebar footer). Silent no-op outside the Mac app.
    document
      .querySelector("#check-updates-btn")
      ?.addEventListener("click", () => checkForUpdates());

    document
      .querySelector("#shortcuts-btn")
      ?.addEventListener("click", () => showShortcutsHelp());

    document.querySelectorAll("[data-open]").forEach((card) => {
      card.addEventListener("click", (e) => {
        if (isSelectionMode()) {
          e.preventDefault();
          const id = card.dataset.open;
          if (getSelectedNoteIds().has(id)) getSelectedNoteIds().delete(id);
          else getSelectedNoteIds().add(id);
          const cb = document.querySelector(`[data-select-note="${id}"]`);
          if (cb) cb.checked = getSelectedNoteIds().has(id);
          updateSelectionToolbar();
          return;
        }
        setActiveId(card.dataset.open);
        render();
      });
    });

    // Sidebar destinations: Unfiled / Pinned / Trash / individual getFolders().
    document.querySelectorAll(".side[data-folder]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        // Folder rows have a small × button to delete the folder; ignore those.
        if (e.target.closest("[data-remove-folder]")) return;
        const target = btn.dataset.folder;
        // If the folder it points to was deleted, fall back to Unfiled.
        if (target && target.startsWith(FOLDER_PREFIX)) {
          const id = target.slice(FOLDER_PREFIX.length);
          if (!folderById(id)) {
            setActiveFolder("unfiled");
            render();
            return;
          }
        }
        setActiveFolder(target);
        render();
      });
    });

    // "+ New folder" button — prompts for a name and creates the folder.
    document.querySelector("#new-folder-btn")?.addEventListener("click", async () => {
      const name = (await showPrompt("Folder name:", ""))?.trim();
      if (!name) return;
      const folder = { id: crypto.randomUUID(), name, createdAt: Date.now() };
      setFolders([...getFolders(), folder]);
      saveFolders();
      setActiveFolder(FOLDER_PREFIX + folder.id);
      render();
    });

    // Per-folder × to remove (getNotes() inside the folder become Unfiled).
    document.querySelectorAll("[data-remove-folder]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.dataset.removeFolder;
        const folder = folderById(id);
        if (!folder) return;
        if (!(await showConfirm(`Delete folder "${folder.name}"? Notes inside will move to Unfiled.`, "Delete", "Cancel"))) return;
        const moved = getNotes().filter((n) => n.folderId === id).length;
        for (const n of getNotes()) if (n.folderId === id) n.folderId = null;
        setFolders(getFolders().filter((f) => f.id !== id));
        saveFolders();
        saveNotes();
        if (getActiveFolder() === FOLDER_PREFIX + id) setActiveFolder("unfiled");
        console.warn(`Removed folder "${folder.name}" (${moved} getNotes() moved to Unfiled)`);
        render();
      });
    });

    // Pin toggle on a card.
    document.querySelectorAll("[data-pin]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const n = getNotes().find((x) => x.id === btn.dataset.pin);
        if (!n) return;
        n.pinned = !n.pinned;
        saveNotes();
        render();
      });
    });

    // Restore from Trash.
    document.querySelectorAll("[data-restore]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const n = getNotes().find((x) => x.id === btn.dataset.restore);
        if (!n) return;
        n.trashed = false;
        saveNotes();
        render();
      });
    });

    // Per-card folder select.
    document.querySelectorAll("[data-folder-select]").forEach((sel) => {
      sel.addEventListener("change", (e) => {
        e.stopPropagation();
        const n = getNotes().find((x) => x.id === sel.dataset.folderSelect);
        if (!n) return;
        const v = sel.value;
        n.folderId = v === "__none__" ? null : v;
        saveNotes();
        // If the note just left the current view, re-render to hide it.
        const stillVisible = notesInCurrentView().some((x) => x.id === n.id);
        if (!stillVisible) render();
      });
      // The card's <button> would otherwise intercept the click; stop bubbling
      // so a click on the select opens the dropdown instead of opening the card.
      sel.addEventListener("click", (e) => e.stopPropagation());
    });

    // Card trash button — move to trash outside trash, delete forever inside.
    document.querySelectorAll("[data-delete-note]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const noteId = btn.dataset.deleteNote;
        const targetNote = getNotes().find((n) => n.id === noteId);
        if (!targetNote) return;
        if (getActiveFolder() === "trashed") {
          if (!(await showConfirm(`Delete "${targetNote.title}" forever? This cannot be undone.`, "Delete forever", "Cancel"))) return;
          // A duplicated page or a shared source PDF can still be referenced by
          // another notebook, so only the ids nothing else points at are removed.
          const stillUsed = new Set();
          for (const other of getNotes()) {
            if (other.id === noteId) continue;
            for (const id of await collectNoteAssetIdsDeep(other)) stillUsed.add(id);
          }
          const orphaned = (await collectNoteAssetIdsDeep(targetNote)).filter(
            (id) => id && !stillUsed.has(id),
          );
          await deleteAssets(orphaned);
          invalidatePdfDoc(targetNote?.pdfAssetId);
          setNotes(getNotes().filter((n) => n.id !== noteId));
          if (getActiveId() === noteId) setActiveId(getNotes()[0]?.id || null);
          saveNotes();
          render();
          return;
        }
        // Move to trash (no confirm — undoable via Restore).
        targetNote.trashed = true;
        // Leaving a folder for trash clears the folder pin.
        saveNotes();
        render();
      });
    });

    // Search filter: title, page tags, and (for hydrated notebooks) the text
    // content of every page. Content search is debounced and only kicks in for
    // queries of three or more characters, so typing stays responsive.
    let searchTimer = null;
    const applySearchFilter = (query, includeContent) => {
      const visible = notesInCurrentView();
      document.querySelectorAll(".note-card-wrapper").forEach((cardWrapper, idx) => {
        const titleEl = cardWrapper.querySelector("strong");
        const title = titleEl ? titleEl.textContent.toLowerCase() : "";
        const note = visible[idx];
        const tags = (note?.pages || [])
          .flatMap((p) => (Array.isArray(p.tags) ? p.tags : []))
          .join(" ")
          .toLowerCase();
        let matches = !query || title.includes(query) || tags.includes(query);
        if (!matches && includeContent && query.length >= 3 && note) {
          matches = noteContainsQuery(note, query);
        }
        cardWrapper.style.display = matches ? "flex" : "none";
      });
    };

    document.querySelector("#search-input")?.addEventListener("input", (e) => {
      const query = e.target.value.toLowerCase().trim();
      if (searchTimer) clearTimeout(searchTimer);
      applySearchFilter(query, false);
      if (query.length >= 3) {
        searchTimer = setTimeout(async () => {
          await Promise.all(notesInCurrentView().map((n) => hydrateNote(n, n.pages.map((_, i) => i))));
          applySearchFilter(query, true);
        }, 300);
      }
    });

    const handleNewNote = () => {
      const newNote = {
        id: crypto.randomUUID(),
        title: "Untitled Notebook",
        createdAt: Date.now(),
        isPdf: false,
        currentPageIndex: 0,
        pages: [
          {
            id: crypto.randomUUID(),
            pageNumber: 1,
            width: 800,
            height: 1130,
            paperStyle: "lined",
            pageSize: "a4",
            thumbnail: null,
            canvasJson: null,
            pendingDecomposedData: null,
            tags: [],
          },
        ],
      };
      for (const page of newNote.pages) markPageHydrated(page);
      markNoteNormalized(newNote);
      getNotes().unshift(newNote);
      setActiveId(newNote.id);
      saveNotes();
      render();
    };

    document
      .querySelector("#selection-mode-btn")
      ?.addEventListener("click", () => {
        setSelectionMode(!isSelectionMode());
        if (!isSelectionMode()) getSelectedNoteIds().clear();
        render();
      });

    document.querySelectorAll("[data-select-note]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = cb.dataset.selectNote;
        if (cb.checked) getSelectedNoteIds().add(id);
        else getSelectedNoteIds().delete(id);
        updateSelectionToolbar();
      });
      cb.addEventListener("click", (e) => e.stopPropagation());
    });

    document
      .querySelector("#bulk-cancel-btn")
      ?.addEventListener("click", () => {
        setSelectionMode(false);
        getSelectedNoteIds().clear();
        render();
      });

    document
      .querySelector("#bulk-move-btn")
      ?.addEventListener("click", () => {
        const folderSelect = document.querySelector("#bulk-folder-select");
        const folderId = folderSelect?.value === "__none__" ? null : folderSelect?.value;
        for (const id of getSelectedNoteIds()) {
          const n = getNotes().find((x) => x.id === id);
          if (n) n.folderId = folderId;
        }
        getSelectedNoteIds().clear();
        setSelectionMode(false);
        saveNotes();
        render();
      });

    document
      .querySelector("#bulk-trash-btn")
      ?.addEventListener("click", async () => {
        if (!getSelectedNoteIds().size) return;
        if (!(await showConfirm(`Move ${getSelectedNoteIds().size} notebook(s) to trash?`, "Trash", "Cancel"))) return;
        for (const id of getSelectedNoteIds()) {
          const n = getNotes().find((x) => x.id === id);
          if (n) n.trashed = true;
        }
        getSelectedNoteIds().clear();
        setSelectionMode(false);
        saveNotes();
        render();
      });

    document
      .querySelector("#new-note-btn")
      ?.addEventListener("click", handleNewNote);
    document
      .querySelector("#fab-new-note")
      ?.addEventListener("click", handleNewNote);

    document
      .querySelector("#backup-btn")
      ?.addEventListener("click", () => backupAllNotes());

    document
      .querySelector("#restore-input")
      ?.addEventListener("change", async (e) => {
        const file = e.target.files?.[0];
        if (file) await restoreFromBackup(file);
        e.target.value = "";
      });

    document
      .querySelector("#restore-btn")
      ?.addEventListener("click", async (e) => {
        if (!isTauriApp()) return;
        e.preventDefault();
        try {
          const { open } = await import("@tauri-apps/plugin-dialog");
          const { readFile } = await import("@tauri-apps/plugin-fs");
          const selected = await open({
            multiple: false,
            filters: [{ name: "OmniNote Backup", extensions: ["omninote", "json"] }],
          });
          if (!selected || Array.isArray(selected)) return;
          const bytes = await readFile(selected);
          const name = String(selected).split("/").pop() || "backup.omninote";
          const file = new File([bytes], name, { type: "application/json" });
          await restoreFromBackup(file);
        } catch (err) {
          console.warn("Native restore pick failed:", err);
        }
      });

    // Import PDF into a single multi-page notebook
    document
      .querySelector("#pdf-input")
      ?.addEventListener("change", async (e) => {
        const file = e.target.files?.[0];
        if (file) await handlePdfImport(file);
        e.target.value = "";
      });

    // Desktop builds can pick a file through the native dialog instead of the
    // hidden file input. Fall back to the input when the plugin is unavailable.
    document
      .querySelector("#import-pdf-btn")
      ?.addEventListener("click", async (e) => {
        if (!isTauriApp()) return;
        e.preventDefault();
        const file = await pickPdfFileNative();
        if (file) await handlePdfImport(file);
      });
  }

  /**
   * True when any page of `note` carries text matching `query`.
   *
   * Walks both the stored object graph and the import handoff, so a notebook that
   * has not been opened yet can still be matched once it is hydrated.
   */
  function noteContainsQuery(note, query) {
    if (!note || !query) return false;
    const needle = query.toLowerCase();
    const walk = (node) => {
      if (!node || typeof node !== "object") return false;
      if (Array.isArray(node)) return node.some(walk);
      if (typeof node.text === "string" && node.text.toLowerCase().includes(needle)) {
        return true;
      }
      for (const value of Object.values(node)) {
        if (walk(value)) return true;
      }
      return false;
    };
    for (const page of note.pages || []) {
      if (walk(page.canvasJson)) return true;
      const pending = page.pendingImportData || page.pendingDecomposedData;
      if (pending && walk(pending)) return true;
    }
    return false;
  }

  return { bindLibraryEvents };
}
