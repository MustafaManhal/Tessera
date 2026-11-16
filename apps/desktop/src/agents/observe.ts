// Forwards what an agent pane sees to the backend status engine (`agent_observe`, brief 31):
// - OSC 9/99/777 notifications and OSC 9;4 progress come through useOscFeatures' `onObservation`.
// - The last 20 visible lines go out 250 ms after output goes quiet (throttled by that debounce).
// - Five seconds without output sends a silence observation (the engine decides if that means idle).
// Only panes bound to an agent session observe; the hook is a no-op for shell panes.
import type { TerminalEngine } from "@tessera/term";
import { type RefObject, useEffect, useRef } from "react";
import { agentsClient } from "./service";
import type { AgentObservation } from "./types";

const SCREEN_QUIET_MS = 250;
const SILENCE_MS = 5_000;
const SCREEN_LINES = 20;

export interface ObserverDeps {
  engine(): TerminalEngine | null;
  sessionId(): string | null;
  send(sessionId: string, observation: AgentObservation): void;
  screenQuietMs?: number;
  silenceMs?: number;
  screenLines?: number;
}

/** The timer/screen logic, free of React so unit tests can drive it with fake timers. */
export function createAgentObserver(deps: ObserverDeps) {
  const screenQuietMs = deps.screenQuietMs ?? SCREEN_QUIET_MS;
  const silenceMs = deps.silenceMs ?? SILENCE_MS;
  const screenLines = deps.screenLines ?? SCREEN_LINES;
  let screenTimer: ReturnType<typeof setTimeout> | null = null;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let silenceSent = false;
  const send = (observation: AgentObservation) => {
    const id = deps.sessionId();
    if (id) deps.send(id, observation);
  };
  return {
    output() {
      if (!deps.sessionId()) return;
      silenceSent = false;
      if (screenTimer) clearTimeout(screenTimer);
      screenTimer = setTimeout(() => {
        screenTimer = null;
        const engine = deps.engine();
        if (!engine || !deps.sessionId()) return;
        const lines: string[] = [];
        const first = Math.max(0, engine.viewportLine);
        for (let i = first; i < first + screenLines && i < engine.bufferLength; i++) {
          lines.push(engine.line(i)?.text ?? "");
        }
        send({ kind: "screen", lines });
      }, screenQuietMs);
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        silenceTimer = null;
        if (silenceSent || !deps.sessionId()) return;
        silenceSent = true;
        send({ kind: "silence", seconds: silenceMs / 1000 });
      }, silenceMs);
    },
    observe(observation: AgentObservation) {
      send(observation);
    },
    dispose() {
      if (screenTimer) clearTimeout(screenTimer);
      if (silenceTimer) clearTimeout(silenceTimer);
      screenTimer = silenceTimer = null;
    },
  };
}
export type AgentObserver = ReturnType<typeof createAgentObserver>;

/**
 * Returns a stable observer for the pane's current agent session. `sessionId` and `engine` are refs so a restart
 * (new session id) or remount takes effect without re-subscribing.
 */
export function useAgentObserver(engine: TerminalEngine | null, sessionId: RefObject<string | null>): AgentObserver {
  const observer = useRef<AgentObserver | null>(null);
  const engineRef = useRef(engine);
  engineRef.current = engine;
  if (!observer.current) {
    observer.current = createAgentObserver({
      engine: () => engineRef.current,
      sessionId: () => sessionId.current,
      send: (id, observation) => {
        void agentsClient()
          .agentObserve(id, observation)
          .catch(() => {});
      },
    });
  }
  useEffect(() => () => observer.current?.dispose(), []);
  return observer.current;
}
