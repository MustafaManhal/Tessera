// Profiles that can start right now: those of installed agents, defaults first. Used by the New task chips, the
// "Start agent in this task" picker and Test launch.
import { useEffect, useState } from "react";
import { agentsClient } from "./service";
import type { AgentInfo, AgentProfile } from "./types";

export interface Launchable {
  agent: AgentInfo;
  profile: AgentProfile;
}

export function useLaunchable(open = true): { items: Launchable[]; loading: boolean } {
  const [items, setItems] = useState<Launchable[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = async () => {
      try {
        const client = agentsClient();
        const [agents, profiles] = await Promise.all([client.agentCatalog(false), client.agentProfilesList(null)]);
        if (!alive) return;
        const byId = new Map(agents.filter((agent) => agent.installed).map((agent) => [agent.id, agent]));
        const next = profiles
          .filter((profile) => byId.has(profile.agent_id))
          .map((profile) => ({ agent: byId.get(profile.agent_id) as AgentInfo, profile }))
          .sort(
            (a, b) =>
              Number(b.profile.is_default) - Number(a.profile.is_default) ||
              a.agent.name.localeCompare(b.agent.name) ||
              a.profile.name.localeCompare(b.profile.name),
          );
        setItems(next);
      } catch {
        if (alive) setItems([]);
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    const stop = agentsClient().onChanged(() => void load());
    return () => {
      alive = false;
      stop();
    };
  }, [open]);
  return { items, loading };
}

/** "Claude Code · Default" */
export function launchableLabel({ agent, profile }: Launchable): string {
  return `${agent.name} · ${profile.name}`;
}
