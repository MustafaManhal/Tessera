import type { Issue } from "./types";

/** The task name for an issue. The key leads so the branch carries the issue number ("tessera/12-login-crash"). */
export function issueTaskName(issue: Issue): string {
  return `${issue.key} ${issue.title}`.slice(0, 80).trim();
}

/** The "Fix issue" prompt template. */
export function issuePrompt(issue: Issue): string {
  const parts = [`Fix issue ${issue.key}: ${issue.title}`];
  const body = issue.body.trim();
  if (body !== "") parts.push(body);
  if (issue.labels.length > 0) parts.push(`Labels: ${issue.labels.join(", ")}`);
  parts.push(`Issue: ${issue.url}`);
  return parts.join("\n\n");
}

/** `#` at the start of the text or after whitespace, followed by what the user typed since: opens the picker. */
export function hashTrigger(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)#([^\s#]*)$/.exec(before);
  if (!match) return null;
  return { query: match[2] ?? "", start: before.length - (match[2]?.length ?? 0) - 1 };
}
