import { userInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { isExcluded, scanText } from "../publish-public.mjs";

describe("public export rules", () => {
  it("leaves out the planning folder, agent files and env files, and keeps the rest", () => {
    for (const path of [
      ".ai/docs/x.md",
      ".ai/agent-lead/LEAD.md",
      "CLAUDE.md",
      "AGENTS.md",
      ".env",
      ".claude/settings.json",
    ]) {
      expect(isExcluded(path), path).toBe(true);
    }
    for (const path of [".env.example", "README.md", "docs/README.md", "apps/desktop/src/main.tsx", "my.ai/x"]) {
      expect(isExcluded(path), path).toBe(false);
    }
  });

  it("flags personal paths, account names, private e-mails, keys and tokens", () => {
    const me = userInfo().username;
    const bad = [
      `const p = '/Users/${me}/Projects';`,
      `see ${me}.dev/x`,
      ["contact: someone@", "gmail.com"].join(""),
      ["-----BEGIN OPENSSH ", "PRIVATE KEY-----"].join(""),
      ["token = ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"].join(""),
    ];
    for (const line of bad) expect(scanText("f.txt", line).length, line).toBeGreaterThan(0);
  });

  it("allows placeholders, example addresses and noreply identities", () => {
    const me = userInfo().username;
    const good = [
      "path: '/Users/you/code'",
      "mailto:me@example.com",
      `Name <100897710+${me}@users.noreply.github.com>`,
      `https://github.com/${me}/Tessera`,
    ];
    for (const line of good) {
      expect(scanText("f.txt", line), line).toEqual([]);
    }
  });
});
