// "Jump to the next agent that needs you" (brief 32): cycles the panes holding agent attention, oldest first.
// The pointer survives across jumps so repeated presses walk the list; an emptied list resets it.
import { openTaskTab } from "../sidebar/taskTabs";
import type { AppDispatch, RootState } from "../store";
import { layout } from "../store/layoutSlice";
import { requestPaneFocus } from "../store/uiSlice";

let cursor = -1;

/** Jumps to the next pane needing agent attention; returns false when there is none. */
export function jumpToNextAttention(state: RootState, dispatch: AppDispatch): boolean {
  const marks = Object.values(state.attention.agentAttention).sort((a, b) => a.at - b.at);
  if (marks.length === 0) {
    cursor = -1;
    return false;
  }
  cursor = (cursor + 1) % marks.length;
  const mark = marks[cursor];
  if (!mark) return false;
  const pane = state.layout.panes[mark.paneId];
  if (!pane) return false;
  // Open the task tab when the pane lives in one, then focus the pane itself.
  if (mark.taskId) void dispatch(openTaskTab(mark.taskId));
  dispatch(layout({ type: "pane/focus", paneId: mark.paneId }));
  dispatch(requestPaneFocus());
  return true;
}

/** Test hook: the cycle position. */
export function attentionCursor(): number {
  return cursor;
}
