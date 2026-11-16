// What panes ask the user to look at, outside the layout JSON: progress reported with OSC 9;4 (shown on the tab and,
// through the ProgressSink, on the dock or taskbar) and badges ("a long command finished", "a notification came")
// that stay on the tab until the pane is focused again.
import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { ProgressState } from "@tessera/term";
import type { PaneId } from "../layout";

export interface PaneProgress {
  state: ProgressState;
  /** 0–100; null for indeterminate. */
  value: number | null;
}

export type BadgeKind = "finished" | "failed" | "notification";

/** An agent session that needs the user (brief 32): ring on the pane, dot on the tab, count in the status bar. */
export interface AgentAttention {
  agentSessionId: string;
  /** "needs_input" asks for input; "done" means the agent went idle after working. */
  kind: "needs_input" | "done";
  /** The status message behind the signal (hook text, OSC body, matched line). */
  text: string;
  paneId: PaneId;
  taskId: string | null;
  at: number;
}

export interface PaneBadge {
  kind: BadgeKind;
  /** What the badge says (the notification text, or "npm test finished in 1m 12s"). */
  text: string;
}

export interface AttentionState {
  progress: Record<PaneId, PaneProgress>;
  badges: Record<PaneId, PaneBadge>;
  agentAttention: Record<PaneId, AgentAttention>;
}

const initialState: AttentionState = { progress: {}, badges: {}, agentAttention: {} };

export const attentionSlice = createSlice({
  name: "attention",
  initialState,
  reducers: {
    /** `value: null` on error or paused keeps the last value (ConEmu rule). */
    setProgress: (state, action: PayloadAction<{ paneId: PaneId; progress: PaneProgress | null }>) => {
      const { paneId, progress } = action.payload;
      if (!progress) {
        delete state.progress[paneId];
        return;
      }
      const previous = state.progress[paneId];
      const value =
        progress.state === "indeterminate"
          ? null
          : (progress.value ?? (previous?.value !== undefined ? previous.value : 0));
      state.progress[paneId] = { state: progress.state, value };
    },
    setBadge: (state, action: PayloadAction<{ paneId: PaneId; badge: PaneBadge }>) => {
      const current = state.badges[action.payload.paneId];
      // A failure stays visible over a later plain notification.
      if (current?.kind === "failed" && action.payload.badge.kind === "notification") return;
      state.badges[action.payload.paneId] = action.payload.badge;
    },
    clearBadge: (state, action: PayloadAction<PaneId>) => {
      delete state.badges[action.payload];
    },
    setAgentAttention: (state, action: PayloadAction<AgentAttention>) => {
      state.agentAttention[action.payload.paneId] = action.payload;
    },
    /** Clears the mark when it belongs to this session (a stale one for another session stays). */
    clearAgentAttention: (state, action: PayloadAction<{ paneId: PaneId; agentSessionId?: string }>) => {
      const current = state.agentAttention[action.payload.paneId];
      if (current && (!action.payload.agentSessionId || current.agentSessionId === action.payload.agentSessionId)) {
        delete state.agentAttention[action.payload.paneId];
      }
    },
    /** A pane closed: forget its progress, badge and agent attention. */
    forgetPane: (state, action: PayloadAction<PaneId>) => {
      delete state.progress[action.payload];
      delete state.badges[action.payload];
      delete state.agentAttention[action.payload];
    },
  },
});

export const { setProgress, setBadge, clearBadge, setAgentAttention, clearAgentAttention, forgetPane } =
  attentionSlice.actions;

const PRIORITY: Record<ProgressState, number> = { error: 3, paused: 2, normal: 1, indeterminate: 0 };

/** The one progress to show for several panes (a tab, or the whole window): errors first, then paused, then the rest. */
export function combineProgress(list: readonly PaneProgress[]): PaneProgress | null {
  let best: PaneProgress | null = null;
  for (const item of list) {
    if (!best || PRIORITY[item.state] > PRIORITY[best.state]) best = item;
    else if (item.state === best.state && item.value !== null && best.value !== null) {
      // Same state: show the slowest, so the bar never runs ahead of the work.
      if (item.value < best.value) best = item;
    }
  }
  return best;
}
