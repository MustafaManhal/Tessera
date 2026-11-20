// Mounted once in the Shell: follows `agent:session_changed` so every agent pane (and the sidebar later) sees the
// backend's status without polling, and holds the "Start agent in this task" picker. The launch flow is in launch.ts.
import { useStore } from "react-redux";
import { useEffect } from "react";
import { announce } from "../store/uiSlice";
import { useAppDispatch } from "../store/hooks";
import type { RootState } from "../store";
import { agentsClient } from "./service";
import { AgentPicker } from "./AgentPicker";
import { sessionUpserted } from "./sessionsSlice";

export function AgentsHost() {
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();
  useEffect(
    () =>
      agentsClient().onSessionChanged((session) => {
        const before = store.getState().agentSessions.sessions[session.id]?.status;
        dispatch(sessionUpserted(session));
        // Screen readers hear only the states that ask for the user (brief 31): needs_input and error.
        if (session.status !== before && (session.status === "needs_input" || session.status === "error")) {
          dispatch(
            announce(
              session.status === "needs_input"
                ? session.status_message
                  ? `Agent needs you: ${session.status_message}`
                  : "An agent needs you."
                : "An agent reported an error.",
            ),
          );
        }
      }),
    [dispatch, store],
  );
  return <AgentPicker />;
}
