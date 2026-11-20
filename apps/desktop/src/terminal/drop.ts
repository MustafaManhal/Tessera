// Files dropped on a pane insert their quoted paths (FR-12). In a browser the pane's own drop event gives only file
// names (`File.name`); in Tauri the WebView reports full paths through `onDragDropEvent` (HTML drop events do not fire
// there), with a position we map to the pane under it. `window.__tesseraDrop(paths, x, y)` fires the same path in dev
// builds, so tests can drop "native" files without a real drag.
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getPlatform } from "@tessera/ui";
import { useEffect } from "react";
import { paneTerminal } from "./panes";
import { quotePaths } from "./paste";

declare global {
  interface Window {
    __tesseraDrop?: (paths: string[], x: number, y: number) => boolean;
  }
}

/** Inserts the paths into the terminal pane under the point (CSS pixels). Returns whether a pane took them. */
export function dropPathsAt(paths: readonly string[], x: number, y: number): boolean {
  const element = document.elementFromPoint(x, y);
  // A folder dropped on the add-project dialog fills its path field.
  const zone = element?.closest<HTMLElement>("[data-drop-folder]");
  if (zone && paths.length > 0) {
    zone.dispatchEvent(new CustomEvent("tessera:folder-drop", { detail: [...paths] }));
    return true;
  }
  const paneId = element?.closest<HTMLElement>("[data-terminal-pane]")?.dataset.terminalPane;
  const terminal = paneId ? paneTerminal(paneId) : undefined;
  if (!terminal || paths.length === 0) return false;
  terminal.insert(quotePaths(paths, getPlatform()));
  terminal.engine.focus();
  return true;
}

/** Listens for native file drops for the app's lifetime (Tauri), and installs the dev test hook. */
export function useNativeDrops(): void {
  useEffect(() => {
    if (import.meta.env.DEV) window.__tesseraDrop = dropPathsAt;
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        // Positions are physical pixels; elementFromPoint wants CSS pixels.
        const scale = window.devicePixelRatio || 1;
        dropPathsAt(event.payload.paths, event.payload.position.x / scale, event.payload.position.y / scale);
      })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
