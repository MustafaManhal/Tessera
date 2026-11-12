import type { Issue, IssueProvider, LinearAccount } from "./types";

export interface IssuesClient {
  /** Open issues of the project's GitHub repository, or of Linear. Throws an Error whose message is for people. */
  issuesList(projectId: string, provider: IssueProvider, query: string | null): Promise<Issue[]>;
  /** Remembers the issue a task came from. */
  taskSetIssue(taskId: string, issue: Issue): Promise<void>;
  linearStatus(): Promise<LinearAccount | null>;
  linearConnect(apiKey: string): Promise<LinearAccount>;
  linearDisconnect(): Promise<void>;
}
