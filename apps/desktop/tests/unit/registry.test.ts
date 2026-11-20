import { strings } from "@tessera/ui";
import { describe, expect, it } from "vitest";
import { chordId, parseChord } from "../../src/actions/keys";
import { actions, bindings, GROUP_LABELS, primaryShortcut, shortcutsFor } from "../../src/actions/registry";

const PLATFORMS = ["mac", "windows"] as const;

describe("action registry", () => {
  it("has unique ids", () => {
    const ids = actions.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("labels every action, group and alternate label from the catalog", () => {
    for (const action of actions) {
      expect(action.label in strings, action.id).toBe(true);
      expect(GROUP_LABELS[action.group] in strings, action.id).toBe(true);
    }
    expect(Object.keys(GROUP_LABELS).sort()).toEqual(["panes", "projects", "tabs", "terminal", "view"]);
  });

  it.each(PLATFORMS)("gives every action a shortcut on %s, and every shortcut parses", (platform) => {
    for (const action of actions) {
      const keys = shortcutsFor(action, platform);
      if (action.id === "terminal.secureKeyboardEntry" && platform === "windows") {
        expect(keys, action.id).toEqual([]);
        continue;
      }
      expect(keys.length, action.id).toBeGreaterThan(0);
      for (const shortcut of keys) expect(parseChord(shortcut, platform), `${action.id}: ${shortcut}`).not.toBeNull();
    }
  });

  it.each(PLATFORMS)("never binds one chord twice in the same scope on %s", (platform) => {
    const seen = new Map<string, string>();
    for (const binding of bindings(platform)) {
      const chord = parseChord(binding.keys, platform);
      if (!chord) continue;
      const id = `${binding.scope ?? "global"}:${chordId(chord)}`;
      expect(seen.get(id), `${id} is used by ${seen.get(id)} and ${binding.action.id}`).toBeUndefined();
      seen.set(id, binding.action.id);
    }
  });

  it("follows the documented defaults (04-app-flow F-03, brief 03)", () => {
    const mac = (id: string) => primaryShortcut(id, "mac");
    const pc = (id: string) => primaryShortcut(id, "windows");
    expect([mac("tab.new"), pc("tab.new")]).toEqual(["Mod+T", "Ctrl+Shift+T"]);
    expect([mac("pane.splitRight"), pc("pane.splitRight")]).toEqual(["Mod+D", "Ctrl+Shift+D"]);
    expect([mac("pane.splitDown"), pc("pane.splitDown")]).toEqual(["Mod+Shift+D", "Ctrl+Shift+E"]);
    expect([mac("pane.focusLeft"), pc("pane.focusLeft")]).toEqual(["Mod+Alt+Left", "Ctrl+Alt+Left"]);
    expect([mac("pane.zoom"), pc("pane.zoom")]).toEqual(["Mod+Shift+Enter", "Ctrl+Shift+Enter"]);
    expect([mac("pane.close"), pc("pane.close")]).toEqual(["Mod+W", "Ctrl+Shift+W"]);
    expect([mac("tab.next"), pc("tab.next")]).toEqual(["Mod+Shift+]", "Ctrl+Tab"]);
    expect([mac("tab.goTo1"), pc("tab.goTo1")]).toEqual(["Mod+1", "Ctrl+1"]);
    const palette = actions.find((a) => a.id === "view.palette");
    expect(palette && shortcutsFor(palette, "mac")).toEqual(["Mod+K", "Mod+Shift+P"]);
    expect(mac("view.shortcuts")).toBe("Mod+/");
  });

  it("has an action for every layout change the brief lists", () => {
    const ids = new Set(actions.map((action) => action.id));
    for (const id of [
      "tab.new",
      "tab.close",
      "tab.next",
      "tab.previous",
      "tab.goTo1",
      "tab.goToLast",
      "pane.splitRight",
      "pane.splitDown",
      "pane.close",
      "pane.focusLeft",
      "pane.focusRight",
      "pane.focusUp",
      "pane.focusDown",
      "pane.resizeLeft",
      "pane.equalize",
      "pane.zoom",
      "view.sidebar",
      "tab.rename",
      "tab.pin",
      "tab.reopen",
      "view.palette",
      "view.shortcuts",
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it("returns undefined for an unknown action", () => {
    expect(primaryShortcut("no.such.action", "mac")).toBeUndefined();
  });
});
