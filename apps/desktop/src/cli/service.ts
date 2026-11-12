// The app's CliClient, set once at startup (main.tsx) and read by the settings row. Tests set their own.
// The native app uses the real commands; the browser dev server and the UI tests use the in-memory fake.
import { isNativeRuntime } from "../native/runtime";
import type { CliClient } from "./client";
import { FakeCliClient } from "./fake";
import { TauriCliClient } from "./tauri";

declare global {
  interface Window {
    __tesseraCli?: FakeCliClient;
  }
}

let current: CliClient | null = null;

export function setCliClient(client: CliClient | null): void {
  current = client;
}

export function cliClient(): CliClient {
  if (!current) throw new Error("No CliClient: call setCliClient first.");
  return current;
}

/** The native app talks to Rust (`?cli=fake` keeps the fake there); the browser uses the fake. */
export function createCliClient(search: string = window.location.search): CliClient {
  const params = new URLSearchParams(search);
  if (isNativeRuntime() && params.get("cli") !== "fake") return new TauriCliClient();
  const fake = new FakeCliClient();
  if (import.meta.env.DEV) window.__tesseraCli = fake;
  return fake;
}
