// The app's AgentsClient, set once at startup (main.tsx) and read by the screen. Tests set their own.
// The native app uses the real commands; the browser dev server and the UI tests use the in-memory fake.
import { isNativeRuntime } from "../native/runtime";
import { FakeAgentsClient } from "./fake";
import type { AgentsClient } from "./client";
import { TauriAgentsClient } from "./tauri";

declare global {
  interface Window {
    __tesseraAgents?: FakeAgentsClient;
  }
}

let current: AgentsClient | null = null;

export function setAgentsClient(client: AgentsClient | null): void {
  current = client;
}

export function agentsClient(): AgentsClient {
  if (!current) throw new Error("No AgentsClient: call setAgentsClient first.");
  return current;
}

/**
 * The native app talks to Rust (`?agents=fake` keeps the fake there); browser and tests use the in-memory fake,
 * where `?demo` adds simulated IPC and rescan latency so the loading states can be seen.
 */
export function createAgentsClient(search: string = window.location.search): AgentsClient {
  const params = new URLSearchParams(search);
  if (isNativeRuntime() && params.get("agents") !== "fake") return new TauriAgentsClient();
  const fake = new FakeAgentsClient({
    latencyMs: params.has("demo") ? 120 : 0,
    rescanMs: params.has("demo") ? 700 : 160,
  });
  if (import.meta.env.DEV) window.__tesseraAgents = fake;
  return fake;
}
