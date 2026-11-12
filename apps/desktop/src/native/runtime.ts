import { isTauri } from "@tauri-apps/api/core";

/** Tauri's IPC mock marks the browser as Tauri; native command adapters stay inert under Playwright. */
export function isNativeRuntime(): boolean {
  return typeof window !== "undefined" && isTauri() && !navigator.webdriver;
}
