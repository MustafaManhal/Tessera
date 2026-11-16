import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commands,
  events,
  type AppError_Serialize,
  type CommandResult,
  type TaskChanged_Serialize,
} from "@tessera/ipc";
import { ProjectsError, type ProjectsErrorKind } from "../../src/projects/errors";
import { setProjectsClient } from "../../src/projects/service";
import { TauriProjectsClient } from "../../src/projects/tauri";
import { startProjectsSync } from "../../src/projects/sync";
import { createAppStore } from "../../src/store";
import type { TaskSummary } from "../../src/projects/types";
import { createTask } from "../../src/projects/thunks";

const client = new TauriProjectsClient();

function success<T>(data: T): CommandResult<T, AppError_Serialize> {
  return { status: "ok", data };
}

function failure(code: string, extra: Partial<AppError_Serialize> = {}): CommandResult<never, AppError_Serialize> {
  return { status: "error", error: { code, message: `failed: ${code}`, ...extra } };
}

const task: TaskSummary = {
  id: "task-1",
  project_id: "project-1",
  group_id: null,
  name: "Original",
  slug: "original",
  branch: "tessera/original",
  base_branch: "main",
  worktree_path: "/repo-worktrees/original",
  uses_main_checkout: false,
  keeps_branch: false,
  state: "active",
  prompt: null,
  port_start: null,
  port_count: 0,
  last_message: null,
  created_at: 1,
  updated_at: 1,
  archived_at: null,
  ahead: 0,
  behind: 0,
  changed_files: 0,
  ports: [],
};

const errorCases: [string, ProjectsErrorKind, Partial<AppError_Serialize>, object][] = [
  ["project.not_a_git_repo", "NotAGitRepo", { can_init: true }, { extra: { canInit: true } }],
  ["project.already_added", "AlreadyAdded", {}, {}],
  ["task.branch_exists", "BranchExists", {}, {}],
  ["task.worktree_failed", "WorktreeFailed", {}, {}],
  ["task.setup_not_approved", "SetupNotApproved", {}, {}],
  [
    "task.unmerged_commits",
    "UnmergedCommits",
    { list: ["commit subject"] },
    { commits: [{ hash: "", subject: "commit subject" }] },
  ],
  ["project.invalid_copy_file", "InvalidCopyFile", {}, {}],
  ["project.clone_failed", "CloneFailed", {}, {}],
  ["project.cancelled", "Cancelled", {}, {}],
  ["project.not_found", "NotFound", {}, {}],
  ["store.failed", "Unknown", {}, {}],
];

afterEach(() => {
  vi.restoreAllMocks();
  setProjectsClient(null);
});

describe("TauriProjectsClient", () => {
  it("uses generated commands and returns successful results", async () => {
    const projectList = vi.spyOn(commands, "projectList").mockResolvedValue(success([]));
    const taskList = vi.spyOn(commands, "taskList").mockResolvedValue(success([task]));

    await expect(client.projectList()).resolves.toEqual([]);
    await expect(client.taskList({ include_archived: true })).resolves.toEqual([task]);
    expect(projectList).toHaveBeenCalledOnce();
    expect(taskList).toHaveBeenCalledWith(null, true);
  });

  it.each(errorCases)("maps typed command error %s", async (code, kind, extra, expected) => {
    vi.spyOn(commands, "projectAdd").mockResolvedValue(failure(code, extra));
    await expect(client.projectAdd({ path: "/repo" })).rejects.toMatchObject({
      name: "ProjectsError",
      kind,
      message: `failed: ${code}`,
      ...expected,
    });
  });

  it("does not insert a task when the generated create command fails", async () => {
    setProjectsClient(client);
    vi.spyOn(commands, "taskCreate").mockResolvedValue(failure("task.branch_exists"));
    const store = createAppStore();

    await expect(
      store.dispatch(
        createTask({
          project_id: "project-1",
          name: "Duplicate",
          base_branch: "main",
          agents: [],
          use_main_checkout: false,
          run_setup: true,
        }),
      ),
    ).rejects.toBeInstanceOf(ProjectsError);
    expect(store.getState().projects.tasks).toEqual({});
  });

  it("applies generated task:changed events for external updates and stops after unsubscribe", async () => {
    let emit: (payload: TaskChanged_Serialize) => void = () => {
      throw new Error("task event listener is not ready");
    };
    vi.spyOn(commands, "projectList").mockResolvedValue(success([]));
    vi.spyOn(commands, "taskList").mockResolvedValue(success([task]));
    const unlisten = vi.fn();
    vi.spyOn(events.taskChanged, "listen").mockImplementation(async (listener) => {
      emit = (payload) => listener({ event: "task:changed", id: 1, payload });
      return unlisten;
    });
    setProjectsClient(client);
    const store = createAppStore();
    const stop = startProjectsSync(client, store);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState().projects.tasks[task.id]).toMatchObject({ changed_files: 0 });

    emit({ task_id: task.id, summary: { ...task, changed_files: 5, ahead: 3, ports: [3000] } });
    expect(store.getState().projects.tasks[task.id]).toMatchObject({ changed_files: 5, ahead: 3, ports: [3000] });

    stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unlisten).toHaveBeenCalledOnce();
    emit({ task_id: task.id, summary: { ...task, changed_files: 9 } });
    expect(store.getState().projects.tasks[task.id]?.changed_files).toBe(5);
  });
});
