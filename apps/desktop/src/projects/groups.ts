// Best-of-N groups (FR-36): status summary per group and the once-only "ready to compare" rule.
import type { TaskGroupInfo, TaskSummary } from "./types";

export interface GroupStatus {
  working: number;
  needs: number;
  idle: number;
  done: number;
  total: number;
}

export interface AgentSessionLike {
  task_id: string | null;
  status: string;
}

/** Counts agent sessions of the group's tasks by coarse status. */
export function groupStatus(
  group: TaskGroupInfo,
  tasks: Record<string, TaskSummary>,
  sessions: Record<string, AgentSessionLike>,
): GroupStatus {
  const ids = new Set(
    Object.values(tasks)
      .filter((t) => t.group_id === group.id)
      .map((t) => t.id),
  );
  const out: GroupStatus = { working: 0, needs: 0, idle: 0, done: 0, total: 0 };
  for (const session of Object.values(sessions)) {
    if (!session.task_id || !ids.has(session.task_id)) continue;
    out.total += 1;
    if (session.status === "working" || session.status === "starting") out.working += 1;
    else if (session.status === "needs_input" || session.status === "error") out.needs += 1;
    else if (session.status === "idle") out.idle += 1;
    else if (session.status === "exited" || session.status === "done") out.done += 1;
  }
  return out;
}

/**
 * Ready to compare: every agent session of the group is idle or exited (or done), at least one exists, and the
 * group has not fired before (`fired` is the caller's memory). Pure — the caller persists `fired` per group id.
 */
export function readyToCompare(
  group: TaskGroupInfo,
  tasks: Record<string, TaskSummary>,
  sessions: Record<string, AgentSessionLike>,
  fired: ReadonlySet<string>,
): boolean {
  if (fired.has(group.id)) return false;
  const ids = new Set(
    Object.values(tasks)
      .filter((t) => t.group_id === group.id)
      .map((t) => t.id),
  );
  const mine = Object.values(sessions).filter((s) => s.task_id && ids.has(s.task_id));
  if (mine.length === 0) return false;
  return mine.every((s) => s.status === "idle" || s.status === "exited" || s.status === "done");
}
