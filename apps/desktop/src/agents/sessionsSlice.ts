// Launched agents in the layout: the launch plan that gives a pane its program, and the sessions the backend reports
// (status, pane binding, exit). The session rows come from `agent:session_changed` and the attach/exit calls; the plan
// is replaced when an agent restarts. Runtime only: neither is saved with the layout.
import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { AgentLaunch, AgentSession } from "./types";

export interface AgentSessionsState {
  /** Launch plans by pane id (a pane runs one agent at a time). */
  launches: Record<string, AgentLaunch>;
  /** Sessions by agent session id, whichever pane they are bound to. */
  sessions: Record<string, AgentSession>;
  /** The "Start agent in this task" picker is open. */
  pickerOpen: boolean;
  resumeErrors?: Record<string, string>;
}

const initialState: AgentSessionsState = { launches: {}, sessions: {}, pickerOpen: false };

export const agentSessionsSlice = createSlice({
  name: "agentSessions",
  initialState,
  reducers: {
    resumeErrorSet: (state, action: PayloadAction<{ paneId: string; message: string }>) => {
      state.resumeErrors ??= {};
      state.resumeErrors[action.payload.paneId] = action.payload.message;
    },
    launchSet: (state, action: PayloadAction<{ paneId: string; launch: AgentLaunch }>) => {
      state.launches[action.payload.paneId] = action.payload.launch;
    },
    launchReplaced: (state, action: PayloadAction<{ paneId: string; launch: AgentLaunch }>) => {
      state.launches[action.payload.paneId] = action.payload.launch;
    },
    paneCleared: (state, action: PayloadAction<string>) => {
      delete state.launches[action.payload];
    },
    sessionUpserted: (state, action: PayloadAction<AgentSession>) => {
      state.sessions[action.payload.id] = action.payload;
    },
    setAgentPicker: (state, action: PayloadAction<boolean>) => {
      state.pickerOpen = action.payload;
    },
  },
});

export const { resumeErrorSet, launchSet, launchReplaced, paneCleared, sessionUpserted, setAgentPicker } =
  agentSessionsSlice.actions;

export function selectLaunch(state: { agentSessions: AgentSessionsState }, paneId: string): AgentLaunch | undefined {
  return state.agentSessions.launches[paneId];
}

export function selectSession(state: { agentSessions: AgentSessionsState }, paneId: string): AgentSession | undefined {
  const launch = state.agentSessions.launches[paneId];
  return launch ? state.agentSessions.sessions[launch.agent_session_id] : undefined;
}
