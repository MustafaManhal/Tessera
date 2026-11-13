import { commands, unwrap } from "@tessera/ipc";
import type { BoardClient } from "./client";
import type { BoardExtra } from "./derive";

export class TauriBoardClient implements BoardClient {
  boardTasks() {
    return unwrap(commands.boardTasks()) as Promise<BoardExtra[]>;
  }
  async taskSetColumn(taskId: string, column: string | null) {
    await unwrap(commands.taskSetColumn(taskId, column));
  }
}
