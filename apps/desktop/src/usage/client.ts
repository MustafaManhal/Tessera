import type { TaskUsage } from "./types";

export interface UsageClient {
  /** Null when no agent of the task reports usage, or the task lives on an SSH host. */
  taskUsage(taskId: string): Promise<TaskUsage | null>;
  /** The text a hand-off to another agent starts from. */
  handoffSummary(taskId: string): Promise<string>;
}
