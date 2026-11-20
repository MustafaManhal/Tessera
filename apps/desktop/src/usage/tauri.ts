import { commands, unwrap } from "@tessera/ipc";
import type { UsageClient } from "./client";
import type { TaskUsage } from "./types";

export class TauriUsageClient implements UsageClient {
  taskUsage(taskId: string) {
    return unwrap(commands.taskUsage(taskId)) as Promise<TaskUsage | null>;
  }
  handoffSummary(taskId: string) {
    return unwrap(commands.handoffSummary(taskId));
  }
}
