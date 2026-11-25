import { describe, expect, it } from "vitest";
import { agentCommandLine, quoteWord } from "../../src/agents/startHere";

describe("starting an agent in the terminal", () => {
  it("types the program with the profile's arguments, quoting only words that need it", () => {
    expect(agentCommandLine("claude", ["--model", "opus", "--dangerously-skip-permissions"], "mac")).toBe(
      "claude --model opus --dangerously-skip-permissions",
    );
    expect(agentCommandLine("/Users/me/.nvm/versions/node/v22/bin/qwen", [], "mac")).toBe(
      "/Users/me/.nvm/versions/node/v22/bin/qwen",
    );
    expect(quoteWord("it's here", "mac")).toBe("'it'\\''s here'");
    expect(quoteWord("it's here", "windows")).toBe("'it''s here'");
    expect(quoteWord("", "mac")).toBe("''");
  });

  it("runs a quoted program through PowerShell's call operator", () => {
    expect(agentCommandLine("C:\\Program Files\\agent\\agent.exe", ["a b"], "windows")).toBe(
      "& 'C:\\Program Files\\agent\\agent.exe' 'a b'",
    );
  });
});
