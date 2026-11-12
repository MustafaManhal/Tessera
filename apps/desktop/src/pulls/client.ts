import { isTauri } from "@tauri-apps/api/core";
import { FakePullsClient } from "./fake";
import { TauriPullsClient } from "./tauri";
import type { CheckItem, LocalMergeResult, MergeMethod, PrInfo } from "./types";

export interface PullsClient {
  /** Pushes the task branch and creates (or finds) its pull request. Rejects with pr.invalid, github.not_connected. */
  prCreate(taskId: string, title: string, body: string, draft: boolean): Promise<PrInfo>;
  /** Refreshes PR state and the CI rollup (conditional GETs). Rejects with pr.invalid, github.not_connected. */
  prRefresh(taskId: string): Promise<PrInfo>;
  /** The S-09 checks list for the PR head. */
  prChecks(taskId: string): Promise<CheckItem[]>;
  /** Last 200 lines of the failing check's job log. */
  prFailureLog(taskId: string): Promise<string>;
  /** Merges the PR on GitHub. Rejects with pr.invalid when GitHub refuses. */
  prMerge(taskId: string, method: MergeMethod): Promise<PrInfo>;
  /** Merges the branch into the base in the main checkout; conflicts come back as paths. */
  prMergeLocal(taskId: string): Promise<LocalMergeResult>;
}

// -- Singleton -------------------------------------------------------------------------------------------------

declare global {
  interface Window {
    __tesseraPulls?: PullsClient;
  }
}

let client: PullsClient | null = null;

// DEV/tests: expose the fake eagerly so specs can seed it before the first pulls() call.
if (import.meta.env.DEV && !isTauri() && typeof window !== "undefined" && !window.__tesseraPulls) {
  window.__tesseraPulls = new FakePullsClient();
}

export function pulls(): PullsClient {
  if (!client) {
    client =
      import.meta.env.DEV && !isTauri()
        ? ((window.__tesseraPulls as FakePullsClient) ?? new FakePullsClient())
        : new TauriPullsClient();
    if (import.meta.env.DEV && typeof window !== "undefined") window.__tesseraPulls = client;
  }
  return client;
}
