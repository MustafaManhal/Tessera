import { describe, expect, it } from "vitest";
import { attentionConfigKey, attentionKind, configValue, isDndActive } from "../../src/agents/attention";
import { projectMuted } from "../../src/agents/attentionEngine";
import type { RootState } from "../../src/store";

// The attention rules (brief 32): which transitions ping, which config switch gates them, DND, and project mute.

describe("attentionKind", () => {
  it("needs_input always qualifies; idle only after working", () => {
    expect(attentionKind("needs_input", "working")).toBe("needs_input");
    expect(attentionKind("needs_input", "idle")).toBe("needs_input");
    expect(attentionKind("idle", "working")).toBe("done");
    expect(attentionKind("idle", "starting")).toBeNull();
    expect(attentionKind("idle", "needs_input")).toBeNull();
    expect(attentionKind("working", "idle")).toBeNull();
    expect(attentionKind("exited", "working")).toBeNull();
    expect(attentionKind("error", "working")).toBeNull();
  });
});

describe("attentionConfigKey", () => {
  it("maps kinds to the notifications switches", () => {
    expect(attentionConfigKey("needs_input")).toBe("agent-needs-input");
    expect(attentionConfigKey("done")).toBe("agent-done");
  });
});

describe("isDndActive / configValue", () => {
  it("DND is on only while dnd-until is in the future", () => {
    expect(isDndActive(2_000, 1_000)).toBe(true);
    expect(isDndActive(1_000, 1_000)).toBe(false);
    expect(isDndActive(0, 1_000)).toBe(false);
    expect(isDndActive("soon", 1_000)).toBe(false);
    expect(isDndActive(undefined, 1_000)).toBe(false);
  });
  it("reads dotted keys out of the config object", () => {
    const config = { notifications: { "dnd-until": 1234, "agent-needs-input": false } };
    expect(configValue(config, "notifications.dnd-until")).toBe(1234);
    expect(configValue(config, "notifications.agent-needs-input")).toBe(false);
    expect(configValue(config, "notifications.missing.deep")).toBeUndefined();
    expect(configValue(null, "a.b")).toBeUndefined();
  });
});

describe("projectMuted", () => {
  const state = (muted: boolean, hasTask = true) =>
    ({
      projects: {
        tasks: hasTask ? { "task-1": { project_id: "p1" } } : {},
        projects: { p1: { is_muted: muted } },
      },
    }) as unknown as RootState;

  it("mutes only tasks whose project is muted", () => {
    expect(projectMuted(state(true), "task-1")).toBe(true);
    expect(projectMuted(state(false), "task-1")).toBe(false);
    expect(projectMuted(state(true, false), "task-1")).toBe(false);
    expect(projectMuted(state(true), null)).toBe(false);
  });
});
