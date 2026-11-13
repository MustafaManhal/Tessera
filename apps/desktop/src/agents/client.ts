// AgentsClient: the agent catalog and profile commands behind one interface, like ProjectsClient.
// - FakeAgentsClient (fake.ts): in memory, for the browser dev server and tests.
// - TauriAgentsClient (tauri.ts): the generated bindings and the `agents:changed` event.
import type {
  AgentDefinitionInput,
  AgentDefinitionTest,
  AgentInfo,
  AgentObservation,
  HookChange,
  AgentLaunch,
  AgentProfile,
  AgentProfileInput,
  AgentSession,
  AgentStartInput,
  CommandPreview,
} from "./types";

export type Unsubscribe = () => void;

export interface AgentsClient {
  /** Detection from PATH; `rescan` ignores the cache. */
  agentCatalog(rescan: boolean): Promise<AgentInfo[]>;
  /** All profiles, or one agent's. */
  agentProfilesList(agentId: string | null): Promise<AgentProfile[]>;
  /** Creates when `id` is null. Rejects with AgentsError: agent.unknown, agent.profile_invalid. */
  agentProfileSave(profile: AgentProfileInput): Promise<AgentProfile>;
  /** Rejects with agent.profile_not_found. */
  agentProfileDelete(id: string): Promise<void>;
  /** Reloads with AgentsError on an unknown profile or definition. Env values never appear in the preview. */
  agentCommandPreview(profileId: string, prompt: string | null): Promise<CommandPreview>;
  /**
   * Feeds the status engine: OSC notification/progress, the visible screen or silence. Cheap — the backend
   * writes only on a real change.
   */
  agentObserve(agentSessionId: string, observation: AgentObservation): Promise<AgentSession>;
  /** The backend changed the catalog or a profile (a rescan, a save, a delete). */
  onChanged(listener: () => void): Unsubscribe;
  /**
   * Builds the launch plan (program, args, env, prompt delivery); the front end spawns the PTY.
   * Rejects with agent.profile_not_found, agent.not_installed, task.not_found.
   */
  agentStart(input: AgentStartInput): Promise<AgentLaunch>;
  /** Ties the agent session to the pane's PTY session; returns the session. Rejects with agent.session_not_found. */
  agentSessionAttach(agentSessionId: string, paneSessionId: string, paneId: string | null): Promise<AgentSession>;
  /** Reports the PTY exit; the session ends with that code. */
  agentSessionExited(agentSessionId: string, exitCode: number | null): Promise<AgentSession>;
  /** A fresh plan for the same profile, to relaunch in the same pane. */
  agentRestart(agentSessionId: string): Promise<AgentLaunch>;
  agentResume(agentSessionId: string): Promise<AgentLaunch>;
  /** A task's sessions, or every session when `taskId` is null. */
  agentSessionsList(taskId: string | null): Promise<AgentSession[]>;
  /** A session changed status; the payload is the whole row. */
  onSessionChanged(listener: (session: AgentSession) => void): Unsubscribe;
  /**
   * What installing/updating/removing the agent's status hooks would change. `state` explains a refusal
   * (conflict, unparseable, unsupported) instead of a diff.
   * Rejects with hooks.unsupported, hooks.conflict, hooks.unparseable, agent.unknown.
   */
  hooksPreview(agentId: string): Promise<HookChange>;
  /** Applies the previewed install/update. Rejects like hooksPreview. */
  hooksInstall(agentId: string): Promise<HookChange>;
  /** Removes the hooks. Rejects like hooksPreview. */
  hooksRemove(agentId: string): Promise<HookChange>;
  /** The stored definition behind an agent id, for the custom-agent editor. Rejects with agent.unknown. */
  agentDefinitionGet(id: string): Promise<AgentDefinitionInput>;
  /**
   * Writes `<config>/agents/<id>.toml` and reloads the catalog. Rejects with agent.definition_invalid,
   * agent.definition_duplicate (bundled id without `allow_override`).
   */
  agentDefinitionSave(input: AgentDefinitionInput): Promise<void>;
  /**
   * Deletes a custom definition. Rejects with agent.definition_in_use while profiles use the agent
   * (the message lists them), agent.definition_not_found, agent.definition_invalid.
   */
  agentDefinitionDelete(id: string): Promise<void>;
  /**
   * Detects `binaries` on the login PATH and runs only the version command — never the agent with a
   * prompt. Rejects with agent.definition_invalid for an empty command or bad field.
   */
  agentDefinitionTest(binaries: string[], versionCmd: string[]): Promise<AgentDefinitionTest>;
}
