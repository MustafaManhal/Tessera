// DTOs of the project and task commands, mirroring `.ai/docs/05-backend-schema.md` §3 (columns) and §4.1 (commands).
// UI-facing forms of the generated IPC DTOs. Timestamps are Unix milliseconds (schema §1).

export type TaskState = "backlog" | "setting_up" | "active" | "archived" | "deleted" | "error";

export interface CopyFile {
  /** Relative path inside the repo: no `..`, not absolute, no drive letter. */
  path: string;
  mode: "copy" | "symlink";
}

/** `needs_approval`: a setup script exists and its hash (shell + NUL + script) is not the approved one. */
export type SetupState = "none" | "approved" | "needs_approval";

export interface Project {
  id: string;
  name: string;
  path: string;
  remote_url: string | null;
  default_branch: string;
  worktree_dir: string | null;
  setup_script: string | null;
  setup_shell: string | null;
  setup_approved_hash: string | null;
  /** From the backend's pure `setup_state(project)`. */
  setup_state: SetupState;
  copy_files: CopyFile[];
  port_base: number | null;
  default_profile_id: string | null;
  is_muted: boolean;
  sort: number;
  /** `worktrees`: each task gets its own worktree. `branches`: tasks work on branches inside the project folder. */
  work_mode: WorkMode;
  created_at: number | null;
  updated_at: number | null;
}

export type WorkMode = "worktrees" | "branches";

export interface RunScript {
  id: string;
  project_id: string;
  name: string;
  command: string;
  auto_start: boolean;
  sort: number;
}

export interface Task {
  id: string;
  project_id: string;
  group_id: string | null;
  name: string;
  slug: string;
  branch: string;
  base_branch: string;
  /** null for a task on the main checkout. */
  worktree_path: string | null;
  uses_main_checkout: boolean;
  /** Works on a branch that was already there; deleting the task keeps it. */
  keeps_branch: boolean;
  state: TaskState;
  prompt: string | null;
  port_start: number | null;
  port_count: number;
  last_message: string | null;
  pr_number?: number | null;
  pr_url?: string | null;
  pr_state?: string | null;
  ci_state?: string | null;
  created_at: number | null;
  updated_at: number | null;
  archived_at: number | null;
}

/** `task_list` row: the task plus git facts that may be null when git could not answer. */
export interface TaskSummary extends Task {
  ahead: number | null;
  behind: number | null;
  changed_files: number | null;
  /** Listening ports (`task_ports`), when known. */
  ports: number[];
}

/** A repository on an SSH host (M10.2): `host_id` from the SSH host list, `path` absolute or starting with `~/`. */
export interface RemoteProjectInput {
  host_id: string;
  path: string;
  name?: string | null;
}

/** A project on an SSH host has a path `ssh://<alias>/<path on the host>`. */
export function remoteHost(path: string): string | null {
  const match = /^ssh:\/\/([^/\\]+)/.exec(path);
  return match?.[1] ?? null;
}

export interface ProjectInput {
  /** An existing folder (a git repo, or a folder to initialise). */
  path?: string;
  /** Or a clone URL, cloned into `clone_dir`. */
  clone_url?: string;
  clone_dir?: string;
  name?: string;
}

export interface ProjectPatch {
  name?: string;
  default_branch?: string;
  worktree_dir?: string | null;
  setup_script?: string | null;
  setup_shell?: string | null;
  copy_files?: CopyFile[];
  port_base?: number | null;
  is_muted?: boolean;
  sort?: number;
  work_mode?: WorkMode;
}

export interface RunScriptInput {
  name: string;
  command: string;
  auto_start: boolean;
}

export interface TaskCreateInput {
  project_id: string;
  name?: string;
  prompt?: string;
  base_branch: string;
  /** An existing local branch to check out instead of creating a new one. */
  existing_branch?: string;
  /** Agent profiles to start (none until agents exist, M6). */
  agents: { profile_id: string }[];
  use_main_checkout: boolean;
  run_setup: boolean;
}

/** What the UI needs after `task_create` to run the project's setup script. */
export interface SetupInfo {
  state: SetupState;
  script: string | null;
  shell: string | null;
  /** Hash chip text (first 12 hex chars of the approved or current hash). */
  hash: string | null;
}

export interface TaskGroupInfo {
  id: string;
  project_id: string;
  name: string;
  prompt: string;
  picked_task_id: string | null;
  created_at: number;
}

export interface TaskGroupCreateInput {
  project_id: string;
  prompt: string;
  base_branch: string;
  name: string;
  profile_ids: string[];
}

export interface TaskCreateResult {
  group_id: string | null;
  tasks: Task[];
  setup: SetupInfo;
}

export interface TaskFilter {
  project_id?: string;
  include_archived: boolean;
}

export interface CommitInfo {
  hash: string;
  subject: string;
}

/** One checkout of a repository, from `git worktree list`. */
export interface WorktreeFacts {
  path: string;
  /** Short branch name; null when detached or bare. */
  branch: string | null;
  detached: boolean;
  bare: boolean;
}

/** A worktree with what the worktrees manager shows (`worktree_details`). Worktrees live only on this computer. */
export interface WorktreeDetail {
  path: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  /** The project folder itself. */
  is_main: boolean;
  /** Git lists it but its folder is gone. */
  missing: boolean;
  locked: string | null;
  dirty: boolean;
  /** The remote branch with this branch's name (`origin/x`); null: the branch exists only on this computer. */
  remote_branch: string | null;
}

export interface RepoFacts {
  root: string;
  branch: string | null;
  default_branch: string | null;
  remote_url: string | null;
  bare: boolean;
}

/** `task:changed {task_id, summary}`; a `deleted` state means the row is gone. */
export interface TaskChangedEvent {
  task_id: string;
  summary: TaskSummary;
}

export interface CloneProgress {
  /** 0–100, or null when unknown. */
  percent: number | null;
  message: string;
}

export const SETUP_HASH_CHARS = 12;
