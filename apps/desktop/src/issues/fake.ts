import type { IssuesClient } from "./client";
import type { Issue, IssueProvider, LinearAccount } from "./types";

export class IssueError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

const GITHUB: Issue[] = [
  {
    provider: "github",
    id: "1001",
    key: "#12",
    number: 12,
    title: "Login page crashes on empty password",
    body: "Steps:\n1. Open /login\n2. Press Enter with an empty password\n\nThe page shows a blank screen.",
    url: "https://github.com/acme/shop/issues/12",
    labels: ["bug", "auth"],
    assignee: "ada",
  },
  {
    provider: "github",
    id: "1002",
    key: "#18",
    number: 18,
    title: "Export orders as CSV",
    body: "",
    url: "https://github.com/acme/shop/issues/18",
    labels: [],
    assignee: null,
  },
];
const LINEAR: Issue[] = [
  {
    provider: "linear",
    id: "lin-1",
    key: "ENG-42",
    number: 42,
    title: "Rounding error in checkout totals",
    body: "Totals differ by one cent when a coupon applies.",
    url: "https://linear.app/acme/issue/ENG-42",
    labels: ["Bug"],
    assignee: "Ada",
  },
];

/** In-memory issues client for the browser and the UI tests (`window.__tesseraIssues`). */
export class FakeIssuesClient implements IssuesClient {
  githubConnected = true;
  noGithubRemote = false;
  linear: LinearAccount | null = null;
  linearKey = "lin_api_valid";
  failNext: IssueError | null = null;
  setIssue = new Map<string, Issue>();
  queries: Array<{ provider: IssueProvider; query: string | null }> = [];

  async issuesList(_projectId: string, provider: IssueProvider, query: string | null): Promise<Issue[]> {
    this.queries.push({ provider, query });
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    if (provider === "github") {
      if (this.noGithubRemote)
        throw new IssueError("This project's origin is not a GitHub repository.", "issues.no_github_remote");
      if (!this.githubConnected) throw new IssueError("GitHub is not connected.", "github.not_connected");
    } else if (!this.linear) throw new IssueError("Linear is not connected.", "linear.not_connected");
    const all = provider === "github" ? GITHUB : LINEAR;
    const text = (query ?? "").trim().replace(/^#/, "").toLowerCase();
    return text === "" ? all : all.filter((i) => `${i.number} ${i.title}`.toLowerCase().includes(text));
  }
  async taskSetIssue(taskId: string, issue: Issue): Promise<void> {
    this.setIssue.set(taskId, issue);
  }
  async linearStatus(): Promise<LinearAccount | null> {
    return this.linear;
  }
  async linearConnect(apiKey: string): Promise<LinearAccount> {
    if (apiKey.trim() !== this.linearKey)
      throw new IssueError("Linear did not accept the API key.", "linear.not_connected");
    this.linear = { name: "Ada", connected_at: 1_700_000_000 };
    return this.linear;
  }
  async linearDisconnect(): Promise<void> {
    this.linear = null;
  }
}
