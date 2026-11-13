// Projects, their tasks and run scripts as the sidebar and dialogs see them, plus the sidebar's own state (collapsed
// groups, the filter). Filled from the ProjectsClient (projects/thunks.ts) and kept current by `task:changed` events.
// Create and delete are never optimistic; rename, mute and sort are (with a rollback on failure, in the thunks).
import { createSelector, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { Project, RunScript, SetupInfo, TaskGroupInfo, TaskSummary } from "../projects/types";
import type { RootState } from ".";

export type ProjectsStatus = "idle" | "loading" | "ready" | "error";

/** Where a task's setup script is: waiting for approval, running, or finished. */
export type SetupPhase = "approve" | "running" | "done" | "failed" | "skipped";

export interface TaskSetup {
  info: SetupInfo;
  phase: SetupPhase;
  /** Exit code of the script when it failed. */
  exitCode: number | null;
}

export interface ProjectsState {
  /** Setup scripts of tasks created in this session (`task_create` reported the script and its hash). */
  setups: Record<string, TaskSetup>;
  status: ProjectsStatus;
  error: string | null;
  projects: Record<string, Project>;
  /** Project ids in sidebar order. */
  order: string[];
  tasks: Record<string, TaskSummary>;
  /** Best-of-N groups (FR-36). */
  groups: Record<string, TaskGroupInfo>;
  scripts: Record<string, RunScript[]>;
  /** Collapsed project groups, and the collapsed "Archived" sections (key `archived:<project id>`). */
  collapsed: Record<string, boolean>;
  filter: string;
  /** Which tasks the sidebar shows: all, the ones in use (an open tab or a live agent), the idle ones, or archived. */
  statusFilter: StatusFilter;
  sortMode: SortMode;
  /** The user's order of the tasks inside each project (task ids), set by dragging. */
  taskOrder: Record<string, string[]>;
}

export type StatusFilter = "all" | "active" | "inactive" | "archived";
/** `active`: projects and tasks in use come first, each part in the user's order. `manual`: the user's order only. */
export type SortMode = "active" | "manual";

const SORT_KEY = "tessera.sidebarSort";
const TASK_ORDER_KEY = "tessera.taskOrder";

function readSortMode(): SortMode {
  try {
    return localStorage.getItem(SORT_KEY) === "manual" ? "manual" : "active";
  } catch {
    return "active";
  }
}

function readTaskOrder(): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TASK_ORDER_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string[]] => Array.isArray(entry[1])),
    );
  } catch {
    return {};
  }
}

/** Remembers the sort mode and each project's task order for the next start (a per-viewer convenience). */
export function persistSidebarOrder(sortMode: SortMode, taskOrder: Record<string, string[]>): void {
  try {
    localStorage.setItem(SORT_KEY, sortMode);
    localStorage.setItem(TASK_ORDER_KEY, JSON.stringify(taskOrder));
  } catch {
    // Private window or blocked storage: the order lasts until the app closes.
  }
}

const initialState: ProjectsState = {
  setups: {},
  status: "idle",
  error: null,
  projects: {},
  order: [],
  tasks: {},
  groups: {},
  scripts: {},
  // Archived sections start collapsed (S-02); a group is collapsed only when the user collapses it.
  collapsed: {},
  filter: "",
  statusFilter: "all",
  sortMode: readSortMode(),
  taskOrder: readTaskOrder(),
};

const bySort = (projects: Record<string, Project>) => (a: string, b: string) =>
  (projects[a]?.sort ?? 0) - (projects[b]?.sort ?? 0) || (a < b ? -1 : 1);

export const projectsSlice = createSlice({
  name: "projects",
  initialState,
  reducers: {
    loading: (state) => {
      state.status = "loading";
      state.error = null;
    },
    loadFailed: (state, action: PayloadAction<string>) => {
      state.status = "error";
      state.error = action.payload;
    },
    loaded: (state, action: PayloadAction<{ projects: Project[]; tasks: TaskSummary[] }>) => {
      state.status = "ready";
      state.error = null;
      state.projects = Object.fromEntries(action.payload.projects.map((project) => [project.id, project]));
      state.order = Object.keys(state.projects).sort(bySort(state.projects));
      state.tasks = Object.fromEntries(action.payload.tasks.map((task) => [task.id, task]));
    },
    projectUpserted: (state, action: PayloadAction<Project>) => {
      state.projects[action.payload.id] = action.payload;
      if (!state.order.includes(action.payload.id)) state.order.push(action.payload.id);
    },
    projectRemoved: (state, action: PayloadAction<string>) => {
      delete state.projects[action.payload];
      delete state.scripts[action.payload];
      state.order = state.order.filter((id) => id !== action.payload);
      for (const [id, task] of Object.entries(state.tasks))
        if (task.project_id === action.payload) delete state.tasks[id];
    },
    projectsReordered: (state, action: PayloadAction<string[]>) => {
      const known = action.payload.filter((id) => state.projects[id]);
      const rest = state.order.filter((id) => !known.includes(id));
      state.order = [...known, ...rest];
      state.order.forEach((id, index) => {
        const project = state.projects[id];
        if (project) project.sort = index;
      });
    },
    /** A task changed (event or command result); a deleted task leaves the list. */
    taskUpserted: (state, action: PayloadAction<TaskSummary>) => {
      if (action.payload.state === "deleted") delete state.tasks[action.payload.id];
      else state.tasks[action.payload.id] = action.payload;
    },
    groupUpserted: (state, action: PayloadAction<TaskGroupInfo>) => {
      state.groups[action.payload.id] = action.payload;
    },
    taskRemoved: (state, action: PayloadAction<string>) => {
      delete state.tasks[action.payload];
    },
    scriptsSet: (state, action: PayloadAction<{ projectId: string; scripts: RunScript[] }>) => {
      state.scripts[action.payload.projectId] = action.payload.scripts;
    },
    setupStarted: (state, action: PayloadAction<{ taskId: string; info: SetupInfo }>) => {
      state.setups[action.payload.taskId] = { info: action.payload.info, phase: "approve", exitCode: null };
    },
    setupPhase: (state, action: PayloadAction<{ taskId: string; phase: SetupPhase; exitCode?: number | null }>) => {
      const setup = state.setups[action.payload.taskId];
      if (!setup) return;
      setup.phase = action.payload.phase;
      setup.exitCode = action.payload.exitCode ?? null;
    },
    setFilter: (state, action: PayloadAction<string>) => {
      state.filter = action.payload;
    },
    setStatusFilter: (state, action: PayloadAction<StatusFilter>) => {
      state.statusFilter = action.payload;
    },
    setSortMode: (state, action: PayloadAction<SortMode>) => {
      state.sortMode = action.payload;
    },
    taskOrderSet: (state, action: PayloadAction<{ projectId: string; ids: string[] }>) => {
      state.taskOrder[action.payload.projectId] = action.payload.ids;
    },
    toggleCollapsed: (state, action: PayloadAction<{ key: string; collapsed?: boolean }>) => {
      const { key, collapsed } = action.payload;
      state.collapsed[key] = collapsed ?? !isCollapsed(state, key);
    },
  },
});

/** Archived sections are collapsed until opened; project groups are open until collapsed. */
export function isCollapsed(state: Pick<ProjectsState, "collapsed">, key: string): boolean {
  return state.collapsed[key] ?? key.startsWith("archived:");
}

export const {
  loading,
  loadFailed,
  loaded,
  projectUpserted,
  projectRemoved,
  projectsReordered,
  taskUpserted,
  groupUpserted,
  taskRemoved,
  scriptsSet,
  setupStarted,
  setupPhase,
  setFilter,
  setStatusFilter,
  setSortMode,
  taskOrderSet,
  toggleCollapsed,
} = projectsSlice.actions;

// Selectors ---------------------------------------------------------------------------------------------------------

const selectProjectMap = (state: RootState) => state.projects.projects;
const selectOrder = (state: RootState) => state.projects.order;
const selectTaskMap = (state: RootState) => state.projects.tasks;
export const selectProjectsFilter = (state: RootState) => state.projects.filter;
export const selectSortMode = (state: RootState) => state.projects.sortMode;
const selectTaskOrder = (state: RootState) => state.projects.taskOrder;
export const selectStatusFilter = (state: RootState) => state.projects.statusFilter;
/** Ids of the tasks in use right now: one with an open tab, or with an agent that has not ended. */
export const selectActiveTaskIds = createSelector(
  [(state: RootState) => state.layout.panes, (state: RootState) => state.agentSessions.sessions],
  (panes, sessions) => {
    const ids = new Set<string>();
    for (const pane of Object.values(panes)) if (pane.taskId) ids.add(pane.taskId);
    for (const session of Object.values(sessions)) {
      if (session.task_id && session.status !== "exited" && session.status !== "error") ids.add(session.task_id);
    }
    return ids;
  },
);
export const selectProjectsStatus = (state: RootState) => state.projects.status;

export const selectProjectList = createSelector([selectProjectMap, selectOrder], (projects, order) =>
  order.flatMap((id) => (projects[id] ? [projects[id]] : [])),
);

export interface ProjectGroup {
  project: Project;
  tasks: TaskSummary[];
  archived: TaskSummary[];
  /** A task of this project is open in a tab or has a live agent. */
  inUse: boolean;
}

/** Tasks in the user's dragged order (new ones first), and with the ones in use first when `activeIds` is given. */
function orderTasks(tasks: TaskSummary[], manual: string[] | undefined, activeIds: Set<string> | null): TaskSummary[] {
  const rank = (task: TaskSummary) => (manual ? manual.indexOf(task.id) : -1);
  const ordered = manual ? [...tasks].sort((a, b) => rank(a) - rank(b)) : tasks;
  return activeIds
    ? [...ordered.filter((task) => activeIds.has(task.id)), ...ordered.filter((task) => !activeIds.has(task.id))]
    : ordered;
}

const newestFirst = (a: TaskSummary, b: TaskSummary) =>
  (b.created_at ?? 0) - (a.created_at ?? 0) || (a.id < b.id ? -1 : 1);

function matches(task: TaskSummary, words: string[]): boolean {
  const hay = `${task.name} ${task.branch}`.toLowerCase();
  return words.every((word) => hay.includes(word));
}

/** The sidebar tree: projects in order, each with its tasks (newest first) and archived tasks, filtered by the box. */
export const selectGroups = createSelector(
  [
    selectProjectList,
    selectTaskMap,
    selectProjectsFilter,
    selectStatusFilter,
    selectActiveTaskIds,
    selectSortMode,
    selectTaskOrder,
  ],
  (projects, taskMap, filter, statusFilter, activeIds, sortMode, taskOrder): ProjectGroup[] => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const all = Object.values(taskMap);
    const rows = projects.flatMap((project) => {
      const own = orderTasks(
        all.filter((task) => task.project_id === project.id).sort(newestFirst),
        taskOrder[project.id],
        sortMode === "active" ? activeIds : null,
      );
      const projectHit = words.length > 0 && words.every((word) => project.name.toLowerCase().includes(word));
      const byName = words.length === 0 || projectHit ? own : own.filter((task) => matches(task, words));
      const visible = byName.filter((task) => {
        const archived = task.state === "archived";
        if (statusFilter === "archived") return archived;
        if (statusFilter === "active") return !archived && activeIds.has(task.id);
        if (statusFilter === "inactive") return !archived && !activeIds.has(task.id);
        return true;
      });
      if ((words.length > 0 && !projectHit && visible.length === 0) || (statusFilter !== "all" && visible.length === 0))
        return [];
      return [
        {
          project,
          tasks: visible.filter((task) => task.state !== "archived"),
          archived: visible.filter((task) => task.state === "archived"),
          inUse: own.some((task) => task.state !== "archived" && activeIds.has(task.id)),
        },
      ];
    });
    // Active first: projects with a task in use come before the rest, each part in the user's order.
    return sortMode === "active" ? [...rows.filter((row) => row.inUse), ...rows.filter((row) => !row.inUse)] : rows;
  },
);

/** Project ids as the sidebar shows them (all projects, whatever the filter), for moving one up or down. */
export const selectProjectDisplayOrder = createSelector(
  [selectProjectList, selectTaskMap, selectActiveTaskIds, selectSortMode],
  (projects, taskMap, activeIds, sortMode): string[] => {
    const inUse = (id: string) =>
      Object.values(taskMap).some(
        (task) => task.project_id === id && task.state !== "archived" && activeIds.has(task.id),
      );
    const ids = projects.map((project) => project.id);
    return sortMode === "active" ? [...ids.filter(inUse), ...ids.filter((id) => !inUse(id))] : ids;
  },
);

export const selectTaskById = (id: string) => (state: RootState) => state.projects.tasks[id];
export const selectProjectById = (id: string | null | undefined) => (state: RootState) =>
  id ? state.projects.projects[id] : undefined;
