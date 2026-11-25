// The app's ProjectsClient, set once at startup (main.tsx) and read by thunks and components. Tests set their own.
import { isNativeRuntime } from "../native/runtime";
import type { ProjectsClient } from "./client";
import { FakeProjectsClient } from "./fake";
import { TauriProjectsClient } from "./tauri";

declare global {
  interface Window {
    __tesseraProjects?: FakeProjectsClient;
  }
}

let current: ProjectsClient | null = null;

export function setProjectsClient(client: ProjectsClient | null): void {
  current = client;
}

export function projectsClient(): ProjectsClient {
  if (!current) throw new Error("No ProjectsClient: call setProjectsClient first.");
  return current;
}

/**
 * Browser and tests use the in-memory fake; a native app uses the generated IPC client. `?projects=tauri` also allows
 * exercising the native client in the isolated Playwright IPC harness.
 */
export function createProjectsClient(search: string = window.location.search): ProjectsClient {
  const params = new URLSearchParams(search);
  if (isNativeRuntime() && params.get("projects") !== "fake") return new TauriProjectsClient();
  const fake = new FakeProjectsClient({ demo: params.has("demo"), latencyMs: params.has("demo") ? 120 : 0 });
  if (import.meta.env.DEV) window.__tesseraProjects = fake;
  return fake;
}
