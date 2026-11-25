import { describe, expect, it } from "vitest";
import { isAgentCommand } from "../../src/terminal/blocks/controller";

describe("isAgentCommand", () => {
  it("knows interactive agents by name, path or PowerShell call", () => {
    expect(isAgentCommand("claude")).toBe(true);
    expect(isAgentCommand("claude --resume 39bd25c1-68e1-4c21-9731-3ac84963642a")).toBe(true);
    expect(isAgentCommand("cursor-agent")).toBe(true);
    expect(isAgentCommand("/Users/me/.nvm/versions/node/v22/bin/qwen")).toBe(true);
    expect(isAgentCommand("& 'C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd'")).toBe(true);
  });
  it("leaves other commands alone", () => {
    expect(isAgentCommand("ls -la")).toBe(false);
    expect(isAgentCommand("git commit -m claude")).toBe(false);
    expect(isAgentCommand("")).toBe(false);
    expect(isAgentCommand(null)).toBe(false);
  });
});
