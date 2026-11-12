import { isNativeRuntime } from "../native/runtime";
import type { IssuesClient } from "./client";
import { FakeIssuesClient } from "./fake";
import { TauriIssuesClient } from "./tauri";

declare global {
  interface Window {
    __tesseraIssues?: FakeIssuesClient;
  }
}

let current: IssuesClient | null = null;

export function setIssuesClient(client: IssuesClient | null): void {
  current = client;
}

export function issuesClient(): IssuesClient {
  if (!current) throw new Error("No IssuesClient: call setIssuesClient first.");
  return current;
}

export function createIssuesClient(search: string = window.location.search): IssuesClient {
  const params = new URLSearchParams(search);
  if (isNativeRuntime() && params.get("issues") !== "fake") return new TauriIssuesClient();
  const fake = new FakeIssuesClient();
  if (import.meta.env.DEV) window.__tesseraIssues = fake;
  return fake;
}
