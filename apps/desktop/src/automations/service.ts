import { isNativeRuntime } from "../native/runtime";
import type { AutomationsClient } from "./client";
import { FakeAutomationsClient } from "./fake";
import { TauriAutomationsClient } from "./tauri";

declare global {
  interface Window {
    __tesseraAutomations?: FakeAutomationsClient;
  }
}

let current: AutomationsClient | null = null;

export function setAutomationsClient(client: AutomationsClient | null): void {
  current = client;
}

export function automationsClient(): AutomationsClient {
  if (!current) throw new Error("No AutomationsClient: call setAutomationsClient first.");
  return current;
}

export function createAutomationsClient(search: string = window.location.search): AutomationsClient {
  const params = new URLSearchParams(search);
  if (isNativeRuntime() && params.get("automations") !== "fake") return new TauriAutomationsClient();
  const fake = new FakeAutomationsClient();
  if (import.meta.env.DEV) window.__tesseraAutomations = fake;
  return fake;
}
