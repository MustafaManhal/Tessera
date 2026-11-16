import { commands, unwrap } from "@tessera/ipc";
import type { PullsClient } from "./client";
import type { CheckItem, LocalMergeResult, MergeMethod, PrInfo } from "./types";

/** An `AppError` becomes an Error with the backend's sentence; its code stays on `.code`. */
async function call<T>(promise: Promise<{ status: "ok"; data: T } | { status: "error"; error: unknown }>): Promise<T> {
  try {
    return await unwrap(promise as never);
  } catch (cause) {
    const error = cause as { code?: string; message?: string };
    throw Object.assign(new Error(error?.message || String(cause)), { code: error?.code });
  }
}

export class TauriPullsClient implements PullsClient {
  prCreate(taskId: string, title: string, body: string, draft: boolean) {
    return call(commands.prCreate(taskId, title, body, draft)) as Promise<PrInfo>;
  }
  prRefresh(taskId: string) {
    return call(commands.prRefresh(taskId)) as Promise<PrInfo>;
  }
  prChecks(taskId: string) {
    return call(commands.prChecks(taskId)) as Promise<CheckItem[]>;
  }
  prFailureLog(taskId: string) {
    return call(commands.prFailureLog(taskId)) as Promise<string>;
  }
  prMerge(taskId: string, method: MergeMethod) {
    return call(commands.prMerge(taskId, method)) as Promise<PrInfo>;
  }
  prMergeLocal(taskId: string) {
    return call(commands.prMergeLocal(taskId)) as Promise<LocalMergeResult>;
  }
}
