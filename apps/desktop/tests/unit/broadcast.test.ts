import { beforeEach, describe, expect, it, vi } from "vitest";

const terminals = vi.hoisted(() => new Map<string, { writeInput: (bytes: Uint8Array) => boolean }>());

vi.mock("../../src/terminal/panes", () => ({
  paneTerminal: (paneId: string) => terminals.get(paneId),
}));

import {
  broadcastInput,
  configureBroadcastRouting,
  isBroadcastPasteConfirmationOpen,
  setBroadcastPasteConfirmation,
} from "../../src/terminal/broadcast";

describe("broadcast input routing", () => {
  beforeEach(() => {
    terminals.clear();
    configureBroadcastRouting(null, null);
    setBroadcastPasteConfirmation("pane-1", false);
    setBroadcastPasteConfirmation("pane-2", false);
  });

  it("writes only to selected panes in the active broadcast tab", () => {
    const first = { writeInput: vi.fn(() => true) };
    const second = { writeInput: vi.fn(() => true) };
    const third = { writeInput: vi.fn(() => true) };
    terminals.set("pane-1", first);
    terminals.set("pane-2", second);
    terminals.set("pane-3", third);
    configureBroadcastRouting("tab-a", { tabId: "tab-a", paneIds: ["pane-1", "pane-3"] });
    const bytes = new Uint8Array([0x61]);

    expect(broadcastInput("tab-b", bytes)).toBe(false);
    expect(first.writeInput).not.toHaveBeenCalled();
    expect(second.writeInput).not.toHaveBeenCalled();
    expect(third.writeInput).not.toHaveBeenCalled();

    expect(broadcastInput("tab-a", bytes)).toBe(true);
    expect(first.writeInput).toHaveBeenCalledWith(bytes);
    expect(second.writeInput).not.toHaveBeenCalled();
    expect(third.writeInput).toHaveBeenCalledWith(bytes);
  });

  it("holds broadcast bytes while any paste confirmation is open and skips unmounted panes", () => {
    const first = { writeInput: vi.fn(() => true) };
    terminals.set("pane-1", first);
    configureBroadcastRouting("tab-a", { tabId: "tab-a", paneIds: ["pane-1", "pane-2"] });
    const bytes = new Uint8Array([0x62]);

    setBroadcastPasteConfirmation("pane-2", true);
    expect(isBroadcastPasteConfirmationOpen()).toBe(true);
    expect(broadcastInput("tab-a", bytes)).toBe(true);
    expect(first.writeInput).not.toHaveBeenCalled();

    setBroadcastPasteConfirmation("pane-2", false);
    expect(isBroadcastPasteConfirmationOpen()).toBe(false);
    expect(broadcastInput("tab-a", bytes)).toBe(true);
    expect(first.writeInput).toHaveBeenCalledWith(bytes);
  });
});
