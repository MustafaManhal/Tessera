// What the sidebar does to a project: collapse, mute, add a task, open its settings, remove it.
import { t } from "@tessera/ui";
import { notifications } from "../notify";
import { mapProjectsError } from "../projects/errors";
import { removeProject, updateProject } from "../projects/thunks";
import type { AppThunk } from "../store";
import { toggleCollapsed as toggle } from "../store/projectsSlice";
import { announce, setProjectDialog } from "../store/uiSlice";

export const toggleCollapsed = toggle;

export const updateProjectMute =
  (projectId: string): AppThunk<Promise<void>> =>
  async (dispatch, getState) => {
    const project = getState().projects.projects[projectId];
    if (!project) return;
    try {
      await dispatch(updateProject(projectId, { is_muted: !project.is_muted }));
    } catch (cause) {
      notifications().toastNow({
        kind: "error",
        title: t("task.actionFailed", { message: mapProjectsError(cause).message }),
      });
    }
  };

export const requestNewTask =
  (projectId: string | null): AppThunk =>
  (dispatch) => {
    dispatch(setProjectDialog({ kind: "newTask", projectId }));
  };

export const requestProjectSettings =
  (projectId: string): AppThunk =>
  (dispatch) => {
    dispatch(setProjectDialog({ kind: "projectSettings", projectId }));
  };

export const requestRemoveProject =
  (projectId: string): AppThunk =>
  (dispatch) => {
    dispatch(setProjectDialog({ kind: "removeProject", projectId }));
  };

export const performRemoveProject =
  (projectId: string): AppThunk<Promise<number>> =>
  async (dispatch, getState) => {
    const name = getState().projects.projects[projectId]?.name ?? "";
    const { tasks_with_worktrees } = await dispatch(removeProject(projectId));
    dispatch(announce(t("project.removed", { name })));
    notifications().toastNow({ title: t("project.removed", { name }) });
    return tasks_with_worktrees;
  };
