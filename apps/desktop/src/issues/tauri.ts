import { commands, unwrap } from "@tessera/ipc";
import type { IssuesClient } from "./client";
import type { Issue, IssueProvider, LinearAccount } from "./types";

/** An `AppError` becomes an Error with the backend's sentence; its code stays on `.code` for the picker. */
async function call<T>(promise: Promise<{ status: "ok"; data: T } | { status: "error"; error: unknown }>): Promise<T> {
  try {
    return await unwrap(promise as never);
  } catch (cause) {
    const error = cause as { code?: string; message?: string };
    throw Object.assign(new Error(error?.message || String(cause)), { code: error?.code });
  }
}

export class TauriIssuesClient implements IssuesClient {
  issuesList(projectId: string, provider: IssueProvider, query: string | null) {
    return call(commands.issuesList(projectId, provider, query)) as Promise<Issue[]>;
  }
  async taskSetIssue(taskId: string, issue: Issue) {
    await call(commands.taskSetIssue(taskId, issue));
  }
  linearStatus() {
    return call(commands.linearStatus()) as Promise<LinearAccount | null>;
  }
  linearConnect(apiKey: string) {
    return call(commands.linearConnect(apiKey)) as Promise<LinearAccount>;
  }
  async linearDisconnect() {
    await call(commands.linearDisconnect());
  }
}
