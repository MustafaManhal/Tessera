// Closing things: a tab, a pane or the other tabs. A close that would stop a running process asks first (F-03 step
// 7) unless the setting turns that off; the confirmation stores plain data and `performClose` does the close.
import { activeTabOf, findPane, paneIds, runningProcesses, tabOfPane, type PaneId, type TabId } from "../layout";
import type { AppThunk } from ".";
import { type FocusTarget, layout } from "./layoutSlice";
import { type PendingClose, requestConfirm } from "./uiSlice";

export const performClose =
  (close: PendingClose, focus?: FocusTarget): AppThunk =>
  (dispatch) => {
    if (close.kind === "tab") dispatch(layout({ type: "tab/close", tabId: close.tabId }, focus));
    else if (close.kind === "pane") dispatch(layout({ type: "pane/close", paneId: close.paneId }, focus));
    else dispatch(layout({ type: "tab/closeOthers", tabId: close.tabId }, focus));
  };

const confirmOrClose =
  (
    close: PendingClose,
    title: "confirm.closeTab.title" | "confirm.closePane.title" | "confirm.closeOthers.title",
    processes: string[],
    focus?: FocusTarget,
  ): AppThunk =>
  (dispatch, getState) => {
    if (processes.length > 0 && getState().settings.confirmCloseRunning) {
      dispatch(requestConfirm({ close, title, processes }));
    } else {
      dispatch(performClose(close, focus));
    }
  };

/** Closes a tab (default: the selected one). */
export const closeTab =
  (tabId?: TabId, focus?: FocusTarget): AppThunk =>
  (dispatch, getState) => {
    const state = getState().layout;
    const tab = tabId ? state.tabs.find((t) => t.id === tabId) : activeTabOf(state);
    if (!tab) return;
    dispatch(
      confirmOrClose({ kind: "tab", tabId: tab.id }, "confirm.closeTab.title", runningProcesses(state, tab), focus),
    );
  };

/** Closes a pane (default: the focused one); the last pane closes its tab. */
export const closePane =
  (paneId?: PaneId): AppThunk =>
  (dispatch, getState) => {
    const state = getState().layout;
    const tab = paneId ? tabOfPane(state, paneId) : activeTabOf(state);
    if (!tab) return;
    const target = paneId ?? tab.focusedPane;
    if (!findPane(tab.root, target)) return;
    const process = state.panes[target]?.runningProcess;
    const title = paneIds(tab.root).length === 1 ? "confirm.closeTab.title" : "confirm.closePane.title";
    dispatch(confirmOrClose({ kind: "pane", paneId: target }, title, process ? [process] : []));
  };

/** Closes every tab except this one (default: the selected one) and the pinned ones. */
export const closeOtherTabs =
  (tabId?: TabId): AppThunk =>
  (dispatch, getState) => {
    const state = getState().layout;
    const keep = tabId ? state.tabs.find((t) => t.id === tabId) : activeTabOf(state);
    if (!keep) return;
    const processes = state.tabs
      .filter((tab) => tab.id !== keep.id && !tab.pinned)
      .flatMap((tab) => runningProcesses(state, tab));
    dispatch(confirmOrClose({ kind: "others", tabId: keep.id }, "confirm.closeOthers.title", processes));
  };
