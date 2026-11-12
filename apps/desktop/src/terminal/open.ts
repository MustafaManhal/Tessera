// Opening links and paths. URLs go through tauri-plugin-opener in the app (the system browser) and
// `window.open(…, "noopener")` in a browser. Paths go to the `open_in_editor` command (`editor.command`). Every request is recorded in `window.__tesseraOpened` in dev builds, so tests
// can check what would have opened.
import { isTauri } from "@tauri-apps/api/core";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { commands, IpcError, unwrap } from "@tessera/ipc";
import { t } from "@tessera/ui";
import { isNativeRuntime } from "../native/runtime";
import { notifications } from "../notify";
import { safeUrl } from "./links";

export type OpenRequest =
  | { kind: "url"; url: string }
  | { kind: "editor"; path: string; line: number; column?: number }
  | { kind: "path"; path: string }
  | { kind: "reveal"; path: string };

declare global {
  interface Window {
    __tesseraOpened?: OpenRequest[];
  }
}

function record(request: OpenRequest): void {
  if (!import.meta.env.DEV) return;
  window.__tesseraOpened ??= [];
  window.__tesseraOpened.push(request);
}

/** Opens an allowed URL (http, https, mailto). Returns false, opening nothing, for any other scheme. */
export async function openExternal(text: string): Promise<boolean> {
  const url = safeUrl(text);
  if (!url) return false;
  record({ kind: "url", url });
  if (isTauri()) await openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
  return true;
}

/**
 * Opens a file at a line in the user's editor (`editor.command` in config.toml). In the app it starts the editor
 * through the `open_in_editor` command and returns true; a failure shows an error toast. In a browser it records the
 * request and returns false, so the caller can say the app is needed.
 */
export function openInEditor(path: string, line: number, column?: number): boolean {
  record(column === undefined ? { kind: "editor", path, line } : { kind: "editor", path, line, column });
  if (!isNativeRuntime()) return false;
  void startEditor(path, line, column ?? null);
  return true;
}

/** Opens a folder (a worktree) in the editor. Resolves false in a browser or when the editor could not start. */
export async function openFolderInEditor(path: string): Promise<boolean> {
  record({ kind: "editor", path, line: 0 });
  if (!isNativeRuntime()) return false;
  return startEditor(path, null, null);
}

async function startEditor(path: string, line: number | null, column: number | null): Promise<boolean> {
  try {
    await unwrap(commands.openInEditor(path, line, column));
    return true;
  } catch (error) {
    const code = error instanceof IpcError ? error.code : "";
    const message = error instanceof Error ? error.message : String(error);
    notifications().toastNow({
      kind: "error",
      title: t(code === "editor.not_found" ? "editor.notFound" : "editor.failed", { message }),
    });
    return false;
  }
}

/**
 * Opens a file with the system's default app (config.toml). Needs `opener:allow-open-path` in the capabilities (the
 * lead adds it, brief 10 report); a refusal or a browser build returns false.
 */
export async function openPathExternal(path: string): Promise<boolean> {
  record({ kind: "path", path });
  if (!isTauri()) return false;
  try {
    await openPath(path);
    return true;
  } catch {
    return false;
  }
}

/** Shows a file or folder in Finder or Explorer (`opener:allow-reveal-item-in-dir` is already granted). */
export async function revealPath(path: string): Promise<boolean> {
  record({ kind: "reveal", path });
  if (!isTauri()) return false;
  try {
    await revealItemInDir(path);
    return true;
  } catch {
    return false;
  }
}
