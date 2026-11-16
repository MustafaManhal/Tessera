// Errors of the project and task commands, shaped like the backend's `AppError {code, message}` plus the typed extras
// some of them carry (`UnmergedCommits{list}`, `NotAGitRepo` with a `can_init` hint).
import type { CommitInfo } from "./types";

export type ProjectsErrorKind =
  | "NotAGitRepo"
  | "AlreadyAdded"
  | "BranchExists"
  | "WorktreeFailed"
  | "SetupNotApproved"
  | "UnmergedCommits"
  | "InvalidCopyFile"
  | "CloneFailed"
  | "Cancelled"
  | "NotFound"
  | "Unknown";

export class ProjectsError extends Error {
  constructor(
    readonly kind: ProjectsErrorKind,
    message: string,
    readonly extra: { canInit?: boolean; commits?: CommitInfo[]; dirty?: boolean; code?: string } = {},
  ) {
    super(message);
    this.name = "ProjectsError";
  }

  get commits(): CommitInfo[] {
    return this.extra.commits ?? [];
  }
}

const KIND_PATTERNS: [RegExp, ProjectsErrorKind][] = [
  [/not[_ .-]?a[_ .-]?git[_ .-]?repo/i, "NotAGitRepo"],
  [/already[_ .-]?added/i, "AlreadyAdded"],
  [/branch[_ .-]?exists/i, "BranchExists"],
  [/worktree[_ .-]?failed/i, "WorktreeFailed"],
  [/setup[_ .-]?not[_ .-]?approved/i, "SetupNotApproved"],
  [/unmerged[_ .-]?commits/i, "UnmergedCommits"],
  [/copy[_ .-]?files?|invalid[_ .-]?copy/i, "InvalidCopyFile"],
  [/clone[_ .-]?failed/i, "CloneFailed"],
  [/cancel/i, "Cancelled"],
  [/not[_ .-]?found|unknown[_ .-]?(project|task)/i, "NotFound"],
];

/** Maps whatever a command rejected with (an `AppError`-like object, an Error, a string) to a ProjectsError. */
export function mapProjectsError(cause: unknown): ProjectsError {
  if (cause instanceof ProjectsError) return cause;
  const record = (typeof cause === "object" && cause !== null ? cause : {}) as Record<string, unknown>;
  const original =
    typeof record.cause === "object" && record.cause !== null ? (record.cause as Record<string, unknown>) : record;
  const code = typeof record.code === "string" ? record.code : typeof original.code === "string" ? original.code : "";
  const message =
    typeof record.message === "string"
      ? record.message
      : typeof original.message === "string"
        ? original.message
        : cause instanceof Error
          ? cause.message
          : String(cause);
  const kind = KIND_PATTERNS.find(([pattern]) => pattern.test(code))?.[1] ?? "Unknown";
  const dataSource = record.data ?? original.data ?? original;
  const data = (typeof dataSource === "object" && dataSource !== null ? dataSource : record) as Record<string, unknown>;
  const list = data.list ?? data.commits;
  const commits = Array.isArray(list)
    ? list.flatMap((entry): CommitInfo[] => {
        if (typeof entry === "string") return [{ hash: "", subject: entry }];
        const item = entry as Record<string, unknown>;
        return typeof item.subject === "string"
          ? [{ hash: typeof item.hash === "string" ? item.hash : "", subject: item.subject }]
          : [];
      })
    : undefined;
  return new ProjectsError(kind, message, {
    code,
    canInit: data.can_init === true,
    dirty: data.dirty === true,
    ...(commits ? { commits } : {}),
  });
}

/** The catalog key for the short, plain sentence shown for an error kind. */
export function errorTitleKey(kind: ProjectsErrorKind) {
  return `projects.error.${kind}` as const;
}
