import { describe, expect, it } from "vitest";
import { hashTrigger, issuePrompt, issueTaskName } from "../../src/issues/prompt";
import type { Issue } from "../../src/issues/types";

const issue = (over: Partial<Issue> = {}): Issue => ({
  provider: "github",
  id: "1",
  key: "#12",
  number: 12,
  title: "Login crash",
  body: "Steps to reproduce",
  url: "https://github.com/o/r/issues/12",
  labels: ["bug"],
  assignee: null,
  ...over,
});

describe("issue to task", () => {
  it("names the task with the key first so the branch carries the number", () => {
    expect(issueTaskName(issue())).toBe("#12 Login crash");
    expect(issueTaskName(issue({ provider: "linear", key: "ENG-42", title: "Fix totals" }))).toBe("ENG-42 Fix totals");
    expect(issueTaskName(issue({ title: "x".repeat(200) })).length).toBe(80);
  });
  it("builds the Fix issue prompt and leaves out empty parts", () => {
    expect(issuePrompt(issue())).toBe(
      "Fix issue #12: Login crash\n\nSteps to reproduce\n\nLabels: bug\n\nIssue: https://github.com/o/r/issues/12",
    );
    expect(issuePrompt(issue({ body: "  ", labels: [] }))).toBe(
      "Fix issue #12: Login crash\n\nIssue: https://github.com/o/r/issues/12",
    );
  });
  it("opens the picker on a # at the start or after whitespace", () => {
    expect(hashTrigger("#", 1)).toEqual({ query: "", start: 0 });
    expect(hashTrigger("fix #12", 7)).toEqual({ query: "12", start: 4 });
    expect(hashTrigger("fix #12 now", 11)).toBeNull();
    expect(hashTrigger("issue#12", 8)).toBeNull();
    expect(hashTrigger("plain", 5)).toBeNull();
  });
});
