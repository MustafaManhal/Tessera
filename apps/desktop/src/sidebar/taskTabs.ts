// Task tabs: a tab whose panes carry the task's id (`PaneInfo.taskId`) and run in its worktree. Clicking a task in the
// sidebar opens its tab or focuses the one that exists. A task with a setup script that needs approval also gets a
// "setup" pane under its shell (SetupPane).
import { activeTabOf, findPane, paneIds, type Tab } from "../layout";
import type { SetupInfo, TaskSummary } from "../projects/types";
import type { AppThunk, RootState } from "../store";
import { layout } from "../store/layoutSlice";
import { setupStarted } from "../store/projectsSlice";
import { performClose } from "../store/thunks";

/** The tab holding a task's panes, if one is open. */
export function findTaskTab(state: RootState, taskId: string): Tab | undefined {
  return state.layout.tabs.find((tab) => paneIds(tab.root).some((id) => state.layout.panes[id]?.taskId === taskId));
}

/** The task of the focused pane of the active tab. */
export function currentTaskId(state: RootState): string | null {
  const tab = activeTabOf(state.layout);
  return (tab && state.layout.panes[tab.focusedPane]?.taskId) || null;
}

function startFolder(state: RootState, task: TaskSummary): string {
  const project = state.projects.projects[task.project_id];
  return task.worktree_path ?? project?.path ?? "";
}

/** Opens the task's tab, or selects it when it is already open. Focus moves into its pane. */
export const openTaskTab =
  (taskId: string, setup?: SetupInfo): AppThunk =>
  (dispatch, getState) => {
    const state = getState();
    const task = state.projects.tasks[taskId];
    if (!task) return;
    const existing = findTaskTab(state, taskId);
    if (existing) {
      dispatch(layout({ type: "tab/select", tabId: existing.id }, "pane"));
      return;
    }
    dispatch(layout({ type: "tab/new", cwd: startFolder(state, task), taskId, title: task.name }));
    // Scripts marked "auto start" run in their own panes once; loaded lazily because run scripts import this file.
    void import("./runScripts").then((module) => dispatch(module.autoStartScripts(taskId)));
    if (setup && setup.state === "needs_approval") {
      dispatch(setupStarted({ taskId, info: setup }));
      // The setup pane sits under the shell; the shell keeps the focus.
      dispatch(layout({ type: "pane/split", direction: "down", kind: "setup" }));
      const tab = activeTabOf(getState().layout);
      const shell = tab && paneIds(tab.root).find((id) => findPane(tab.root, id)?.kind !== "setup");
      if (shell) dispatch(layout({ type: "pane/focus", paneId: shell }, "pane"));
    }
  };

/** Retitles the open tab of a task after a rename. */
export const retitleTaskTab =
  (taskId: string, name: string): AppThunk =>
  (dispatch, getState) => {
    const tab = findTaskTab(getState(), taskId);
    if (tab) dispatch(layout({ type: "tab/rename", tabId: tab.id, title: name }, "none"));
  };

/** Closes the tab of a task whose worktree is gone (deleted), without asking. */
export const closeTaskTab =
  (taskId: string): AppThunk =>
  (dispatch, getState) => {
    const tab = findTaskTab(getState(), taskId);
    if (tab) dispatch(performClose({ kind: "tab", tabId: tab.id }, "none"));
  };

/** Active tasks in sidebar order (for next/previous task). */
export function taskOrder(state: RootState): string[] {
  const out: string[] = [];
  for (const projectId of state.projects.order) {
    const own = Object.values(state.projects.tasks)
      .filter((task) => task.project_id === projectId && task.state !== "archived")
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0) || (a.id < b.id ? -1 : 1));
    for (const task of own) out.push(task.id);
  }
  return out;
}

export const openRelativeTask =
  (offset: 1 | -1): AppThunk =>
  (dispatch, getState) => {
    const state = getState();
    const order = taskOrder(state);
    if (order.length === 0) return;
    const current = currentTaskId(state);
    const index = current ? order.indexOf(current) : -1;
    const next = index < 0 ? (offset === 1 ? 0 : order.length - 1) : (index + offset + order.length) % order.length;
    const id = order[next];
    if (id) dispatch(openTaskTab(id));
  };
