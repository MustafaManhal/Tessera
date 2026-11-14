// Which board column a task is in (M7.7, FR-33). A manual column wins; otherwise the column follows the task state,
// its newest agent session and its changes or pull request. Pure, so every rule has a unit test.
import type { AgentSession } from "../agents/types";
import type { TaskSummary } from "../projects/types";

export const COLUMNS = ["backlog", "running", "needs_you", "review", "done"] as const;
export type Column = (typeof COLUMNS)[number];

export function isColumn(value: unknown): value is Column {
  return typeof value === "string" && (COLUMNS as readonly string[]).includes(value);
}

/** What the backend keeps per task for the board: the manual column and pull request facts. */
export interface BoardExtra {
  task_id: string;
  board_column: string | null;
  pr_number: number | null;
  pr_state: string | null;
  ci_state: string | null;
}

export function newestSession(sessions: readonly AgentSession[], taskId: string): AgentSession | undefined {
  let newest: AgentSession | undefined;
  for (const session of sessions) {
    if (session.task_id === taskId && (!newest || session.started_at > newest.started_at)) newest = session;
  }
  return newest;
}

export function columnOf(task: TaskSummary, session: AgentSession | undefined, extra: BoardExtra | undefined): Column {
  if (isColumn(extra?.board_column)) return extra.board_column;
  if (task.state === "archived" || task.state === "deleted") return "done";
  const pr = extra?.pr_state ?? null;
  if (pr === "merged" || pr === "closed") return "done";
  if (task.state === "error") return "needs_you";
  if (task.state === "backlog") return "backlog";
  const hasWork = (task.changed_files ?? 0) > 0 || pr === "open" || pr === "draft";
  if (task.state === "setting_up") return "running";
  if (session && session.status !== "exited") {
    if (session.status === "needs_input" || session.status === "error") return "needs_you";
    if (session.status === "idle") return hasWork ? "review" : "running";
    return "running";
  }
  if (session?.status === "exited" && session.exit_code) return "needs_you";
  return hasWork ? "review" : "backlog";
}
