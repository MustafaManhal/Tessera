// Pull requests, CI and merge (M7.5, FR-49..FR-51). Mirrors the Rust DTOs in pr_commands.rs.

export interface PrInfo {
  number: number;
  title: string;
  /** open | draft | merged | closed */
  state: string;
  draft: boolean;
  merged: boolean;
  url: string;
  mergeable: boolean | null;
  mergeable_state: string | null;
  ci_state: string | null;
}

export interface CheckItem {
  name: string;
  /** queued | in_progress | completed */
  status: string;
  conclusion: string | null;
  duration_ms: number | null;
  url: string | null;
}

export interface LocalMergeResult {
  merged: boolean;
  conflicts: string[];
  branch: string;
}

export type MergeMethod = "merge" | "squash" | "rebase";
