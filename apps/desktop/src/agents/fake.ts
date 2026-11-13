// FakeAgentsClient: an in-memory catalog and profile store for the browser dev server and tests. The ten bundled
// agents are realistic (three installed, one user override with a definition error), one default profile per installed
// agent, the backend's validation and error codes, and `onChanged` after every change.
import type { AgentsClient, Unsubscribe } from "./client";
import { AgentsError } from "./errors";
import { isValidEnvKey } from "./args";
import type {
  AgentDefinitionInput,
  AgentDefinitionTest,
  AgentInfo,
  AgentObservation,
  AgentLaunch,
  AgentProfile,
  AgentProfileInput,
  AgentSession,
  AgentStartInput,
  CommandPreview,
  HookChange,
  HookState,
  AgentSource,
} from "./types";

export interface FakeAgentsOptions {
  /** Milliseconds every call waits (simulated IPC); 0 in unit tests. */
  latencyMs?: number;
  /** How long a rescan takes; long enough for the busy state to be visible. */
  rescanMs?: number;
  /** Clock for timestamps. */
  now?: () => number;
}

/** The permission-skipping flag each bundled agent is known for (only used when the profile asks, FR-42). */
const YOLO_FLAGS: Record<string, string> = {
  claude: "--dangerously-skip-permissions",
  codex: "--dangerously-bypass-approvals-and-sandbox",
  gemini: "--yolo",
  opencode: "--dangerously-skip-permissions",
  "cursor-agent": "--force",
  amp: "--dangerously-allow-all",
  qwen: "--yolo",
  copilot: "--allow-all-tools",
  aider: "--yes-always",
  droid: "--skip-permissions-unsafe",
};

const baseName = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1) || path;

/** The ten bundled definitions, in the order the catalog lists them before the installed-first sort. */
function definitions(now: number): AgentInfo[] {
  const found = (id: string, name: string, icon: string, version: string, path: string) => ({
    id,
    name,
    icon,
    installed: true,
    binary_path: path,
    version,
    detected_at: now,
  });
  const missing = { installed: false, binary_path: null, version: null, detected_at: null };
  const agent = (
    id: string,
    name: string,
    icon: string,
    install_url: string,
    docs_url: string,
    extra: {
      prompt_mode?: string;
      supports_resume?: boolean;
      hooks?: AgentInfo["hooks"];
      hooks_state?: HookState;
      has_skip_permissions?: boolean;
      source?: AgentSource;
      definition_error?: string | null;
    } = {},
  ): AgentInfo => ({
    id,
    name,
    icon,
    install_url,
    docs_url,
    prompt_mode: "arg",
    supports_resume: true,
    hooks: "none",
    hooks_state: "unsupported",
    has_skip_permissions: false,
    source: "bundled",
    definition_error: null,
    ...missing,
    ...extra,
  });
  return [
    {
      ...agent(
        "claude",
        "Claude Code",
        "Sparkles",
        "https://docs.claude.com/en/docs/claude-code/setup",
        "https://docs.claude.com/en/docs/claude-code",
        {
          hooks: "claude-settings",
          hooks_state: "installed",
          has_skip_permissions: true,
        },
      ),
      ...found("claude", "Claude Code", "Sparkles", "2.1.4", "/opt/homebrew/bin/claude"),
    },
    {
      ...agent(
        "codex",
        "OpenAI Codex",
        "Terminal",
        "https://github.com/openai/codex#installation",
        "https://github.com/openai/codex",
        {
          hooks: "codex-config",
          hooks_state: "outdated",
          has_skip_permissions: true,
          prompt_mode: "stdin",
        },
      ),
      ...found("codex", "OpenAI Codex", "Terminal", "0.55.0", "/opt/homebrew/bin/codex"),
    },
    {
      ...agent(
        "gemini",
        "Gemini CLI",
        "Gem",
        "https://github.com/google-gemini/gemini-cli#quickstart",
        "https://github.com/google-gemini/gemini-cli",
        {
          hooks: "gemini-settings",
          hooks_state: "none",
          has_skip_permissions: true,
          prompt_mode: "type",
        },
      ),
      ...found("gemini", "Gemini CLI", "Gem", "0.11.3", "/usr/local/bin/gemini"),
    },
    {
      ...agent("opencode", "OpenCode", "SquareTerminal", "https://opencode.ai/docs/", "https://opencode.ai/docs/", {
        supports_resume: true,
      }),
    },
    {
      ...agent(
        "cursor-agent",
        "Cursor Agent",
        "MousePointerClick",
        "https://cursor.com/cli",
        "https://cursor.com/docs/cli/overview",
        {
          has_skip_permissions: true,
        },
      ),
    },
    {
      ...agent("amp", "Amp", "Zap", "https://ampcode.com/manual#install", "https://ampcode.com/manual", {
        hooks: "none",
        has_skip_permissions: true,
      }),
    },
    {
      ...agent(
        "qwen",
        "Qwen Code",
        "Moon",
        "https://github.com/QwenLM/qwen-code#installation",
        "https://github.com/QwenLM/qwen-code",
        {
          supports_resume: false,
          has_skip_permissions: true,
        },
      ),
    },
    {
      ...agent(
        "copilot",
        "GitHub Copilot CLI",
        "GitPullRequest",
        "https://github.com/github/copilot-cli",
        "https://github.com/github/copilot-cli",
        {
          has_skip_permissions: true,
        },
      ),
    },
    {
      ...agent("aider", "Aider", "GitBranch", "https://aider.chat/docs/install.html", "https://aider.chat/docs", {
        prompt_mode: "flag:--message",
        supports_resume: false,
        has_skip_permissions: true,
        source: "override",
        definition_error: "agents/aider.toml, line 12: unknown key `model-flags`; the bundled definition is in use.",
      }),
    },
    {
      ...agent(
        "droid",
        "Factory Droid",
        "Bot",
        "https://docs.factory.ai/cli/getting-started/quickstart",
        "https://docs.factory.ai/cli/getting-started/quickstart",
        {
          has_skip_permissions: true,
        },
      ),
    },
  ];
}

/** The config file each hook kind lives in (what the review dialog names). */
const HOOK_PATHS: Record<Exclude<AgentInfo["hooks"], "none">, string> = {
  "claude-settings": "~/.claude/settings.json",
  "codex-config": "~/.codex/config.toml",
  "gemini-settings": "~/.gemini/settings.json",
};

/** The hook snippet each kind writes (kept small but shaped like the real configs). */
const HOOK_SNIPPETS: Record<Exclude<AgentInfo["hooks"], "none">, { add: string[]; remove: string[] }> = {
  "claude-settings": {
    add: [
      '  "hooks": {',
      '    "Notification": [',
      '      { "hooks": [{ "type": "command", "command": "tessera hooks claude" }] }',
      "    ]",
      "  },",
    ],
    remove: [
      '  "hooks": {',
      '    "Notification": [',
      '      { "hooks": [{ "type": "command", "command": "tessera hooks claude" }] }',
      "    ]",
      "  },",
    ],
  },
  "codex-config": {
    add: ['notify = ["tessera", "hooks", "codex"]', 'tessera_hook_version = "2"'],
    remove: ['notify = ["tessera", "hooks", "codex"]', 'tessera_hook_version = "2"'],
  },
  "gemini-settings": {
    add: ['  "hooks": {', '    "AfterAgent": [{ "command": "tessera hooks gemini" }]', "  },"],
    remove: ['  "hooks": {', '    "AfterAgent": [{ "command": "tessera hooks gemini" }]', "  },"],
  },
};

function unifiedDiff(kind: AgentInfo["hooks"], direction: "install" | "remove"): string {
  const lines = HOOK_SNIPPETS[kind as Exclude<AgentInfo["hooks"], "none">];
  const path = HOOK_PATHS[kind as Exclude<AgentInfo["hooks"], "none">];
  const body = direction === "install" ? lines.add : lines.remove;
  const sign = direction === "install" ? "+" : "-";
  const header = [`--- a/${path}`, `+++ b/${path}`, `@@ -1,3 +1,${3 + body.length} @@`];
  return `${[...header, " {", ...body.map((line) => `${sign}${line}`), " }"].join("\n")}\n`;
}

export class FakeAgentsClient implements AgentsClient {
  private catalog: AgentInfo[];
  private profiles: AgentProfile[] = [];
  private nextProfile = 1;
  private readonly latency: number;
  private rescanMs: number;
  private readonly now: () => number;
  private readonly changed = new Set<() => void>();
  private readonly sessionListeners = new Set<(session: AgentSession) => void>();
  private readonly sessions = new Map<string, AgentSession>();
  private nextSession = 1;
  /** Per-agent hook preview overrides (tests stage a conflict or an unparseable file). */
  private readonly hookPreviews = new Map<string, HookChange>();
  /** Full custom definitions by id (what `agentDefinitionGet` returns for the editor). */
  private readonly definitions = new Map<string, AgentDefinitionInput>();
  /** Catalog rows a bundled-id override replaced, restored when the override file is deleted. */
  private readonly overridden = new Map<string, AgentInfo>();
  /** Test hook: binaries the fake "finds" on PATH even though no bundled agent owns them. */
  readonly installedBinaries = new Set<string>();
  /** Test hook: forces the `agentDefinitionTest` result (null = the heuristic). */
  testHandler: ((binaries: string[], versionCmd: string[]) => AgentDefinitionTest) | null = null;
  /** Calls received, by method (tests). */
  readonly calls: { method: string; args: unknown[] }[] = [];

  constructor(options: FakeAgentsOptions = {}) {
    this.latency = options.latencyMs ?? 0;
    this.rescanMs = options.rescanMs ?? 160;
    let tick = 1_760_000_000_000;
    this.now = options.now ?? (() => (tick += 1000));
    this.catalog = definitions(this.now());
    this.seedProfiles();
    // Snapshot the bundled rows so deleting an override restores them.
    for (const agent of this.catalog)
      if (agent.source === "bundled") this.overridden.set(agent.id, structuredClone(agent));
  }

  async agentCatalog(rescan: boolean): Promise<AgentInfo[]> {
    await this.wait("agentCatalog", rescan);
    if (rescan) {
      // Detection takes a moment; the UI shows the button busy.
      await new Promise((resolve) => setTimeout(resolve, this.rescanMs));
      for (const agent of this.catalog) {
        if (agent.installed) agent.detected_at = this.now();
      }
      this.emit();
    }
    return this.catalog.map((agent) => structuredClone(agent));
  }

  async agentProfilesList(agentId: string | null): Promise<AgentProfile[]> {
    await this.wait("agentProfilesList", agentId);
    return this.profiles
      .filter((profile) => (agentId === null ? true : profile.agent_id === agentId))
      .map((profile) => structuredClone(profile));
  }

  async agentProfileSave(profile: AgentProfileInput): Promise<AgentProfile> {
    await this.wait("agentProfileSave", profile);
    this.requireAgent(profile.agent_id);
    const name = profile.name.trim();
    if (name === "") throw new AgentsError("agent.profile_invalid", "The profile needs a name.");
    for (const key of Object.keys(profile.env)) {
      if (!isValidEnvKey(key))
        throw new AgentsError(
          "agent.profile_invalid",
          `"${key}" is not a valid environment variable name: letters, digits and underscores, starting with a letter or underscore.`,
        );
    }
    const now = this.now();
    const existing = profile.id === null ? null : this.profiles.find((candidate) => candidate.id === profile.id);
    if (profile.id !== null && !existing)
      throw new AgentsError("agent.profile_not_found", `Unknown agent profile ${profile.id}`);
    const first = !this.profiles.some(
      (candidate) => candidate.agent_id === profile.agent_id && candidate.id !== existing?.id,
    );
    const saved: AgentProfile = {
      id: existing?.id ?? `prof_${this.nextProfile++}`,
      agent_id: profile.agent_id,
      name,
      model: profile.model?.trim() ? profile.model.trim() : null,
      extra_args: [...profile.extra_args],
      env: { ...profile.env },
      skip_permissions: profile.skip_permissions,
      // The first profile of an agent is its default; editing cannot leave an agent without one.
      is_default: existing ? existing.is_default || profile.is_default : profile.is_default || first,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (saved.is_default)
      for (const candidate of this.profiles)
        if (candidate.agent_id === saved.agent_id && candidate.id !== saved.id) candidate.is_default = false;
    if (existing) this.profiles[this.profiles.indexOf(existing)] = saved;
    else this.profiles.push(saved);
    this.emit();
    return structuredClone(saved);
  }

  async agentProfileDelete(id: string): Promise<void> {
    await this.wait("agentProfileDelete", id);
    const profile = this.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new AgentsError("agent.profile_not_found", `Unknown agent profile ${id}`);
    this.profiles = this.profiles.filter((candidate) => candidate.id !== id);
    // Keep one default per agent when the default was deleted.
    if (profile.is_default) {
      const next = this.profiles.find((candidate) => candidate.agent_id === profile.agent_id);
      if (next) next.is_default = true;
    }
    this.emit();
  }

  async agentCommandPreview(profileId: string, prompt: string | null): Promise<CommandPreview> {
    await this.wait("agentCommandPreview", profileId, prompt);
    const profile = this.profiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw new AgentsError("agent.profile_not_found", `Unknown agent profile ${profileId}`);
    const agent = this.requireAgent(profile.agent_id);
    const program = agent.binary_path ? baseName(agent.binary_path) : agent.id;
    const args: string[] = [];
    if (profile.model) args.push("--model", profile.model);
    args.push(...profile.extra_args);
    const skipping = profile.skip_permissions && agent.has_skip_permissions;
    if (skipping) args.push(YOLO_FLAGS[agent.id] ?? "--skip-permissions");
    if (prompt !== null && prompt !== "") {
      if (agent.prompt_mode === "arg") args.push(prompt);
      else if (agent.prompt_mode.startsWith("flag:")) args.push(agent.prompt_mode.slice("flag:".length), prompt);
    }
    return {
      program,
      args,
      env_keys: Object.keys(profile.env).sort(),
      prompt_mode: agent.prompt_mode,
      skip_permissions: skipping,
    };
  }

  onChanged(listener: () => void): Unsubscribe {
    this.changed.add(listener);
    return () => {
      this.changed.delete(listener);
    };
  }

  async agentStart(input: AgentStartInput): Promise<AgentLaunch> {
    await this.wait("agentStart", input);
    const profile = this.profiles.find((candidate) => candidate.id === input.profile_id);
    if (!profile) throw new AgentsError("agent.profile_not_found", `Unknown agent profile ${input.profile_id}`);
    const agent = this.requireAgent(profile.agent_id);
    if (!agent.installed)
      throw new AgentsError("agent.not_installed", `${agent.name} is not installed on this computer.`);
    const id = `as_${this.nextSession++}`;
    const plan = this.plan(profile, agent, { taskId: input.task_id, prompt: input.prompt, cwd: input.cwd, id });
    const now = this.now();
    const session: AgentSession = {
      id,
      task_id: input.task_id,
      pane_session_id: null,
      pane_id: null,
      agent_id: agent.id,
      profile_id: profile.id,
      status: "starting",
      status_source: "launch",
      status_at: now,
      status_message: null,
      exit_code: null,
      prompt: input.prompt,
      started_at: now,
      ended_at: null,
    };
    this.sessions.set(id, session);
    this.emitSession(session);
    return structuredClone(plan);
  }

  async agentSessionAttach(
    agentSessionId: string,
    paneSessionId: string,
    paneId: string | null,
  ): Promise<AgentSession> {
    await this.wait("agentSessionAttach", agentSessionId, paneSessionId, paneId);
    const session = this.requireSession(agentSessionId);
    const next: AgentSession = {
      ...session,
      pane_session_id: paneSessionId,
      pane_id: paneId,
      status: "working",
      status_source: "attach",
      status_at: this.now(),
    };
    this.sessions.set(next.id, next);
    this.emitSession(next);
    return structuredClone(next);
  }

  async agentSessionExited(agentSessionId: string, exitCode: number | null): Promise<AgentSession> {
    await this.wait("agentSessionExited", agentSessionId, exitCode);
    const session = this.requireSession(agentSessionId);
    const now = this.now();
    const next: AgentSession = {
      ...session,
      status: "exited",
      status_source: "exit",
      status_at: now,
      exit_code: exitCode,
      ended_at: now,
    };
    this.sessions.set(next.id, next);
    this.emitSession(next);
    return structuredClone(next);
  }

  async agentResume(agentSessionId: string): Promise<AgentLaunch> {
    await this.wait("agentResume", agentSessionId);
    const old = this.requireSession(agentSessionId);
    const agent = this.requireAgent(old.agent_id);
    if (!agent.supports_resume || !old.external_session_id)
      throw new AgentsError(
        "agent.resume_unsupported",
        "This session has no supported resume command or captured session ID.",
      );
    const profile = this.profiles.find((p) => p.id === old.profile_id);
    if (!profile) throw new AgentsError("agent.profile_not_found", "The agent profile could not be found.");
    const plan = this.plan(profile, agent, { taskId: old.task_id, prompt: null, cwd: null, id: crypto.randomUUID() });
    plan.args = ["--resume", old.external_session_id];
    const next = {
      ...old,
      id: plan.agent_session_id,
      pane_session_id: null,
      status: "starting" as const,
      ended_at: null,
      exit_code: null,
      prompt: null,
    };
    this.sessions.set(next.id, next);
    this.emitSession(next);
    return structuredClone(plan);
  }

  async agentRestart(agentSessionId: string): Promise<AgentLaunch> {
    await this.wait("agentRestart", agentSessionId);
    const session = this.requireSession(agentSessionId);
    const profile = this.profiles.find((candidate) => candidate.id === session.profile_id);
    if (!profile) throw new AgentsError("agent.profile_not_found", `Unknown agent profile ${session.profile_id}`);
    const agent = this.requireAgent(profile.agent_id);
    const plan = this.plan(profile, agent, {
      taskId: session.task_id,
      prompt: session.prompt,
      cwd: null,
      id: session.id,
    });
    const next: AgentSession = {
      ...session,
      pane_session_id: null,
      status: "starting",
      status_source: "restart",
      status_at: this.now(),
      exit_code: null,
      ended_at: null,
    };
    this.sessions.set(next.id, next);
    this.emitSession(next);
    return structuredClone(plan);
  }

  async agentSessionsList(taskId: string | null): Promise<AgentSession[]> {
    await this.wait("agentSessionsList", taskId);
    return [...this.sessions.values()]
      .filter((session) => (taskId === null ? true : session.task_id === taskId))
      .map((session) => structuredClone(session));
  }

  onSessionChanged(listener: (session: AgentSession) => void): Unsubscribe {
    this.sessionListeners.add(listener);
    return () => {
      this.sessionListeners.delete(listener);
    };
  }

  async agentObserve(agentSessionId: string, observation: AgentObservation): Promise<AgentSession> {
    await this.wait("agentObserve", agentSessionId, observation);
    const session = this.requireSession(agentSessionId);
    if (session.ended_at !== null) return structuredClone(session);
    // A deterministic stand-in for the Rust state machine, enough for sidebar and pane tests.
    let status: AgentSession["status"] | null = null;
    let message: string | null = null;
    if (observation.kind === "osc_notification") {
      status = /done|completed|finished/i.test(observation.text) ? "idle" : "needs_input";
      message = observation.text;
    } else if (observation.kind === "osc_progress") {
      if (observation.state === 2) status = "error";
      else if (observation.state !== 0) status = "working";
    } else if (observation.kind === "screen") {
      const last = observation.lines.filter((line) => line.trim()).at(-1) ?? "";
      if (/approve|permission/i.test(last)) {
        status = "needs_input";
        message = last;
      }
    } else if (observation.kind === "silence" && observation.seconds >= 5) {
      // Like the real engine: silence only idles a session that is not already waiting on the user.
      if (session.status !== "needs_input") status = "idle";
    }
    if (status !== null && status !== session.status) {
      session.status = status;
      session.status_source =
        observation.kind === "screen" ? "pattern" : observation.kind === "silence" ? "silence" : "osc";
      session.status_at = this.now();
    }
    if (message !== null) session.status_message = message;
    this.emitSession(session);
    return structuredClone(session);
  }

  async hooksPreview(agentId: string): Promise<HookChange> {
    await this.wait("hooksPreview", agentId);
    const agent = this.requireAgent(agentId);
    const override = this.hookPreviews.get(agentId);
    if (override) return structuredClone(override);
    if (agent.hooks === "none" || agent.hooks_state === "unsupported")
      return { config_path: "", state: "unsupported", diff: "" };
    const path = HOOK_PATHS[agent.hooks];
    // The preview shows the diff of the one action the state offers: install, update, or remove.
    if (agent.hooks_state === "installed")
      return { config_path: path, state: "installed", diff: unifiedDiff(agent.hooks, "remove") };
    if (agent.hooks_state === "outdated")
      return { config_path: path, state: "outdated", diff: unifiedDiff(agent.hooks, "install") };
    return { config_path: path, state: "none", diff: unifiedDiff(agent.hooks, "install") };
  }

  async hooksInstall(agentId: string): Promise<HookChange> {
    await this.wait("hooksInstall", agentId);
    const agent = this.requireAgent(agentId);
    const override = this.hookPreviews.get(agentId);
    if (override?.state === "conflict") throw new AgentsError("hooks.conflict", "Another program owns the hooks.");
    if (override?.state === "unparseable")
      throw new AgentsError("hooks.unparseable", `Tessera cannot read ${override.config_path}.`);
    if (agent.hooks === "none" || agent.hooks_state === "unsupported")
      throw new AgentsError("hooks.unsupported", `${agent.name} has no status hooks.`);
    agent.hooks_state = "installed";
    this.hookPreviews.delete(agentId);
    this.emit();
    return { config_path: HOOK_PATHS[agent.hooks], state: "installed", diff: "" };
  }

  async hooksRemove(agentId: string): Promise<HookChange> {
    await this.wait("hooksRemove", agentId);
    const agent = this.requireAgent(agentId);
    const override = this.hookPreviews.get(agentId);
    if (override?.state === "conflict") throw new AgentsError("hooks.conflict", "Another program owns the hooks.");
    if (override?.state === "unparseable")
      throw new AgentsError("hooks.unparseable", `Tessera cannot read ${override.config_path}.`);
    if (agent.hooks === "none" || agent.hooks_state === "unsupported")
      throw new AgentsError("hooks.unsupported", `${agent.name} has no status hooks.`);
    agent.hooks_state = "none";
    this.hookPreviews.delete(agentId);
    this.emit();
    return { config_path: HOOK_PATHS[agent.hooks], state: "none", diff: "" };
  }

  async agentDefinitionGet(id: string): Promise<AgentDefinitionInput> {
    await this.wait("agentDefinitionGet", id);
    const stored = this.definitions.get(id);
    if (stored) return structuredClone(stored);
    const agent = this.requireAgent(id);
    if (agent.source === "bundled") {
      // The backend returns the effective (bundled) definition; approximate it for the editor.
      return {
        id: agent.id,
        name: agent.name,
        binaries: [agent.id],
        version_cmd: [agent.id, "--version"],
        prompt_mode: agent.prompt_mode,
        model_flag: null,
        resume: agent.supports_resume ? [agent.id, "--resume", "{external_session_id}"] : [],
        yolo_flags: [],
        hooks: "none",
        ready_pattern: null,
        install_url: agent.install_url,
        docs_url: agent.docs_url,
        icon: agent.icon,
        allow_override: false,
      };
    }
    throw new AgentsError("agent.unknown", `Unknown agent ${id}`);
  }

  async agentDefinitionSave(input: AgentDefinitionInput): Promise<void> {
    await this.wait("agentDefinitionSave", input);
    this.validateDefinition(input);
    const bundled = this.catalog.some(
      (agent) =>
        (agent.id === input.id && agent.source === "bundled") ||
        (agent.id === input.id && this.overridden.has(agent.id)),
    );
    if (bundled && !input.allow_override)
      throw new AgentsError(
        "agent.definition_duplicate",
        `The id "${input.id}" belongs to a bundled agent; confirm the override to replace its fields.`,
      );
    const detection = this.detectDefinition(input.binaries, input.version_cmd);
    const source: AgentSource = bundled ? "override" : "user";
    const existing = this.catalog.findIndex((agent) => agent.id === input.id);
    const row: AgentInfo = {
      id: input.id,
      name: input.name.trim(),
      icon: input.icon || "bot",
      installed: detection.found,
      binary_path: detection.binary_path,
      version: detection.version,
      detected_at: detection.found ? this.now() : null,
      install_url: input.install_url || input.binaries[0] || input.name,
      docs_url: input.docs_url || "https://",
      prompt_mode: input.prompt_mode,
      supports_resume: input.resume.length > 0,
      hooks: "none",
      hooks_state: "unsupported",
      has_skip_permissions: input.yolo_flags.length > 0,
      source,
      definition_error: null,
    };
    if (existing >= 0) this.catalog[existing] = row;
    else this.catalog.push(row);
    const stored = { ...input, name: row.name, install_url: row.install_url, docs_url: row.docs_url };
    this.definitions.set(input.id, stored);
    // Like the backend's first-discovery rule: an installed agent gets one default profile.
    if (row.installed && !this.profiles.some((p) => p.agent_id === row.id)) {
      await this.agentProfileSave({
        id: null,
        agent_id: row.id,
        name: "Default",
        model: null,
        extra_args: [],
        env: {},
        skip_permissions: false,
        is_default: true,
      });
    }
    this.emit();
  }

  async agentDefinitionDelete(id: string): Promise<void> {
    await this.wait("agentDefinitionDelete", id);
    if (!/^[a-z0-9-]{1,64}$/.test(id))
      throw new AgentsError(
        "agent.definition_invalid",
        `The id "${id}" may only use lower-case letters, digits and dashes.`,
      );
    const agent = this.catalog.find((candidate) => candidate.id === id);
    if (!agent || (agent.source === "bundled" && !this.definitions.has(id)))
      throw new AgentsError("agent.definition_not_found", "The custom agent definition could not be found.");
    const profiles = this.profiles.filter((profile) => profile.agent_id === id);
    if (profiles.length > 0)
      throw new AgentsError(
        "agent.definition_in_use",
        `Delete or reassign these profiles first: ${profiles.map((p) => p.name).join(", ")}.`,
      );
    this.definitions.delete(id);
    if (agent.source === "override" || agent.source === "user") {
      const original = this.overridden.get(id);
      const index = this.catalog.findIndex((candidate) => candidate.id === id);
      if (original && agent.source === "override") this.catalog[index] = structuredClone(original);
      else this.catalog.splice(index, 1);
    }
    this.emit();
  }

  async agentDefinitionTest(binaries: string[], versionCmd: string[]): Promise<AgentDefinitionTest> {
    await this.wait("agentDefinitionTest", binaries, versionCmd);
    if (this.testHandler) return this.testHandler(binaries, versionCmd);
    if (binaries.length === 0 || binaries.some((b) => b.trim() === ""))
      throw new AgentsError("agent.definition_invalid", "At least one nonempty binary name is required.");
    if (versionCmd.length === 0 || versionCmd.some((v) => v.trim() === ""))
      throw new AgentsError("agent.definition_invalid", "The version-cmd field must contain a command.");
    return this.detectDefinition(binaries, versionCmd);
  }

  /** Mirrors `definition.rs` validation closely enough for the dialog's inline errors. */
  private validateDefinition(input: AgentDefinitionInput): void {
    const invalid = (message: string) => new AgentsError("agent.definition_invalid", message);
    if (input.name.trim() === "") throw invalid("The name field must not be blank.");
    if (!/^[a-z0-9-]{1,64}$/.test(input.id))
      throw invalid(`The id "${input.id}" may only use lower-case letters, digits and dashes.`);
    if (input.binaries.length === 0 || input.binaries.some((b) => b.trim() === ""))
      throw invalid("At least one nonempty binary name is required.");
    if (input.version_cmd.length === 0 || input.version_cmd.some((v) => v.trim() === ""))
      throw invalid("The version-cmd field must contain a command.");
    if (!["arg", "stdin", "type"].includes(input.prompt_mode) && !input.prompt_mode.startsWith("flag:"))
      throw invalid("The prompt-mode must be arg, stdin, type, or flag:<name>.");
    if (input.ready_pattern) {
      try {
        new RegExp(input.ready_pattern);
      } catch {
        throw invalid(`The ready-pattern regex ${JSON.stringify(input.ready_pattern)} is invalid.`);
      }
    }
  }

  /** A binary counts as found when a bundled agent owns it or a test added it to `installedBinaries`. */
  private detectDefinition(binaries: string[], _versionCmd: string[]): AgentDefinitionTest {
    for (const binary of binaries) {
      const name = baseName(binary);
      if (this.installedBinaries.has(name))
        return { found: true, binary_path: `/usr/local/bin/${name}`, version: "1.0.0", error: null };
      const owner = this.catalog.find(
        (agent) => agent.installed && agent.binary_path && baseName(agent.binary_path) === name,
      );
      if (owner)
        return {
          found: true,
          binary_path: owner.binary_path,
          version: owner.version,
          error: null,
        };
    }
    return { found: false, binary_path: null, version: null, error: null };
  }

  /** Test helper: deliver a captured vendor ID without guessing one from arbitrary output. */
  setExternalSessionId(id: string, external: string | null): void {
    const session = this.requireSession(id);
    session.external_session_id = external;
    this.emitSession(session);
  }

  /** Test helper: set a session's status/message directly and emit `agent:session_changed`. */
  setSessionStatus(id: string, status: AgentSession["status"], message: string | null = null): void {
    const session = this.requireSession(id);
    session.status = status;
    session.status_source = "hook";
    session.status_at = this.now();
    session.status_message = message;
    if (status === "exited") session.ended_at = this.now();
    this.emitSession(session);
  }

  /** Test helper: make the next hooksPreview for an agent report a staged state (conflict, unparseable, ...). */
  setHookPreview(agentId: string, change: HookChange | null): void {
    this.requireAgent(agentId);
    if (change === null) this.hookPreviews.delete(agentId);
    else this.hookPreviews.set(agentId, structuredClone(change));
  }

  // Test and demo helpers -----------------------------------------------------------------------------------------

  /** Makes a rescan take a given time, so a test can watch the busy state. */
  setRescanMs(ms: number): void {
    this.rescanMs = ms;
  }

  /** Marks an agent installed (or not) behind the UI's back, then emits `agents:changed`. */
  setInstalled(id: string, installed: boolean, version = "1.0.0", path = `/usr/local/bin/${id}`): void {
    const agent = this.requireAgent(id);
    agent.installed = installed;
    agent.binary_path = installed ? path : null;
    agent.version = installed ? version : null;
    agent.detected_at = installed ? this.now() : null;
    this.emit();
  }

  /** All profiles, for assertions. */
  allProfiles(): AgentProfile[] {
    return this.profiles.map((profile) => structuredClone(profile));
  }

  // Internals ------------------------------------------------------------------------------------------------------

  private async wait(method: string, ...args: unknown[]): Promise<void> {
    this.calls.push({ method, args });
    if (this.latency > 0) await new Promise((resolve) => setTimeout(resolve, this.latency));
  }

  private requireSession(id: string): AgentSession {
    const session = this.sessions.get(id);
    if (!session) throw new AgentsError("agent.session_not_found", `Unknown agent session ${id}`);
    return session;
  }

  /** The plan Rust would build: program, flags, env, and how the prompt reaches the CLI (all four modes). */
  private plan(
    profile: AgentProfile,
    agent: AgentInfo,
    input: { taskId: string | null; prompt: string | null; cwd: string | null; id: string },
  ): AgentLaunch {
    const program = agent.binary_path ? baseName(agent.binary_path) : agent.id;
    const args: string[] = [];
    if (profile.model) args.push("--model", profile.model);
    args.push(...profile.extra_args);
    const skip = profile.skip_permissions && agent.has_skip_permissions;
    if (skip) args.push(YOLO_FLAGS[agent.id] ?? "--skip-permissions");
    let stdin: string | null = null;
    let typed: string | null = null;
    let ready: string | null = null;
    const prompt = input.prompt?.trim() ? input.prompt : null;
    if (prompt) {
      if (agent.prompt_mode === "stdin") stdin = prompt.endsWith("\n") ? prompt : `${prompt}\n`;
      else if (agent.prompt_mode === "type") {
        typed = prompt;
        // The fake shell prints this banner at spawn, so the paste follows a real "ready" line in tests.
        ready = "Type help\\.";
      } else if (agent.prompt_mode.startsWith("flag:")) args.push(agent.prompt_mode.slice("flag:".length), prompt);
      else args.push(prompt);
    }
    return {
      agent_session_id: input.id,
      agent_id: agent.id,
      agent_name: agent.name,
      icon: agent.icon,
      profile_id: profile.id,
      profile_name: profile.name,
      task_id: input.taskId,
      cwd: input.cwd ?? "~",
      program,
      args,
      env: { ...profile.env },
      stdin,
      type_after_ready: typed,
      ready_pattern: ready,
      skip_permissions: skip,
    };
  }

  private emitSession(session: AgentSession): void {
    for (const listener of [...this.sessionListeners]) listener(structuredClone(session));
  }

  private requireAgent(id: string): AgentInfo {
    const agent = this.catalog.find((candidate) => candidate.id === id);
    if (!agent) throw new AgentsError("agent.unknown", `Unknown agent ${id}`);
    return agent;
  }

  private emit(): void {
    for (const listener of this.changed) listener();
  }

  private seedProfiles(): void {
    const now = this.now();
    const profile = (
      agentId: string,
      name: string,
      model: string,
      extraArgs: string[],
      env: Record<string, string>,
    ): AgentProfile => ({
      id: `prof_${this.nextProfile++}`,
      agent_id: agentId,
      name,
      model,
      extra_args: extraArgs,
      env,
      skip_permissions: false,
      is_default: true,
      created_at: now,
      updated_at: now,
    });
    this.profiles = [
      profile("claude", "Claude Code", "sonnet", ["--verbose"], { ANTHROPIC_LOG: "warn" }),
      profile("codex", "Codex", "gpt-5-codex", [], {}),
      profile("gemini", "Gemini", "gemini-2.5-pro", [], { GEMINI_CLI_NO_UPDATE: "1" }),
    ];
  }
}
