import { IpcError } from "@tessera/ipc";
import { describe, expect, it, vi } from "vitest";
import { createWindowEffectClient, isWindowEffectUnsupported, type WindowEffect } from "../../src/native/windowEffect";

describe("native window effect adapter", () => {
  it("maps configured blur to native effect kinds through its client", async () => {
    const set = vi.fn(async (_kind: WindowEffect) => {});
    const client = createWindowEffectClient({ set });

    await client.set("blur");
    await client.set("none");

    expect(set.mock.calls).toEqual([["blur"], ["none"]]);
  });

  it("recognizes the explicit unsupported-effect error", () => {
    expect(isWindowEffectUnsupported(new IpcError("window.effect_unsupported", "not supported"))).toBe(true);
    expect(isWindowEffectUnsupported(new IpcError("window.failed", "failed"))).toBe(false);
  });
});
