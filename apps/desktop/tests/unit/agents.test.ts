import { describe, expect, it } from "vitest";
import { isValidEnvKey, joinArgs, parseArgs } from "../../src/agents/args";
import { AgentsError, mapAgentsError } from "../../src/agents/errors";
import { FakeAgentsClient } from "../../src/agents/fake";
import type { AgentProfileInput } from "../../src/agents/types";

const input = (overrides: Partial<AgentProfileInput> = {}): AgentProfileInput => ({
  id: null,
  agent_id: "claude",
  name: "Profile",
  model: null,
  extra_args: [],
  env: {},
  skip_permissions: false,
  is_default: false,
  ...overrides,
});

describe("parseArgs", () => {
  it("splits on whitespace and keeps empty input empty", () => {
    expect(parseArgs("")).toEqual({ args: [], error: null });
    expect(parseArgs("   \n\t ")).toEqual({ args: [], error: null });
    expect(parseArgs("--verbose --model sonnet").args).toEqual(["--verbose", "--model", "sonnet"]);
  });

  it("groups quoted words and keeps empty quoted words", () => {
    expect(parseArgs('--flag "two words"').args).toEqual(["--flag", "two words"]);
    expect(parseArgs("--flag 'two words'").args).toEqual(["--flag", "two words"]);
    expect(parseArgs('""').args).toEqual([""]);
    expect(parseArgs('a"b c"d').args).toEqual(["ab cd"]);
  });

  it("treats an escaped space as part of the word and unescapes quotes inside double quotes", () => {
    expect(parseArgs("--path /a\\ b").args).toEqual(["--path", "/a b"]);
    expect(parseArgs('"say \\"hi\\""').args).toEqual(['say "hi"']);
    expect(parseArgs("'it'\\''s'").args).toEqual(["it's"]);
  });

  it("reports an unterminated quote instead of guessing", () => {
    expect(parseArgs('--flag "two')).toEqual({ args: ["--flag"], error: "unterminated" });
    expect(parseArgs('"it\'s fine"').args).toEqual(["it's fine"]);
    expect(parseArgs("'open")).toEqual({ args: [], error: "unterminated" });
  });

  it("reports a trailing backslash", () => {
    expect(parseArgs("--flag \\")).toEqual({ args: ["--flag"], error: "trailingEscape" });
    expect(parseArgs("C:\\\\path").args).toEqual(["C:\\path"]);
  });

  it("round-trips through joinArgs", () => {
    const args = ["--flag", "two words", "it's", "", "plain"];
    expect(parseArgs(joinArgs(args)).args).toEqual(args);
    expect(joinArgs(["plain", "-x"])).toBe("plain -x");
  });
});

describe("environment variable names", () => {
  it("accepts the backend's pattern", () => {
    expect(isValidEnvKey("FOO")).toBe(true);
    expect(isValidEnvKey("_private")).toBe(true);
    expect(isValidEnvKey("A1_b2")).toBe(true);
  });

  it("rejects empty, leading digits, dashes and spaces", () => {
    expect(isValidEnvKey("")).toBe(false);
    expect(isValidEnvKey("1FOO")).toBe(false);
    expect(isValidEnvKey("FOO-BAR")).toBe(false);
    expect(isValidEnvKey("FOO BAR")).toBe(false);
    expect(isValidEnvKey("FÖÖ")).toBe(false);
  });
});

describe("FakeAgentsClient", () => {
  it("seeds the ten bundled agents, three installed and one broken override", async () => {
    const client = new FakeAgentsClient();
    const catalog = await client.agentCatalog(false);
    expect(catalog).toHaveLength(10);
    expect(catalog.filter((agent) => agent.installed).map((agent) => agent.id)).toEqual(["claude", "codex", "gemini"]);
    expect(catalog.find((agent) => agent.id === "claude")?.version).toBe("2.1.4");
    expect(catalog.find((agent) => agent.id === "aider")?.source).toBe("override");
    expect(catalog.find((agent) => agent.id === "aider")?.definition_error).toContain("unknown key");
    expect(catalog.find((agent) => agent.id === "claude")?.has_skip_permissions).toBe(true);
    expect(catalog.find((agent) => agent.id === "opencode")?.has_skip_permissions).toBe(false);
  });

  it("seeds one default profile per installed agent", async () => {
    const client = new FakeAgentsClient();
    const profiles = await client.agentProfilesList(null);
    expect(profiles.map((profile) => profile.agent_id)).toEqual(["claude", "codex", "gemini"]);
    for (const agent of ["claude", "codex", "gemini"]) {
      const own = profiles.filter((profile) => profile.agent_id === agent);
      expect(own).toHaveLength(1);
      expect(own[0]?.is_default).toBe(true);
    }
  });

  it("validates names, env keys and ids with the Rust error codes", async () => {
    const client = new FakeAgentsClient();
    await expect(client.agentProfileSave(input({ name: "  " }))).rejects.toMatchObject({
      code: "agent.profile_invalid",
    });
    await expect(client.agentProfileSave(input({ env: { "BAD-KEY": "x" } }))).rejects.toMatchObject({
      code: "agent.profile_invalid",
    });
    await expect(client.agentProfileSave(input({ agent_id: "nope" }))).rejects.toMatchObject({
      code: "agent.unknown",
    });
    await expect(client.agentProfileSave(input({ id: "prof_missing" }))).rejects.toMatchObject({
      code: "agent.profile_not_found",
    });
    await expect(client.agentProfileDelete("prof_missing")).rejects.toMatchObject({ code: "agent.profile_not_found" });
  });

  it("creates, trims and edits profiles; the first of an agent is its default", async () => {
    const client = new FakeAgentsClient();
    const created = await client.agentProfileSave(
      input({ name: "  Mine  ", model: "  ", extra_args: ["--quiet"], env: { FOO: "bar" } }),
    );
    expect(created.name).toBe("Mine");
    expect(created.model).toBeNull();
    expect(created.extra_args).toEqual(["--quiet"]);
    expect(created.is_default).toBe(false);
    const first = await client.agentProfileSave(input({ agent_id: "opencode", name: "OpenCode" }));
    expect(first.is_default).toBe(true);
    const edited = await client.agentProfileSave(
      input({ id: created.id, name: "Mine again", model: "opus", extra_args: [], env: {} }),
    );
    expect(edited.id).toBe(created.id);
    expect(edited.name).toBe("Mine again");
    expect(edited.created_at).toBe(created.created_at);
    expect(await client.agentProfilesList("claude")).toHaveLength(2);
  });

  it("keeps one default per agent and moves it when another profile is saved as default", async () => {
    const client = new FakeAgentsClient();
    const [claude] = await client.agentProfilesList("claude");
    const second = await client.agentProfileSave(input({ name: "Second" }));
    await client.agentProfileSave(input({ id: second.id, name: "Second", is_default: true }));
    const profiles = await client.agentProfilesList("claude");
    expect(profiles.find((profile) => profile.id === second.id)?.is_default).toBe(true);
    expect(profiles.find((profile) => profile.id === claude?.id)?.is_default).toBe(false);
    expect(profiles.filter((profile) => profile.is_default)).toHaveLength(1);
  });

  it("deleting the default makes another profile of that agent the default", async () => {
    const client = new FakeAgentsClient();
    const [claude] = await client.agentProfilesList("claude");
    const second = await client.agentProfileSave(input({ name: "Second" }));
    await client.agentProfileDelete(claude?.id as string);
    const profiles = await client.agentProfilesList("claude");
    expect(profiles.map((profile) => profile.id)).toEqual([second.id]);
    expect(profiles[0]?.is_default).toBe(true);
  });

  it("builds the command preview from the profile and never adds yolo flags unasked", async () => {
    const client = new FakeAgentsClient();
    const [claude] = await client.agentProfilesList("claude");
    const preview = await client.agentCommandPreview(claude?.id as string, null);
    expect(preview.program).toBe("claude");
    expect(preview.args).toEqual(["--model", "sonnet", "--verbose"]);
    expect(preview.env_keys).toEqual(["ANTHROPIC_LOG"]);
    expect(preview.skip_permissions).toBe(false);
    expect(preview.args.join(" ")).not.toContain("dangerously");

    const unsafe = await client.agentProfileSave(
      input({ id: claude?.id ?? null, name: "Unsafe", model: "sonnet", skip_permissions: true }),
    );
    const skipped = await client.agentCommandPreview(unsafe.id, null);
    expect(skipped.skip_permissions).toBe(true);
    expect(skipped.args).toContain("--dangerously-skip-permissions");
  });

  it("never returns environment values, only names", async () => {
    const client = new FakeAgentsClient();
    const [gemini] = await client.agentProfilesList("gemini");
    const saved = await client.agentProfileSave(
      input({ id: gemini?.id ?? null, agent_id: "gemini", name: "Gemini", env: { GEMINI_TOKEN: "secret-token-xyz" } }),
    );
    const preview = await client.agentCommandPreview(saved.id, null);
    expect(preview.env_keys).toEqual(["GEMINI_TOKEN"]);
    expect(JSON.stringify(preview)).not.toContain("secret-token-xyz");
  });

  it("passes a prompt per the definition's mode", async () => {
    const client = new FakeAgentsClient();
    const aider = await client.agentProfileSave(input({ agent_id: "aider", name: "Aider" }));
    const noPrompt = await client.agentCommandPreview(aider.id, null);
    expect(noPrompt.args).toEqual([]);
    const withPrompt = await client.agentCommandPreview(aider.id, "fix the login bug");
    expect(withPrompt.prompt_mode).toBe("flag:--message");
    expect(withPrompt.args).toEqual(["--message", "fix the login bug"]);
  });

  it("emits onChanged after a save, a delete and a rescan, and stops after unsubscribe", async () => {
    const client = new FakeAgentsClient({ rescanMs: 1 });
    let events = 0;
    const off = client.onChanged(() => {
      events++;
    });
    const created = await client.agentProfileSave(input({ agent_id: "opencode", name: "One" }));
    await client.agentProfileDelete(created.id);
    await client.agentCatalog(true);
    expect(events).toBe(3);
    off();
    await client.agentProfileSave(input({ agent_id: "opencode", name: "Two" }));
    expect(events).toBe(3);
  });

  it("maps backend codes and messages to AgentsError", () => {
    expect(mapAgentsError({ code: "agent.unknown", message: "No such agent" })).toMatchObject({
      code: "agent.unknown",
      message: "No such agent",
    });
    expect(mapAgentsError(new Error("boom"))).toMatchObject({ code: "unknown", message: "boom" });
    const original = new AgentsError("agent.profile_invalid", "Bad");
    expect(mapAgentsError(original)).toBe(original);
  });
});
