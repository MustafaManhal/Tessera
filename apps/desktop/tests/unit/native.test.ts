import { describe, expect, it, vi } from "vitest";
import type { SecureKeyboardState } from "@tessera/ipc";
import { bindings } from "../../src/actions/registry";
import { createProgressSink } from "../../src/native/progress";
import {
  readSecureKeyboardEntry,
  setSecureKeyboardEntry,
  type SecureKeyboardCommands,
} from "../../src/native/secureKeyboardEntry";
import { focusMainWindow } from "../../src/native/window";

describe("native window adapters", () => {
  it("maps pane progress to native window states and deduplicates updates", async () => {
    const set = vi.fn(async () => {});
    const sink = createProgressSink({ set }, () => true);

    await sink.set({ state: "normal", value: 42 });
    await sink.set({ state: "normal", value: 42 });
    await sink.set({ state: "indeterminate", value: null });
    await sink.set(null);

    expect(set.mock.calls).toEqual([
      ["normal", 42],
      ["indeterminate", 0],
      ["none", 0],
    ]);
  });

  it("coalesces concurrent identical native progress updates", async () => {
    let finish: () => void = () => {};
    const set = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const sink = createProgressSink({ set }, () => true);

    const first = sink.set({ state: "normal", value: 42 });
    const duplicate = sink.set({ state: "normal", value: 42 });

    await vi.waitFor(() => expect(set).toHaveBeenCalledOnce());
    finish();
    await Promise.all([first, duplicate]);
    expect(set).toHaveBeenCalledOnce();
  });

  it("does not call native progress commands in browser and test runtimes", async () => {
    const set = vi.fn(async () => {});
    const sink = createProgressSink({ set }, () => false);

    await sink.set({ state: "normal", value: 10 });
    await sink.set(null);

    expect(set).not.toHaveBeenCalled();
  });

  it("reads and changes secure keyboard entry through the native binding client", async () => {
    const calls: string[] = [];
    let enabled = false;
    const client: SecureKeyboardCommands = {
      async getState() {
        calls.push("get");
        return { status: "supported", enabled };
      },
      async set(value) {
        calls.push(`set:${value}`);
        enabled = value;
        return { status: "supported", enabled };
      },
    };

    expect(await readSecureKeyboardEntry(client, "mac", true)).toBe(false);
    expect(await setSecureKeyboardEntry(true, client, "mac", true)).toBe(true);
    expect(calls).toEqual(["get", "set:true"]);
  });

  it("coalesces a repeated secure keyboard update while the native command is pending", async () => {
    let finish: (state: SecureKeyboardState) => void = () => {};
    const client: SecureKeyboardCommands = {
      getState: async () => ({ status: "supported", enabled: false }),
      set: vi.fn(
        (_enabled: boolean) =>
          new Promise<SecureKeyboardState>((resolve) => {
            finish = resolve;
          }),
      ),
    };

    const first = setSecureKeyboardEntry(true, client, "mac", true);
    const duplicate = setSecureKeyboardEntry(true, client, "mac", true);

    expect(client.set).toHaveBeenCalledOnce();
    finish({ status: "supported", enabled: true });
    await expect(Promise.all([first, duplicate])).resolves.toEqual([true, true]);
  });

  it("does not query or set secure keyboard entry on Windows or in a browser", async () => {
    const client: SecureKeyboardCommands = {
      getState: vi.fn(async () => ({ status: "unsupported" as const })),
      set: vi.fn(async () => ({ status: "unsupported" as const })),
    };

    expect(await readSecureKeyboardEntry(client, "windows", true)).toBeNull();
    expect(await setSecureKeyboardEntry(true, client, "windows", true)).toBeNull();
    expect(await readSecureKeyboardEntry(client, "mac", false)).toBeNull();
    expect(client.getState).not.toHaveBeenCalled();
    expect(client.set).not.toHaveBeenCalled();
  });

  it("does not expose secure keyboard entry when native reports it unsupported", async () => {
    const client: SecureKeyboardCommands = {
      getState: async () => ({ status: "unsupported" }),
      set: async () => ({ status: "unsupported" }),
    };

    expect(await readSecureKeyboardEntry(client, "mac", true)).toBeNull();
    expect(await setSecureKeyboardEntry(true, client, "mac", true)).toBeNull();
  });

  it("only binds the secure keyboard action on macOS", () => {
    expect(bindings("mac").some((binding) => binding.action.id === "terminal.secureKeyboardEntry")).toBe(true);
    expect(bindings("windows").some((binding) => binding.action.id === "terminal.secureKeyboardEntry")).toBe(false);
  });

  it("uses the native main-window focus binding when enabled", async () => {
    const focusMain = vi.fn(async () => {});
    await focusMainWindow(true, { focusMain });
    await focusMainWindow(false, { focusMain });
    expect(focusMain).toHaveBeenCalledTimes(1);
  });
});
