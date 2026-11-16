// Prompt variables (FR-43) and prompt-bar history navigation rules.
import { describe, expect, it } from "vitest";
import { detectVariables, expandVariables, knownVariables } from "../../src/prompts/variables";

describe("prompt variables", () => {
  it("detects names in order, deduplicated, with optional whitespace", () => {
    expect(detectVariables("{{task}} fix {{ branch }} on {{task}}")).toEqual(["task", "branch"]);
    expect(detectVariables("no vars {{}} and {{ bad name }}")).toEqual([]);
  });

  it("expands known values and leaves missing or unknown names literal", () => {
    const text = "work on {{task}} in {{branch}}; issue {{issue}}; keep {{custom}}";
    expect(expandVariables(text, { task: "Fix bug", branch: "feat/x", issue: null })).toBe(
      "work on Fix bug in feat/x; issue {{issue}}; keep {{custom}}",
    );
  });

  it("replaces repeated names everywhere", () => {
    expect(expandVariables("{{task}} / {{task}}", { task: "T" })).toBe("T / T");
  });

  it("knownVariables returns only the FR-43 names", () => {
    expect(knownVariables("{{task}} {{issue}} {{custom}}")).toEqual(["task", "issue"]);
  });
});
