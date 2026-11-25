import { isNativeRuntime } from "../native/runtime";
import type { UsageClient } from "./client";
import { FakeUsageClient } from "./fake";
import { TauriUsageClient } from "./tauri";

declare global {
  interface Window {
    __tesseraUsage?: FakeUsageClient;
  }
}

let current: UsageClient | null = null;

export function setUsageClient(client: UsageClient | null): void {
  current = client;
}

export function usageClient(): UsageClient {
  if (!current) throw new Error("No UsageClient: call setUsageClient first.");
  return current;
}

export function createUsageClient(search: string = window.location.search): UsageClient {
  const params = new URLSearchParams(search);
  if (isNativeRuntime() && params.get("usage") !== "fake") return new TauriUsageClient();
  const fake = new FakeUsageClient();
  if (import.meta.env.DEV) window.__tesseraUsage = fake;
  return fake;
}
