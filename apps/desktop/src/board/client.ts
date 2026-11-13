import type { BoardExtra } from "./derive";

export interface BoardClient {
  /** Manual columns and pull request facts, for the tasks that have any. */
  boardTasks(): Promise<BoardExtra[]>;
  /** Moves a task by hand; null goes back to the automatic column. */
  taskSetColumn(taskId: string, column: string | null): Promise<void>;
}
