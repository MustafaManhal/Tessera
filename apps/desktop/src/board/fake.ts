import type { BoardClient } from "./client";
import type { BoardExtra } from "./derive";

/** In-memory board client for the browser and the UI tests (`window.__tesseraBoard`). */
export class FakeBoardClient implements BoardClient {
  private rows = new Map<string, BoardExtra>();
  failNext: string | null = null;

  private row(taskId: string): BoardExtra {
    let row = this.rows.get(taskId);
    if (!row) {
      row = { task_id: taskId, board_column: null, pr_number: null, pr_state: null, ci_state: null };
      this.rows.set(taskId, row);
    }
    return row;
  }
  /** Test helper: pull request facts for a task. */
  setPr(taskId: string, pr: { number: number; state: string; ci: string | null }): void {
    Object.assign(this.row(taskId), { pr_number: pr.number, pr_state: pr.state, ci_state: pr.ci });
  }
  column(taskId: string): string | null {
    return this.rows.get(taskId)?.board_column ?? null;
  }
  async boardTasks(): Promise<BoardExtra[]> {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }
  async taskSetColumn(taskId: string, column: string | null): Promise<void> {
    if (this.failNext) {
      const message = this.failNext;
      this.failNext = null;
      throw new Error(message);
    }
    this.row(taskId).board_column = column;
  }
}
