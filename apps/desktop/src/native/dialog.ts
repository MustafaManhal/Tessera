// System folder (and file) pickers behind one adapter, so Playwright can stub them.
// - Tauri: `@tauri-apps/plugin-dialog` (`open({ directory: true })`).
// - Browser / tests: a recording picker at `window.__tesseraFolderPicker` (DEV and webdriver).
import { isTauri } from "@tauri-apps/api/core";

export interface FolderPicker {
  /** Opens a directory picker. Returns the path, or null when the user cancels. */
  pickFolder(options?: { title?: string; defaultPath?: string }): Promise<string | null>;
}

export interface RecordingFolderPicker extends FolderPicker {
  /** What the next `pickFolder` returns (`null` = cancel). */
  next: string | null;
  readonly calls: { title?: string; defaultPath?: string }[];
}

declare global {
  interface Window {
    __tesseraFolderPicker?: RecordingFolderPicker;
  }
}

export function createRecordingFolderPicker(next: string | null = null): RecordingFolderPicker {
  const calls: { title?: string; defaultPath?: string }[] = [];
  const picker: RecordingFolderPicker = {
    next,
    calls,
    pickFolder: async (options) => {
      calls.push({ title: options?.title, defaultPath: options?.defaultPath });
      return picker.next;
    },
  };
  return picker;
}

function tauriPicker(): FolderPicker {
  return {
    async pickFolder(options) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: options?.title,
        defaultPath: options?.defaultPath,
      });
      return typeof selected === "string" ? selected : null;
    },
  };
}

let singleton: FolderPicker | null = null;

function createFolderPicker(): FolderPicker {
  if (typeof window !== "undefined" && window.__tesseraFolderPicker) return window.__tesseraFolderPicker;
  if (isTauri()) return tauriPicker();
  const recording = createRecordingFolderPicker(null);
  if (typeof window !== "undefined" && (import.meta.env.DEV || navigator.webdriver)) {
    window.__tesseraFolderPicker = recording;
  }
  return recording;
}

/** The shared picker (tests set `window.__tesseraFolderPicker.next` before Browse). */
export function folderPicker(): FolderPicker {
  if (!singleton) singleton = createFolderPicker();
  return singleton;
}

/** Tests: drop the cached picker so the next call picks up a new stub. */
export function resetFolderPicker(): void {
  singleton = null;
}

// Eager install in the browser so tests can set `.next` before the first Browse click.
if (typeof window !== "undefined" && !isTauri()) folderPicker();
