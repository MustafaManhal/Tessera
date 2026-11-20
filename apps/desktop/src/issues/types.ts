// Issues that become tasks (M9.1, FR-54, FR-55). Mirrors the Rust `IssueInfo` DTO.
export type IssueProvider = "github" | "linear";

export interface Issue {
  provider: IssueProvider;
  id: string;
  /** What people call it: "#12" or "ENG-42". */
  key: string;
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  assignee: string | null;
}

export interface LinearAccount {
  name: string;
  connected_at: number;
}
