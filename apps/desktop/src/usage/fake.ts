import type { UsageClient } from "./client";
import type { TaskUsage } from "./types";

/** In-memory usage client for the browser and the UI tests; tests set figures through `window.__tesseraUsage`. */
export class FakeUsageClient implements UsageClient {
  private usage = new Map<string, TaskUsage | null>();
  private summaries = new Map<string, string>();
  calls = 0;
  /** Used for tasks without their own figures (tests do not know the generated task ids). */
  defaultUsage: TaskUsage | null = null;

  setUsage(taskId: string, usage: TaskUsage | null): void {
    this.usage.set(taskId, usage);
  }
  setSummary(taskId: string, text: string): void {
    this.summaries.set(taskId, text);
  }
  async taskUsage(taskId: string): Promise<TaskUsage | null> {
    this.calls += 1;
    return this.usage.get(taskId) ?? this.defaultUsage;
  }
  async handoffSummary(taskId: string): Promise<string> {
    return (
      this.summaries.get(taskId) ??
      "You are taking over a task from Claude Code.\nTask: Demo task (branch demo, base main).\n\nNo files have been changed yet.\n"
    );
  }
}
