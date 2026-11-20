// What the sidebar's menus, the palette and the shortcuts do to a task, in one place. Results show as a toast (with
// Undo for archive) and in the live region; failures say why.
import { t } from "@tessera/ui";
import { notifications } from "../notify";
import { mapProjectsError } from "../projects/errors";
import type { AppThunk } from "../store";
import { announce, setProjectDialog } from "../store/uiSlice";
import { archiveTask, deleteTask, renameTask, restoreTask } from "../projects/thunks";
import { closeTaskTab, retitleTaskTab } from "./taskTabs";
import { openFolderInEditor, revealPath } from "../terminal/open";
import { toggleCollapsed, updateProjectMute } from "./projectActions";

const say =
  (text: string): AppThunk =>
  (dispatch) => {
    dispatch(announce(text));
  };

const fail =
  (cause: unknown): AppThunk =>
  (dispatch) => {
    const message = mapProjectsError(cause).message;
    dispatch(announce(t("task.actionFailed", { message })));
    notifications().toastNow({ kind: "error", title: t("task.actionFailed", { message }) });
  };

export const archiveTaskAction =
  (taskId: string): AppThunk<Promise<void>> =>
  async (dispatch, getState) => {
    const name = getState().projects.tasks[taskId]?.name ?? "";
    try {
      await dispatch(archiveTask(taskId));
      dispatch(say(t("task.archivedDone", { name })));
      notifications().toastNow({
        title: t("task.archivedDone", { name }),
        onUndo: () => void dispatch(restoreTaskAction(taskId)),
      });
    } catch (cause) {
      dispatch(fail(cause));
    }
  };

export const restoreTaskAction =
  (taskId: string): AppThunk<Promise<void>> =>
  async (dispatch, getState) => {
    const name = getState().projects.tasks[taskId]?.name ?? "";
    try {
      await dispatch(restoreTask(taskId));
      dispatch(say(t("task.restoredDone", { name })));
    } catch (cause) {
      dispatch(fail(cause));
    }
  };

export const renameTaskAction =
  (taskId: string, name: string): AppThunk<Promise<void>> =>
  async (dispatch, getState) => {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed === getState().projects.tasks[taskId]?.name) return;
    try {
      await dispatch(renameTask(taskId, trimmed));
      dispatch(retitleTaskTab(taskId, trimmed));
    } catch (cause) {
      dispatch(fail(cause));
    }
  };

export const copyBranchAction =
  (taskId: string): AppThunk<Promise<void>> =>
  async (dispatch, getState) => {
    const branch = getState().projects.tasks[taskId]?.branch;
    if (!branch) return;
    try {
      await navigator.clipboard.writeText(branch);
      dispatch(say(t("task.branchCopied", { branch })));
      notifications().toastNow({ title: t("task.branchCopied", { branch }) });
    } catch {
      // The clipboard refused (no permission): nothing to tell beyond the missing toast.
    }
  };

export const revealWorktreeAction =
  (taskId: string): AppThunk<Promise<void>> =>
  async (_dispatch, getState) => {
    const state = getState();
    const task = state.projects.tasks[taskId];
    if (!task) return;
    const path = task.worktree_path ?? state.projects.projects[task.project_id]?.path;
    if (path && !(await revealPath(path)) && !import.meta.env.DEV) {
      notifications().toastNow({ kind: "error", title: t("task.revealFailed") });
    }
  };

export const requestDeleteTask =
  (taskId: string): AppThunk =>
  (dispatch) => {
    dispatch(setProjectDialog({ kind: "deleteTask", taskId }));
  };

/** The delete dialog's two steps: the first confirmation, then (when asked) the one that accepts losing commits. */
export const performDeleteTask =
  (taskId: string, confirmLostCommits: boolean): AppThunk<Promise<void>> =>
  async (dispatch, getState) => {
    const name = getState().projects.tasks[taskId]?.name ?? "";
    await dispatch(deleteTask(taskId, confirmLostCommits));
    dispatch(closeTaskTab(taskId));
    dispatch(say(t("task.deletedDone", { name })));
    notifications().toastNow({ title: t("task.deletedDone", { name }) });
  };

export { toggleCollapsed, updateProjectMute };

/** Opens the task's worktree in the editor from `editor.command` (VS Code, Cursor, Zed, JetBrains or custom). */
export const openTaskInEditorAction =
  (taskId: string): AppThunk<Promise<void>> =>
  async (_dispatch, getState) => {
    const state = getState();
    const task = state.projects.tasks[taskId];
    const path = task ? (task.worktree_path ?? state.projects.projects[task.project_id]?.path) : undefined;
    if (path && !(await openFolderInEditor(path)) && !import.meta.env.DEV) {
      notifications().toastNow({ kind: "error", title: t("link.editorLater") });
    }
  };
