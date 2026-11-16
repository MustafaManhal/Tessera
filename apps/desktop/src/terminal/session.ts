// The life of a pane's session as a small state machine (pure, unit-tested):
//   starting ──started──▶ running ──exited(code)──▶ exited ──restart──▶ starting
//       └──failed(msg)──▶ failed ──restart──▶ starting
// The exited and failed states show the overlay ("Process exited with code N" / the spawn error) with Restart; Enter
// restarts too. Events for an older session (after a restart) are ignored by comparing the generation.

export type SessionState =
  | { status: "starting"; generation: number }
  | { status: "running"; generation: number; sessionId: string }
  | { status: "exited"; generation: number; code: number }
  | { status: "failed"; generation: number; message: string };

export type SessionEvent =
  | { type: "started"; generation: number; sessionId: string }
  | { type: "exited"; generation: number; code: number }
  | { type: "failed"; generation: number; message: string }
  | { type: "restart" }
  | { type: "relaunch" };

export const initialSession: SessionState = { status: "starting", generation: 1 };

export function sessionReducer(state: SessionState, event: SessionEvent): SessionState {
  if (event.type === "relaunch") return { status: "starting", generation: state.generation + 1 };
  if (event.type === "restart") {
    return state.status === "exited" || state.status === "failed"
      ? { status: "starting", generation: state.generation + 1 }
      : state;
  }
  if (event.generation !== state.generation) return state;
  switch (event.type) {
    case "started":
      return state.status === "starting"
        ? { status: "running", generation: state.generation, sessionId: event.sessionId }
        : state;
    case "exited":
      return state.status === "running" || state.status === "starting"
        ? { status: "exited", generation: state.generation, code: event.code }
        : state;
    case "failed":
      return state.status === "starting"
        ? { status: "failed", generation: state.generation, message: event.message }
        : state;
  }
}

/** The session id to send input and acks to, or null when there is no live session. */
export function liveSession(state: SessionState): string | null {
  return state.status === "running" ? state.sessionId : null;
}
