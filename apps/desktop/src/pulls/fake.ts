// In-memory PullsClient for DEV/tests: per-task PR state, a canned checks list, merge methods and a
// failure log. Mirrors the backend's validation and error codes.

import type { PullsClient } from "./client";
import type { CheckItem, LocalMergeResult, MergeMethod, PrInfo } from "./types";

export class FakePullsClient implements PullsClient {
  /** taskId → PR state the fake "GitHub" knows about. */
  prs = new Map<string, PrInfo & { head_sha: string }>();
  /** taskId → checks returned by prChecks. */
  checks = new Map<string, CheckItem[]>();
  /** taskId → log tail returned by prFailureLog. */
  failureLogs = new Map<string, string>();
  /** taskIds whose next prCreate/prMerge rejects (push or API failure simulation). */
  failCreate = new Set<string>();
  failMerge = new Set<string>();
  /** When set, prMergeLocal reports these conflicts instead of merging. */
  mergeConflicts = new Map<string, string[]>();
  calls: string[] = [];

  private info(taskId: string): PrInfo & { head_sha: string } {
    const existing = this.prs.get(taskId);
    if (existing) return existing;
    return {
      number: 0,
      title: "",
      state: "open",
      draft: false,
      merged: false,
      url: "",
      mergeable: null,
      mergeable_state: null,
      ci_state: null,
      head_sha: "deadbeef",
    };
  }

  async prCreate(taskId: string, title: string, _body: string, draft: boolean): Promise<PrInfo> {
    this.calls.push(`prCreate:${taskId}`);
    await Promise.resolve();
    if (this.failCreate.has(taskId)) {
      throw Object.assign(new Error("git push failed: could not read from remote"), { code: "pr.invalid" });
    }
    const pr = this.info(taskId);
    pr.number = pr.number || 42;
    pr.title = title;
    pr.draft = draft;
    pr.state = "open";
    pr.url = `https://github.com/o/r/pull/${pr.number}`;
    pr.head_sha = "deadbeef";
    this.prs.set(taskId, pr);
    return { ...pr };
  }

  async prRefresh(taskId: string): Promise<PrInfo> {
    this.calls.push(`prRefresh:${taskId}`);
    await Promise.resolve();
    const pr = this.prs.get(taskId);
    if (!pr || pr.number === 0) {
      throw Object.assign(new Error("This task has no pull request yet."), { code: "pr.invalid" });
    }
    return { ...pr };
  }

  async prChecks(taskId: string): Promise<CheckItem[]> {
    this.calls.push(`prChecks:${taskId}`);
    await Promise.resolve();
    return this.checks.get(taskId) ?? [];
  }

  async prFailureLog(taskId: string): Promise<string> {
    this.calls.push(`prFailureLog:${taskId}`);
    await Promise.resolve();
    const log = this.failureLogs.get(taskId);
    if (log === undefined) {
      throw Object.assign(new Error("No failing check run found."), { code: "pr.invalid" });
    }
    return log;
  }

  async prMerge(taskId: string, method: MergeMethod): Promise<PrInfo> {
    this.calls.push(`prMerge:${taskId}:${method}`);
    await Promise.resolve();
    if (this.failMerge.has(taskId)) {
      throw Object.assign(new Error("GitHub refused the merge: not mergeable"), { code: "pr.invalid" });
    }
    const pr = this.prs.get(taskId);
    if (!pr || pr.number === 0) {
      throw Object.assign(new Error("This task has no pull request yet."), { code: "pr.invalid" });
    }
    pr.merged = true;
    pr.state = "closed";
    pr.ci_state = "success";
    return { ...pr };
  }

  async prMergeLocal(taskId: string): Promise<LocalMergeResult> {
    this.calls.push(`prMergeLocal:${taskId}`);
    await Promise.resolve();
    const conflicts = this.mergeConflicts.get(taskId);
    if (conflicts) {
      return { merged: false, conflicts, branch: "main" };
    }
    return { merged: true, conflicts: [], branch: "main" };
  }

  /** Test helper: seed a PR as if it already exists. */
  seed(taskId: string, pr: Partial<PrInfo & { head_sha: string }>) {
    this.prs.set(taskId, { ...this.info(taskId), number: 42, ...pr });
  }
}
