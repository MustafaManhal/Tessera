import { describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/agents/types";
import { type BoardExtra, columnOf, newestSession } from "../../src/board/derive";
import type { TaskSummary } from "../../src/projects/types";

const task = (over: Partial<TaskSummary> = {}): TaskSummary => ({
  id: "t1",
  project_id: "p",
  group_id: null,
  name: "Task",
  slug: "task",
  branch: "tessera/task",
  base_branch: "main",
  worktree_path: "/w",
  uses_main_checkout: false,
  keeps_branch: false,
  state: "active",
  prompt: null,
  port_start: null,
  port_count: 10,
  last_message: null,
  created_at: 1,
  updated_at: 1,
  archived_at: null,
  ahead: 0,
  behind: 0,
  changed_files: 0,
  ports: [],
  ...over,
});
const session = (over: Partial<AgentSession> = {}): AgentSession => ({
  id: "s1",
  task_id: "t1",
  pane_session_id: "x",
  pane_id: "p",
  agent_id: "claude",
  profile_id: "pr",
  status: "working",
  status_source: "hook",
  status_at: 1,
  status_message: null,
  exit_code: null,
  prompt: null,
  started_at: 1,
  ended_at: null,
  ...over,
});
const extra = (over: Partial<BoardExtra> = {}): BoardExtra => ({
  task_id: "t1",
  board_column: null,
  pr_number: null,
  pr_state: null,
  ci_state: null,
  ...over,
});

describe("board column rules", () => {
  it("a manual column always wins", () => {
    expect(columnOf(task({ state: "archived" }), undefined, extra({ board_column: "running" }))).toBe("running");
  });
  it("ignores an unknown stored column", () => {
    expect(columnOf(task(), undefined, extra({ board_column: "nonsense" }))).toBe("backlog");
  });
  it("archived and merged are Done", () => {
    expect(columnOf(task({ state: "archived" }), undefined, undefined)).toBe("done");
    expect(columnOf(task(), session(), extra({ pr_state: "merged" }))).toBe("done");
    expect(columnOf(task(), undefined, extra({ pr_state: "closed" }))).toBe("done");
  });
  it("working and starting agents are Running", () => {
    expect(columnOf(task(), session({ status: "working" }), undefined)).toBe("running");
    expect(columnOf(task(), session({ status: "starting" }), undefined)).toBe("running");
    expect(columnOf(task({ state: "setting_up" }), undefined, undefined)).toBe("running");
  });
  it("waiting, error and failed exits need you", () => {
    expect(columnOf(task(), session({ status: "needs_input" }), undefined)).toBe("needs_you");
    expect(columnOf(task(), session({ status: "error" }), undefined)).toBe("needs_you");
    expect(columnOf(task(), session({ status: "exited", exit_code: 1 }), undefined)).toBe("needs_you");
    expect(columnOf(task({ state: "error" }), undefined, undefined)).toBe("needs_you");
  });
  it("an idle agent with changes is Review, without changes still Running", () => {
    expect(columnOf(task({ changed_files: 2 }), session({ status: "idle" }), undefined)).toBe("review");
    expect(columnOf(task(), session({ status: "idle" }), undefined)).toBe("running");
  });
  it("a finished agent with changes or an open pull request is Review", () => {
    expect(columnOf(task({ changed_files: 1 }), session({ status: "exited" }), undefined)).toBe("review");
    expect(columnOf(task(), session({ status: "exited" }), extra({ pr_state: "open" }))).toBe("review");
  });
  it("a task nobody started is Backlog", () => {
    expect(columnOf(task(), undefined, undefined)).toBe("backlog");
    expect(columnOf(task({ state: "backlog" }), undefined, undefined)).toBe("backlog");
  });
  it("picks the newest session of the task", () => {
    const rows = [
      session({ id: "a", started_at: 1 }),
      session({ id: "b", started_at: 5 }),
      session({ id: "c", task_id: "t2", started_at: 9 }),
    ];
    expect(newestSession(rows, "t1")?.id).toBe("b");
    expect(newestSession(rows, "none")).toBeUndefined();
  });
});
