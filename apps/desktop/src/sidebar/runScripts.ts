// Run scripts (FR-30): a project's named commands (dev server, tests) that open in a named pane of the task's tab.
import { t } from "@tessera/ui";
import { activeTabOf, paneIds } from "../layout";
import { notifications } from "../notify";
import type { RunScript } from "../projects/types";
import type { AppThunk } from "../store";
import { layout } from "../store/layoutSlice";
import { announce } from "../store/uiSlice";
import { paneTerminal } from "../terminal/panes";
import { findTaskTab, openTaskTab } from "./taskTabs";

/** Waits for a new pane's shell to accept input (its session starts after the pane mounts). */
async function writeWhenReady(paneId: string, bytes: Uint8Array): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (paneTerminal(paneId)?.writeInput(bytes)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/**
 * Runs a project's run script in a named pane of the task's tab (FR-30). The tab opens if needed; a pane already
 * named after the script gets the focus instead of a second copy. The command is typed into the pane's shell, so it
 * runs in the worktree and its output stays visible when it ends.
 */
export const runScriptAction =
  (taskId: string, script: RunScript): AppThunk<Promise<void>> =>
  async (dispatch, getState) => {
    try {
      dispatch(openTaskTab(taskId));
      const tab = findTaskTab(getState(), taskId) ?? activeTabOf(getState().layout);
      if (!tab) return;
      const existing = paneIds(tab.root).find((id) => getState().layout.panes[id]?.name === script.name);
      if (existing) {
        dispatch(layout({ type: "tab/select", tabId: tab.id }, "pane"));
        dispatch(layout({ type: "pane/focus", paneId: existing }, "pane"));
        dispatch(announce(t("task.scriptRunning", { name: script.name })));
        return;
      }
      dispatch(layout({ type: "tab/select", tabId: tab.id }, "pane"));
      dispatch(layout({ type: "pane/split", direction: "down" }));
      const created = activeTabOf(getState().layout)?.focusedPane;
      if (!created) return;
      dispatch(layout({ type: "pane/setName", paneId: created, name: script.name }, "none"));
      const typed = await writeWhenReady(created, new TextEncoder().encode(`${script.command}\r`));
      if (!typed) throw new Error("the terminal did not start in time");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      notifications().toastNow({ kind: "error", title: t("task.runScriptFailed", { name: script.name, message }) });
    }
  };

/** Starts every run script of the task's project marked "auto start", once, when its tab first opens. */
export const autoStartScripts =
  (taskId: string): AppThunk<Promise<void>> =>
  async (dispatch, getState) => {
    const state = getState();
    const task = state.projects.tasks[taskId];
    if (!task) return;
    for (const script of (state.projects.scripts[task.project_id] ?? []).filter((s) => s.auto_start)) {
      await dispatch(runScriptAction(taskId, script));
    }
  };
