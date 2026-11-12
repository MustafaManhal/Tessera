// The agent catalog and profile types (M6.1). They mirror the Rust IPC contract in brief 24 exactly, snake_case
// fields included, so the generated bindings slot in without a translation layer.

/** Which config file a status hook lives in; "none" means OSC and output heuristics only. */
export type AgentHooks = "claude-settings" | "codex-config" | "gemini-settings" | "none";

export type HookState = "none" | "installed" | "outdated" | "unsupported";

/** What a hook preview/install/remove reports (M6.4). `diff` is unified diff text; empty for explanations. */
export type HookChangeState = "installed" | "outdated" | "none" | "conflict" | "unparseable" | "unsupported";

export interface HookChange {
  config_path: string;
  state: HookChangeState;
  diff: string;
}

/** Where a definition came from: bundled with the app, a user file, or a user file overriding a bundled id. */
export type AgentSource = "bundled" | "user" | "override";

/** "arg", "stdin", "type", or "flag:<name>" (how the prompt reaches the CLI). Kept as a string: definitions add modes. */
export type PromptMode = string;

export interface AgentInfo {
  id: string;
  name: string;
  /** A lucide icon name ("Sparkles"); an unknown name falls back to a generic icon. */
  icon: string;
  installed: boolean;
  binary_path: string | null;
  version: string | null;
  install_url: string;
  docs_url: string;
  prompt_mode: PromptMode;
  supports_resume: boolean;
  hooks: AgentHooks;
  hooks_state: HookState;
  has_skip_permissions: boolean;
  source: AgentSource;
  /** A user or override file failed to load; the bundled definition is in use. */
  definition_error: string | null;
  detected_at: number | null;
}

export interface AgentProfile {
  id: string;
  agent_id: string;
  name: string;
  model: string | null;
  extra_args: string[];
  env: Record<string, string>;
  skip_permissions: boolean;
  is_default: boolean;
  created_at: number;
  updated_at: number;
}

/** What `agent_profile_save` takes: no timestamps, and a null id creates a profile. */
export interface AgentProfileInput {
  id: string | null;
  agent_id: string;
  name: string;
  model: string | null;
  extra_args: string[];
  env: Record<string, string>;
  skip_permissions: boolean;
  is_default: boolean;
}

/** What `agent_start` takes (M6.2): the profile, the task's prompt and folder, and no pane yet. */
export interface AgentStartInput {
  task_id: string | null;
  profile_id: string;
  prompt: string | null;
  cwd: string | null;
}

/** The plan Rust builds for the front end to spawn: it never starts a PTY itself. */
export interface AgentLaunch {
  agent_session_id: string;
  agent_id: string;
  agent_name: string;
  /** A lucide icon name ("Sparkles"). */
  icon: string;
  profile_id: string;
  profile_name: string;
  task_id: string | null;
  cwd: string | null;
  program: string;
  args: string[];
  env: Record<string, string>;
  /** The prompt goes to stdin after spawn ("stdin" mode). */
  stdin: string | null;
  /** The prompt is typed once the output matches `ready_pattern` ("type" mode). */
  type_after_ready: string | null;
  ready_pattern: string | null;
  skip_permissions: boolean;
}

export type AgentStatus = "starting" | "working" | "needs_input" | "idle" | "error" | "exited";

/** A launched agent and where its PTY runs (M6.2); the backend owns this row and emits changes. */
export interface AgentSession {
  id: string;
  task_id: string | null;
  pane_session_id: string | null;
  pane_id: string | null;
  agent_id: string;
  profile_id: string;
  status: AgentStatus;
  status_source: string;
  status_at: number;
  /** The latest hook message, OSC text or matched screen line behind the status. */
  status_message: string | null;
  exit_code: number | null;
  prompt: string | null;
  started_at: number;
  ended_at: number | null;
  external_session_id?: string | null;
}

/** What the pane observed, forwarded to the backend status engine (`agent_observe`). */
export type AgentObservation =
  | { kind: "osc_notification"; text: string }
  | { kind: "osc_progress"; state: number; value: number | null }
  | { kind: "screen"; lines: string[] }
  | { kind: "silence"; seconds: number };

/** Everything the custom-agent dialog edits (FR-34). `allow_override` consents to reusing a bundled id. */
export interface AgentDefinitionInput {
  id: string;
  name: string;
  binaries: string[];
  version_cmd: string[];
  prompt_mode: PromptMode;
  model_flag: string | null;
  resume: string[];
  yolo_flags: string[];
  hooks: AgentHooks;
  ready_pattern: string | null;
  install_url: string;
  docs_url: string;
  icon: string;
  allow_override: boolean;
}

/** What `agent_definition_test` reports: detection on the login PATH, version command only. */
export interface AgentDefinitionTest {
  found: boolean;
  binary_path: string | null;
  version: string | null;
  error: string | null;
}

export interface CommandPreview {
  program: string;
  args: string[];
  /** Names only: values never leave the backend. */
  env_keys: string[];
  prompt_mode: PromptMode;
  skip_permissions: boolean;
}
