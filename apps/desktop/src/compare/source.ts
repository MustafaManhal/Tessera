// Per-file diffs for the compare view (S-08): the contract the view needs, a deterministic fake for tests, and the
// real source built on the review panel's `review_files` / `review_file_diff` commands.
import { diff as lineDiff } from "@codemirror/merge";
import { reviewClient } from "../review/client";

/** A unified-style text of a base/head pair (whole lines, hunks merged with 2 lines of context omitted: the
 * compare columns only show the changed lines). */
export function unifiedText(path: string, base: string, head: string): string {
  const changes = lineDiff(base, head);
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const change of changes) {
    for (const line of base.slice(change.fromA, change.toA).split("\n")) if (line !== "") out.push(`-${line}`);
    for (const line of head.slice(change.fromB, change.toB).split("\n")) if (line !== "") out.push(`+${line}`);
  }
  return out.join("\n");
}

/** The real source: files and diffs of a task through the review commands (local or over ssh). */
export class ReviewCompareDiffSource implements CompareDiffSource {
  async files(taskId: string): Promise<string[]> {
    return (await reviewClient().files(taskId)).map((file) => file.path);
  }
  async diff(taskId: string, path: string): Promise<string | null> {
    const file = await reviewClient().diff(taskId, path);
    if (file.binary) return "Binary file changed";
    if (file.too_large) return "File too large to compare here";
    if (file.base_text === null && file.head_text === null) return null;
    return unifiedText(path, file.base_text ?? "", file.head_text ?? "");
  }
}

export interface CompareDiffSource {
  /** Changed file paths of one task, relative to its worktree. */
  files(taskId: string): Promise<string[]>;
  /** Unified diff text of one file in one task; null when the file is unchanged there. */
  diff(taskId: string, path: string): Promise<string | null>;
}

/** Deterministic fake: every task "changes" a shared set plus one task-specific file. */
export class FakeCompareDiffSource implements CompareDiffSource {
  private readonly extra = new Map<string, string[]>();

  /** Test hook: give a task its own changed files (default: `src/${taskId}.ts`). */
  setFiles(taskId: string, files: string[]) {
    this.extra.set(taskId, files);
  }

  async files(taskId: string): Promise<string[]> {
    return [...new Set(["src/app.ts", "src/util.ts", ...(this.extra.get(taskId) ?? [`src/${taskId}.ts`])])];
  }

  async diff(taskId: string, path: string): Promise<string | null> {
    const files = await this.files(taskId);
    if (!files.includes(path)) return null;
    const n = taskId.length + path.length;
    const add = (n % 5) + 1;
    const del = (n % 3) + 1;
    const lines = [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -1,${del + 2} +1,${add + 2} @@`,
      ...Array.from({ length: del }, (_, i) => `-old line ${i + 1} (${taskId})`),
      ...Array.from({ length: add }, (_, i) => `+new line ${i + 1} (${taskId})`),
      " context",
    ];
    return lines.join("\n");
  }
}

declare global {
  interface Window {
    __tesseraCompareDiff?: FakeCompareDiffSource;
  }
}

let current: CompareDiffSource | null = null;
export function setCompareDiffSource(source: CompareDiffSource | null) {
  current = source;
}
export function compareDiffSource(): CompareDiffSource {
  if (!current) {
    if (import.meta.env.DEV) {
      const fake = new FakeCompareDiffSource();
      window.__tesseraCompareDiff = fake;
      current = fake;
    } else {
      current = new ReviewCompareDiffSource();
    }
  }
  return current;
}
