// Project and task operations: each calls the ProjectsClient and updates the store; failures reject with a
// ProjectsError so dialogs can show them inline. Rename, mute and sort are optimistic (rolled back on failure);
// create and delete are not.
import type { AppThunk } from "../store";
import {
  loadFailed,
  loaded,
  loading,
  projectRemoved,
  projectsReordered,
  projectUpserted,
  scriptsSet,
  taskUpserted,
} from "../store/projectsSlice";
import { mapProjectsError } from "./errors";
import { projectsClient } from "./service";
import type {
  Project,
  ProjectInput,
  ProjectPatch,
  RemoteProjectInput,
  RunScript,
  RunScriptInput,
  Task,
  TaskCreateInput,
  TaskCreateResult,
  TaskSummary,
} from "./types";

/** A `Task` from a command result as a summary row (git facts unknown until the next `task:changed`). */
export function toSummary(task: Task, previous?: TaskSummary): TaskSummary {
  return {
    ahead: previous?.ahead ?? null,
    behind: previous?.behind ?? null,
    changed_files: previous?.changed_files ?? null,
    ports: previous?.ports ?? [],
    ...task,
  };
}

export const loadProjects = (): AppThunk<Promise<void>> => async (dispatch) => {
  dispatch(loading());
  try {
    const client = projectsClient();
    const [projects, tasks] = await Promise.all([client.projectList(), client.taskList({ include_archived: true })]);
    dispatch(loaded({ projects, tasks }));
  } catch (cause) {
    dispatch(loadFailed(mapProjectsError(cause).message));
  }
};

export const addProject =
  (input: ProjectInput): AppThunk<Promise<Project>> =>
  async (dispatch) => {
    try {
      const project = await projectsClient().projectAdd(input);
      dispatch(projectUpserted(project));
      return project;
    } catch (cause) {
      throw mapProjectsError(cause);
    }
  };

/** Adds a repository on an SSH host (M10.2). */
export const addRemoteProject =
  (input: RemoteProjectInput): AppThunk<Promise<Project>> =>
  async (dispatch) => {
    try {
      const project = await projectsClient().projectAddRemote(input);
      dispatch(projectUpserted(project));
      return project;
    } catch (cause) {
      throw mapProjectsError(cause);
    }
  };

/** `git init` in a folder the backend refused with `canInit`, then add it. */
export const initAndAddProject =
  (path: string, name?: string): AppThunk<Promise<Project>> =>
  async (dispatch) => {
    try {
      await projectsClient().projectGitInit(path);
    } catch (cause) {
      throw mapProjectsError(cause);
    }
    return dispatch(addProject({ path, name }));
  };

const OPTIMISTIC: (keyof ProjectPatch)[] = ["name", "is_muted", "sort"];

export const updateProject =
  (id: string, patch: ProjectPatch): AppThunk<Promise<Project>> =>
  async (dispatch, getState) => {
    const before = getState().projects.projects[id];
    const optimistic = before && Object.keys(patch).every((key) => OPTIMISTIC.includes(key as keyof ProjectPatch));
    if (before && optimistic) dispatch(projectUpserted({ ...before, ...patch } as Project));
    try {
      const project = await projectsClient().projectUpdate(id, patch);
      dispatch(projectUpserted(project));
      return project;
    } catch (cause) {
      if (before && optimistic) dispatch(projectUpserted(before));
      throw mapProjectsError(cause);
    }
  };

export const removeProject =
  (id: string): AppThunk<Promise<{ tasks_with_worktrees: number }>> =>
  async (dispatch) => {
    try {
      const result = await projectsClient().projectRemove(id);
      dispatch(projectRemoved(id));
      return result;
    } catch (cause) {
      throw mapProjectsError(cause);
    }
  };

/** Drag to reorder: the new order shows at once and is saved as `sort`; on failure the old order returns. */
export const reorderProjects =
  (ids: string[]): AppThunk<Promise<void>> =>
  async (dispatch, getState) => {
    const before = getState().projects.order;
    dispatch(projectsReordered(ids));
    try {
      const client = projectsClient();
      const order = getState().projects.order;
      await Promise.all(order.map((id, index) => client.projectUpdate(id, { sort: index })));
    } catch (cause) {
      dispatch(projectsReordered(before));
      throw mapProjectsError(cause);
    }
  };

export const approveSetup =
  (id: string): AppThunk<Promise<Project>> =>
  async (dispatch) => {
    try {
      const project = await projectsClient().projectApproveSetup(id);
      dispatch(projectUpserted(project));
      return project;
    } catch (cause) {
      throw mapProjectsError(cause);
    }
  };

export const loadRunScripts =
  (projectId: string): AppThunk<Promise<RunScript[]>> =>
  async (dispatch) => {
    try {
      const scripts = await projectsClient().runScriptList(projectId);
      dispatch(scriptsSet({ projectId, scripts }));
      return scripts;
    } catch (cause) {
      throw mapProjectsError(cause);
    }
  };

export const addRunScript =
  (projectId: string, input: RunScriptInput): AppThunk<Promise<void>> =>
  async (dispatch) => {
    try {
      await projectsClient().runScriptAdd(projectId, input);
    } catch (cause) {
      throw mapProjectsError(cause);
    }
    await dispatch(loadRunScripts(projectId));
  };

export const updateRunScript =
  (projectId: string, id: string, patch: Partial<RunScriptInput>): AppThunk<Promise<void>> =>
  async (dispatch) => {
    try {
      await projectsClient().runScriptUpdate(id, patch);
    } catch (cause) {
      throw mapProjectsError(cause);
    }
    await dispatch(loadRunScripts(projectId));
  };

export const removeRunScript =
  (projectId: string, id: string): AppThunk<Promise<void>> =>
  async (dispatch) => {
    try {
      await projectsClient().runScriptRemove(id);
    } catch (cause) {
      throw mapProjectsError(cause);
    }
    await dispatch(loadRunScripts(projectId));
  };

export const createTask =
  (input: TaskCreateInput): AppThunk<Promise<TaskCreateResult>> =>
  async (dispatch) => {
    try {
      const result = await projectsClient().taskCreate(input);
      for (const task of result.tasks) dispatch(taskUpserted(toSummary(task)));
      return result;
    } catch (cause) {
      throw mapProjectsError(cause);
    }
  };

export const renameTask =
  (id: string, name: string): AppThunk<Promise<void>> =>
  async (dispatch, getState) => {
    const before = getState().projects.tasks[id];
    if (before) dispatch(taskUpserted({ ...before, name }));
    try {
      const task = await projectsClient().taskRename(id, name);
      dispatch(taskUpserted(toSummary(task, before)));
    } catch (cause) {
      if (before) dispatch(taskUpserted(before));
      throw mapProjectsError(cause);
    }
  };

const stateChange =
  (method: "taskArchive" | "taskRestore") =>
  (id: string): AppThunk<Promise<void>> =>
  async (dispatch, getState) => {
    try {
      const task = await projectsClient()[method](id);
      dispatch(taskUpserted(toSummary(task, getState().projects.tasks[id])));
    } catch (cause) {
      throw mapProjectsError(cause);
    }
  };

export const archiveTask = stateChange("taskArchive");
export const restoreTask = stateChange("taskRestore");

/** Rejects with UnmergedCommits{list} until `confirmLostCommits` is true. */
export const deleteTask =
  (id: string, confirmLostCommits: boolean): AppThunk<Promise<void>> =>
  async (dispatch) => {
    try {
      await projectsClient().taskDelete(id, confirmLostCommits);
    } catch (cause) {
      throw mapProjectsError(cause);
    }
    dispatch({ type: "projects/taskRemoved", payload: id });
  };
