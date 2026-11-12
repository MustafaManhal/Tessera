// The app's SyncClient: the real commands in the native app, the fake in the browser and tests.
import { isNativeRuntime } from "../native/runtime";
import type { SyncClient } from "./client";
import { FakeSyncClient } from "./fake";
import { TauriSyncClient } from "./tauri";

declare global {
  interface Window {
    __tesseraSync?: FakeSyncClient;
  }
}

let current: SyncClient | null = null;

export function syncClient(): SyncClient {
  if (current) return current;
  if (isNativeRuntime() && new URLSearchParams(window.location.search).get("sync") !== "fake") {
    current = new TauriSyncClient();
  } else {
    const fake = new FakeSyncClient();
    if (import.meta.env.DEV) window.__tesseraSync = fake;
    current = fake;
  }
  return current;
}
