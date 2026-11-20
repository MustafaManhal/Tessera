// The catalog and profiles screen's data: one load, the `agents:changed` subscription, the rescan busy state, and the
// load error. Small enough not to need its own Redux slice (the screen is the only reader).
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentsClient } from "./client";
import { agentsErrorMessage } from "./errors";
import type { AgentInfo, AgentProfile } from "./types";

export interface AgentsView {
  /** Null until the first load finishes. */
  catalog: AgentInfo[] | null;
  profiles: AgentProfile[];
  /** The first load is running. */
  loading: boolean;
  /** A rescan is running (the Rescan button shows it). */
  rescanning: boolean;
  /** A catalog or profile load failed; the last good catalog stays. */
  error: string | null;
  reload: () => Promise<void>;
  rescan: () => Promise<void>;
}

export function useAgents(client: AgentsClient): AgentsView {
  const [catalog, setCatalog] = useState<AgentInfo[] | null>(null);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [rescanning, setRescanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);
  // Only the newest request may write state (a rescan and an event can overlap).
  const generation = useRef(0);

  const load = useCallback(
    async (rescan: boolean): Promise<void> => {
      const id = ++generation.current;
      if (rescan) setRescanning(true);
      else if (!loaded.current) setLoading(true);
      try {
        const [nextCatalog, nextProfiles] = await Promise.all([
          client.agentCatalog(rescan),
          client.agentProfilesList(null),
        ]);
        if (generation.current !== id) return;
        loaded.current = true;
        setCatalog(nextCatalog);
        setProfiles(nextProfiles);
        setError(null);
      } catch (cause) {
        if (generation.current !== id) return;
        setError(agentsErrorMessage(cause));
      } finally {
        if (generation.current === id) {
          setLoading(false);
          setRescanning(false);
        }
      }
    },
    [client],
  );

  useEffect(() => {
    void load(false);
    // The backend emits after a rescan, a save and a delete; reloading both lists keeps them in step.
    return client.onChanged(() => {
      void load(false);
    });
  }, [client, load]);

  const reload = useCallback(() => load(false), [load]);
  const rescan = useCallback(() => load(true), [load]);
  return { catalog, profiles, loading, rescanning, error, reload, rescan };
}
