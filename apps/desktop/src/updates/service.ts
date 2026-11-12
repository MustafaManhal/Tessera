import { isNativeRuntime } from "../native/runtime";
import type { UpdatesClient } from "./client";
import { FakeUpdatesClient } from "./fake";
import { TauriUpdatesClient } from "./tauri";

declare global {
  interface Window {
    __tesseraUpdates?: FakeUpdatesClient;
  }
}

let current: UpdatesClient | null = null;

export function setUpdatesClient(client: UpdatesClient | null): void {
  current = client;
}

export function updatesClient(): UpdatesClient {
  if (!current) throw new Error("No UpdatesClient: call setUpdatesClient first.");
  return current;
}

export function createUpdatesClient(search: string = window.location.search): UpdatesClient {
  const params = new URLSearchParams(search);
  if (isNativeRuntime() && params.get("updates") !== "fake") return new TauriUpdatesClient();
  const fake = new FakeUpdatesClient();
  if (import.meta.env.DEV) window.__tesseraUpdates = fake;
  return fake;
}
