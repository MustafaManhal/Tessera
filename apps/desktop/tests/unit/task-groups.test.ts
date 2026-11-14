import { describe, expect, it } from "vitest";
import { groupStatus, readyToCompare } from "../../src/projects/groups";
import type { TaskGroupInfo, TaskSummary } from "../../src/projects/types";

const group: TaskGroupInfo = {
  id: "g1",
  project_id: "p1",
  name: "checkout",
  prompt: "fix it",
  picked_task_id: null,
  created_at: 0,
};

const tasks = {
  t1: { id: "t1", project_id: "p1", group_id: "g1" },
  t2: { id: "t2", project_id: "p1", group_id: "g1" },
  t3: { id: "t3", project_id: "p1", group_id: null },
} as unknown as Record<string, TaskSummary>;

describe("groupStatus", () => {
  it("counts only sessions of the group's tasks", () => {
    const s = {
      a: { task_id: "t1", status: "working" },
      b: { task_id: "t2", status: "needs_input" },
      c: { task_id: "t3", status: "idle" },
      d: { task_id: null, status: "idle" },
    } as never;
    expect(groupStatus(group, tasks, s)).toEqual({ working: 1, needs: 1, idle: 0, done: 0, total: 2 });
  });
});

describe("readyToCompare", () => {
  const all = {
    a: { task_id: "t1", status: "idle" },
    b: { task_id: "t2", status: "exited" },
  } as never;
  it("fires once all agents are idle or exited", () => {
    expect(readyToCompare(group, tasks, all, new Set())).toBe(true);
    expect(readyToCompare(group, tasks, all, new Set(["g1"]))).toBe(false);
  });
  it("does not fire while any agent works or needs input", () => {
    const busy = { a: { task_id: "t1", status: "working" }, b: { task_id: "t2", status: "idle" } } as never;
    expect(readyToCompare(group, tasks, busy, new Set())).toBe(false);
    const needs = { a: { task_id: "t1", status: "needs_input" }, b: { task_id: "t2", status: "idle" } } as never;
    expect(readyToCompare(group, tasks, needs, new Set())).toBe(false);
  });
  it("does not fire with no agent sessions", () => {
    expect(readyToCompare(group, tasks, {} as never, new Set())).toBe(false);
  });
});
