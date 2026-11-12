// TauriAgentsClient: the generated IPC bindings (brief 24) are the command and event contract.
import { type AppError_Serialize, commands, type CommandResult, events, unwrap } from "@tessera/ipc";
import type { AgentsClient, Unsubscribe } from "./client";
import { mapAgentsError } from "./errors";
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
} from "./types";

function call<T>(result: Promise<CommandResult<T, AppError_Serialize>>): Promise<T> {
  return unwrap(result).catch((cause) => {
    throw mapAgentsError(cause);
  });
}

export class TauriAgentsClient implements AgentsClient {
  agentCatalog(rescan: boolean) {
    return call(commands.agentCatalog(rescan)) as Promise<AgentInfo[]>;
  }
  agentProfilesList(agentId: string | null) {
    return call(commands.agentProfilesList(agentId)) as Promise<AgentProfile[]>;
  }
  agentProfileSave(profile: AgentProfileInput) {
    return call(commands.agentProfileSave(profile)) as Promise<AgentProfile>;
  }
  async agentProfileDelete(id: string) {
    await call(commands.agentProfileDelete(id));
  }
  agentCommandPreview(profileId: string, prompt: string | null) {
    return call(commands.agentCommandPreview(profileId, prompt)) as Promise<CommandPreview>;
  }
  onChanged(listener: () => void): Unsubscribe {
    let stopped = false;
    let stop: (() => void) | null = null;
    void events.agentsChanged
      .listen(() => listener())
      .then((unlisten) => {
        if (stopped) unlisten();
        else stop = unlisten;
      });
    return () => {
      stopped = true;
      stop?.();
    };
  }

  agentStart(input: AgentStartInput) {
    return call(commands.agentStart(input)) as Promise<AgentLaunch>;
  }
  agentSessionAttach(agentSessionId: string, paneSessionId: string, paneId: string | null) {
    return call(commands.agentSessionAttach(agentSessionId, paneSessionId, paneId ?? "")) as Promise<AgentSession>;
  }
  agentSessionExited(agentSessionId: string, exitCode: number | null) {
    // A pane that ended without a code (killed before it reported one) counts as a failure.
    return call(commands.agentSessionExited(agentSessionId, exitCode ?? 1)) as Promise<AgentSession>;
  }
  agentResume(agentSessionId: string) {
    return call(commands.agentResume(agentSessionId)) as Promise<AgentLaunch>;
  }
  agentRestart(agentSessionId: string) {
    return call(commands.agentRestart(agentSessionId)) as Promise<AgentLaunch>;
  }
  agentObserve(agentSessionId: string, observation: AgentObservation) {
    return call(commands.agentObserve(agentSessionId, observation)) as Promise<AgentSession>;
  }
  agentSessionsList(taskId: string | null) {
    return call(commands.agentSessionsList(taskId)) as Promise<AgentSession[]>;
  }
  hooksPreview(agentId: string) {
    return call(commands.hooksPreview(agentId)) as Promise<HookChange>;
  }
  hooksInstall(agentId: string) {
    return call(commands.hooksInstall(agentId)) as Promise<HookChange>;
  }
  hooksRemove(agentId: string) {
    return call(commands.hooksRemove(agentId)) as Promise<HookChange>;
  }
  agentDefinitionGet(id: string) {
    return call(commands.agentDefinitionGet(id)) as Promise<AgentDefinitionInput>;
  }
  async agentDefinitionSave(input: AgentDefinitionInput) {
    await call(commands.agentDefinitionSave(input));
  }
  async agentDefinitionDelete(id: string) {
    await call(commands.agentDefinitionDelete(id));
  }
  agentDefinitionTest(binaries: string[], versionCmd: string[]) {
    return call(commands.agentDefinitionTest(binaries, versionCmd)) as Promise<AgentDefinitionTest>;
  }

  onSessionChanged(listener: (session: AgentSession) => void): Unsubscribe {
    let stopped = false;
    let stop: (() => void) | null = null;
    void events.agentSessionChanged
      .listen((event) => listener(event.payload as AgentSession))
      .then((unlisten) => {
        if (stopped) unlisten();
        else stop = unlisten;
      });
    return () => {
      stopped = true;
      stop?.();
    };
  }
}
