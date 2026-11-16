import { describe, expect, it } from "vitest";
import { FakeCliClient } from "../../src/cli/fake";
import { classifyDiffLine, diffLines } from "../../src/agents/hookDiff";
import { FakeAgentsClient } from "../../src/agents/fake";
import { AgentsError } from "../../src/agents/errors";

// The CLI install fake's state machine and the hook diff helpers the review dialog relies on.

describe("FakeCliClient", () => {
  it("starts uninstalled and reports the target folder", async () => {
    const client = new FakeCliClient();
    const status = await client.cliInstallStatus();
    expect(status.installed).toBe(false);
    expect(status.path).toBeNull();
    expect(status.target).toBe("~/.local/bin");
    expect(status.on_path).toBe(false);
  });

  it("install puts the binary on PATH; uninstall removes it", async () => {
    const client = new FakeCliClient();
    const installed = await client.cliInstall();
    expect(installed.installed).toBe(true);
    expect(installed.path).toBe("~/.local/bin/tessera");
    expect(installed.on_path).toBe(true);
    const removed = await client.cliUninstall();
    expect(removed.installed).toBe(false);
    expect(removed.path).toBeNull();
    expect(client.calls).toEqual(["cliInstall", "cliUninstall"]);
  });
});

describe("hook diff helpers", () => {
  it("classifies unified diff lines", () => {
    expect(classifyDiffLine("--- a/f")).toBe("meta");
    expect(classifyDiffLine("+++ b/f")).toBe("meta");
    expect(classifyDiffLine("@@ -1 +1 @@")).toBe("hunk");
    expect(classifyDiffLine("+added")).toBe("add");
    expect(classifyDiffLine("-removed")).toBe("remove");
    expect(classifyDiffLine(" context")).toBe("context");
    expect(classifyDiffLine("}")).toBe("context");
  });

  it("diffLines drops the phantom row after a trailing newline", () => {
    expect(diffLines("a\nb\n")).toEqual(["a", "b"]);
    expect(diffLines("a\nb")).toEqual(["a", "b"]);
    expect(diffLines("")).toEqual([]);
  });
});

describe("FakeAgentsClient hooks", () => {
  it("previews an install diff for a 'none' agent and applies it", async () => {
    const client = new FakeAgentsClient();
    const preview = await client.hooksPreview("gemini");
    expect(preview.state).toBe("none");
    expect(preview.config_path).toBe("~/.gemini/settings.json");
    expect(preview.diff).toContain('+  "hooks": {');
    const applied = await client.hooksInstall("gemini");
    expect(applied.state).toBe("installed");
    const catalog = await client.agentCatalog(false);
    expect(catalog.find((agent) => agent.id === "gemini")?.hooks_state).toBe("installed");
  });

  it("previews an update for 'outdated' and a removal for 'installed'", async () => {
    const client = new FakeAgentsClient();
    const codex = await client.hooksPreview("codex");
    expect(codex.state).toBe("outdated");
    expect(codex.diff).toContain("+notify =");
    const claude = await client.hooksPreview("claude");
    expect(claude.state).toBe("installed");
    expect(claude.diff).toContain('-  "hooks": {');
    const removed = await client.hooksRemove("claude");
    expect(removed.state).toBe("none");
  });

  it("reports unsupported for an agent without hooks and rejects installs", async () => {
    const client = new FakeAgentsClient();
    const preview = await client.hooksPreview("amp");
    expect(preview.state).toBe("unsupported");
    await expect(client.hooksInstall("amp")).rejects.toBeInstanceOf(AgentsError);
  });

  it("a staged conflict explains itself in preview and rejects the install", async () => {
    const client = new FakeAgentsClient();
    client.setHookPreview("gemini", { config_path: "~/.gemini/settings.json", state: "conflict", diff: "" });
    const preview = await client.hooksPreview("gemini");
    expect(preview.state).toBe("conflict");
    await expect(client.hooksInstall("gemini")).rejects.toMatchObject({ code: "hooks.conflict" });
    client.setHookPreview("gemini", null);
    expect((await client.hooksPreview("gemini")).state).toBe("none");
  });
});
