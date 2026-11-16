import { describe, expect, it } from "vitest";
import {
  deriveId,
  draftFromInput,
  emptyDraft,
  inputFromDraft,
  testArgs,
  validateDraft,
} from "../../src/agents/customAgent";
import { FakeAgentsClient } from "../../src/agents/fake";
import type { AgentDefinitionInput } from "../../src/agents/types";

const BUNDLED = new Set(["claude", "codex", "gemini"]);

const valid = (): AgentDefinitionInput => ({
  id: "my-agent",
  name: "My Agent",
  binaries: ["myagent", "myagent-cli"],
  version_cmd: ["myagent", "--version"],
  prompt_mode: "arg",
  model_flag: null,
  resume: [],
  yolo_flags: [],
  hooks: "none",
  ready_pattern: null,
  install_url: "myagent",
  docs_url: "https://",
  icon: "bot",
  allow_override: false,
});

describe("customAgent draft helpers", () => {
  it("derives a lower-case dashed id from the name and stops once edited", () => {
    expect(deriveId("My Agent CLI")).toBe("my-agent-cli");
    expect(deriveId("  Weird___Name!! ")).toBe("weird-name");
    const draft = { ...emptyDraft(), name: "New Tool" };
    expect(draft.id).toBe("");
  });

  it("validates required fields and the id charset per field", () => {
    const draft = { ...emptyDraft(), name: "", id: "Bad_ID", binariesText: "", versionCmdText: "" };
    const errors = validateDraft(draft, BUNDLED);
    expect(errors.name).toBeTruthy();
    expect(errors.id).toBeTruthy();
    expect(errors.binariesText).toBeTruthy();
    expect(errors.versionCmdText).toBeTruthy();
  });

  it("flags a bundled id until the override is ticked, and a bad ready regex", () => {
    const draft = {
      ...emptyDraft(),
      name: "Claude",
      id: "claude",
      binariesText: "claude",
      versionCmdText: "claude --version",
    };
    expect(validateDraft(draft, BUNDLED).id).toBe("agents.custom.error.bundled");
    expect(validateDraft({ ...draft, allowOverride: true }, BUNDLED).id).toBeUndefined();
    expect(validateDraft({ ...draft, id: "mine", readyPattern: "[" }, BUNDLED).readyPattern).toBeTruthy();
    expect(validateDraft({ ...draft, id: "mine", readyPattern: "ready>" }, BUNDLED).readyPattern).toBeUndefined();
  });

  it("round-trips a definition through the draft and applies documented defaults", () => {
    const input = valid();
    const draft = draftFromInput(input);
    expect(draft.binariesText).toBe("myagent, myagent-cli");
    expect(draft.versionCmdText).toBe("myagent --version");
    expect(inputFromDraft(draft)).toEqual({ ...input, allow_override: false });
    const sparse = {
      ...draftFromInput(input),
      installUrl: "",
      docsUrl: "",
      modelFlag: " --model ",
      yoloFlagsText: "--yolo  --x",
    };
    const saved = inputFromDraft(sparse);
    expect(saved.install_url).toBe("myagent");
    expect(saved.docs_url).toBe("https://");
    expect(saved.model_flag).toBe("--model");
    expect(saved.yolo_flags).toEqual(["--yolo", "--x"]);
    expect(testArgs(sparse)).toEqual({ binaries: ["myagent", "myagent-cli"], versionCmd: ["myagent", "--version"] });
  });
});

describe("FakeAgentsClient definitions", () => {
  it("saves a custom agent, detects it when its binary is known, and gets a default profile", async () => {
    const client = new FakeAgentsClient();
    client.installedBinaries.add("myagent");
    await client.agentDefinitionSave(valid());
    const catalog = await client.agentCatalog(false);
    const agent = catalog.find((a) => a.id === "my-agent");
    expect(agent?.source).toBe("user");
    expect(agent?.installed).toBe(true);
    const profiles = await client.agentProfilesList("my-agent");
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.is_default).toBe(true);
    const got = await client.agentDefinitionGet("my-agent");
    expect(got.binaries).toEqual(["myagent", "myagent-cli"]);
  });

  it("refuses a bundled id without override and accepts it with consent", async () => {
    const client = new FakeAgentsClient();
    await expect(client.agentDefinitionSave({ ...valid(), id: "claude" })).rejects.toMatchObject({
      code: "agent.definition_duplicate",
    });
    await client.agentDefinitionSave({ ...valid(), id: "claude", name: "My Claude", allow_override: true });
    const agent = (await client.agentCatalog(false)).find((a) => a.id === "claude");
    expect(agent?.source).toBe("override");
    expect(agent?.name).toBe("My Claude");
  });

  it("validates like the backend and tests detection without a prompt", async () => {
    const client = new FakeAgentsClient();
    await expect(client.agentDefinitionSave({ ...valid(), ready_pattern: "[" })).rejects.toMatchObject({
      code: "agent.definition_invalid",
    });
    const missing = await client.agentDefinitionTest(["no-such-binary"], ["no-such-binary", "--version"]);
    expect(missing.found).toBe(false);
    client.installedBinaries.add("myagent");
    const found = await client.agentDefinitionTest(["myagent"], ["myagent", "--version"]);
    expect(found).toMatchObject({ found: true, version: "1.0.0" });
    const calls = client.calls.filter((c) => c.method === "agentDefinitionTest");
    expect(calls[0]?.args[1]).toEqual(["no-such-binary", "--version"]);
  });

  it("blocks delete while profiles exist, then deletes and restores an override", async () => {
    const client = new FakeAgentsClient();
    client.installedBinaries.add("myagent");
    await client.agentDefinitionSave(valid());
    await expect(client.agentDefinitionDelete("my-agent")).rejects.toMatchObject({ code: "agent.definition_in_use" });
    const profile = (await client.agentProfilesList("my-agent"))[0]!;
    await client.agentProfileDelete(profile.id);
    await client.agentDefinitionDelete("my-agent");
    expect((await client.agentCatalog(false)).some((a) => a.id === "my-agent")).toBe(false);
    // A bundled override deletes back to the bundled row once its profiles are gone.
    await client.agentDefinitionSave({ ...valid(), id: "claude", name: "My Claude", allow_override: true });
    for (const profile of await client.agentProfilesList("claude")) await client.agentProfileDelete(profile.id);
    await client.agentDefinitionDelete("claude");
    const claude = (await client.agentCatalog(false)).find((a) => a.id === "claude");
    expect(claude?.source).toBe("bundled");
    expect(claude?.name).toBe("Claude Code");
  });
});
