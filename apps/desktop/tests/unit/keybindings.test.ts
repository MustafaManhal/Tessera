import { afterEach, describe, expect, it } from "vitest";
import { chordFromEvent, formatChord, normalizeChord, parseChordText, sameChord } from "../../src/actions/chord";
import { conflictsFor, detectConflicts, isBareTextKey, reservedReason } from "../../src/actions/conflicts";
import { parseTomlSnippet, toToml } from "../../src/actions/keybindingToml";
import { keymap } from "../../src/actions/keymap";
import { MAC_PRESET, presetFor, TERMINAL_SAFE_PRESET, WINDOWS_PRESET } from "../../src/actions/presets";
import { actions, bindings, primaryShortcut, shortcutsFor } from "../../src/actions/registry";
import { resolveBindings } from "../../src/actions/shortcuts";

afterEach(() => keymap.reset());

function need<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("missing");
  return value;
}

describe("chord text", () => {
  it("normalises aliases, case and modifier order", () => {
    expect(normalizeChord("cmd+shift+p")).toBe("Cmd+Shift+P");
    expect(normalizeChord("Shift+Mod+P")).toBe("Mod+Shift+P");
    expect(normalizeChord("control+option+left")).toBe("Ctrl+Alt+Left");
    expect(normalizeChord("Ctrl+Esc")).toBe("Ctrl+Escape");
    expect(normalizeChord("super+return")).toBe("Cmd+Enter");
    expect(normalizeChord("alt+f12")).toBe("Alt+F12");
    expect(normalizeChord("  mod + k ")).toBe("Mod+K");
    expect(normalizeChord("Mod+PageDown")).toBe("Mod+PageDown");
  });

  it("reads the + key and punctuation", () => {
    expect(normalizeChord("Mod++")).toBe("Mod++");
    expect(normalizeChord("Mod+Plus")).toBe("Mod++");
    expect(normalizeChord("Mod+Shift+=")).toBe("Mod++");
    expect(normalizeChord("Ctrl+,")).toBe("Ctrl+,");
    expect(normalizeChord("Mod+/")).toBe("Mod+/");
    expect(normalizeChord("Mod+minus")).toBe("Mod+-");
    expect(sameChord("Mod++", "Mod+Shift+=")).toBe(true);
    expect(parseChordText("Ctrl+Shift+=")).toMatchObject({ ctrl: true, shift: false, key: "+" });
  });

  it("rejects what is not a chord", () => {
    for (const bad of [
      "",
      "   ",
      "Mod+",
      "Mod+Nope",
      "Hyper+K",
      "Mod+Mod+K",
      "Mod+K+L",
      "K+Mod",
      "Mod+F25",
      "Mod+F0",
      "Ctrl+Shift",
      "Mod+ +K",
    ]) {
      expect(normalizeChord(bad), bad).toBeNull();
    }
    expect(normalizeChord(5 as unknown as string)).toBeNull();
  });

  it("compares chords by meaning", () => {
    expect(sameChord("cmd+k", "Cmd+K")).toBe(true);
    expect(sameChord("Mod+K", "Cmd+K")).toBe(false);
    expect(sameChord("junk", "junk")).toBe(false);
    expect(formatChord({ mod: true, meta: false, ctrl: false, alt: false, shift: true, key: "P" })).toBe("Mod+Shift+P");
  });

  it("records a key press as a chord, Mod being the platform's command key", () => {
    const press = (code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>>) => ({
      code,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...mods,
    });
    const text = (event: ReturnType<typeof press>, platform: "mac" | "windows") => {
      const spec = chordFromEvent(event, platform);
      return spec ? formatChord(spec) : null;
    };
    expect(text(press("KeyP", { metaKey: true, shiftKey: true }), "mac")).toBe("Mod+Shift+P");
    expect(text(press("KeyP", { ctrlKey: true, shiftKey: true }), "windows")).toBe("Mod+Shift+P");
    expect(text(press("KeyP", { ctrlKey: true }), "mac")).toBe("Ctrl+P");
    expect(text(press("KeyP", { metaKey: true }), "windows")).toBe("Cmd+P");
    expect(text(press("Digit5", { altKey: true }), "mac")).toBe("Alt+5");
    expect(text(press("ArrowUp", { ctrlKey: true, shiftKey: true }), "windows")).toBe("Mod+Shift+Up");
    expect(text(press("Comma", { metaKey: true }), "mac")).toBe("Mod+,");
    expect(text(press("Equal", { ctrlKey: true, shiftKey: true }), "windows")).toBe("Mod++");
    expect(text(press("F5", {}), "mac")).toBe("F5");
    // A modifier on its own, or a key we do not name, records nothing.
    expect(text(press("ShiftLeft", { shiftKey: true }), "mac")).toBeNull();
    expect(text(press("MetaLeft", { metaKey: true }), "mac")).toBeNull();
    expect(text(press("IntlRo", {}), "mac")).toBeNull();
    expect(text(press("", {}), "mac")).toBeNull();
  });
});

describe("conflicts", () => {
  it("finds the same chord on two actions in one scope, but not across scopes", () => {
    const found = detectConflicts(
      [
        { actionId: "a", keys: "Mod+Shift+K" },
        { actionId: "b", keys: "shift+mod+k" },
        { actionId: "c", keys: "Delete", scope: "tabStrip" },
        { actionId: "d", keys: "Delete" },
        { actionId: "e", keys: "Mod+Alt+J" },
      ],
      "windows",
    );
    expect(found).toEqual([{ kind: "duplicate", keys: "Ctrl+Shift+K", scope: "global", actions: ["a", "b"] }]);
  });

  it("flags chords that steal the shell's keys", () => {
    const spec = (text: string) => need(parseChordText(text));
    expect(reservedReason(spec("Ctrl+C"), "windows")).toBe("controlKey");
    expect(reservedReason(spec("Mod+C"), "windows")).toBe("controlKey");
    expect(reservedReason(spec("Mod+C"), "mac")).toBeNull();
    expect(reservedReason(spec("Ctrl+C"), "mac")).toBe("controlKey");
    expect(reservedReason(spec("Ctrl+Shift+C"), "windows")).toBeNull();
    expect(reservedReason(spec("Ctrl+1"), "windows")).toBeNull();
    expect(reservedReason(spec("Escape"), "mac")).toBe("escape");
    expect(reservedReason(spec("Tab"), "mac")).toBe("editing");
    expect(reservedReason(spec("Shift+Tab"), "mac")).toBeNull();
  });

  it("flags text keys without a modifier, and allows F-keys and arrows", () => {
    const spec = (text: string) => need(parseChordText(text));
    expect(isBareTextKey(spec("A"))).toBe(true);
    expect(isBareTextKey(spec("Shift+A"))).toBe(true);
    expect(isBareTextKey(spec("Space"))).toBe(true);
    expect(isBareTextKey(spec("Alt+A"))).toBe(false);
    expect(isBareTextKey(spec("F5"))).toBe(false);
    expect(isBareTextKey(spec("Up"))).toBe(false);
    const found = detectConflicts(
      [
        { actionId: "x", keys: "Q" },
        { actionId: "y", keys: "F6" },
      ],
      "mac",
    );
    expect(found).toEqual([{ kind: "noModifier", keys: "Q", actions: ["x"] }]);
  });

  it("the shipped presets have no conflicts at all", () => {
    for (const [platform, name] of [
      ["mac", "default"],
      ["windows", "default"],
      ["windows", "terminal-safe"],
    ] as const) {
      const table = presetFor(platform, name);
      const entries = Object.entries(table).flatMap(([actionId, list]) =>
        list.map((spec) =>
          typeof spec === "string" ? { actionId, keys: spec } : { actionId, keys: spec.keys, scope: spec.scope },
        ),
      );
      const found = detectConflicts(entries, platform);
      // Ctrl+F and Ctrl+K are the known Windows defaults that take readline keys; the safe preset is the cure.
      const allowed = platform === "windows" && name === "default" ? ["Mod+F", "Ctrl+F", "Ctrl+K"] : [];
      const rest = found.filter((conflict) => !(conflict.kind === "reserved" && allowed.includes(conflict.keys)));
      expect(rest, `${platform}/${name}`).toEqual([]);
    }
    expect(WINDOWS_PRESET["terminal.find"]).toEqual(["Ctrl+F"]);
    expect(TERMINAL_SAFE_PRESET["terminal.find"]).toEqual(["Ctrl+Shift+F"]);
    expect(MAC_PRESET["tab.new"]).toEqual(["Mod+T"]);
  });

  it("tells what a new chord for an action would clash with", () => {
    const existing = [
      { actionId: "tab.new", keys: "Mod+T" },
      { actionId: "tab.close", keys: "Mod+W" },
    ];
    expect(conflictsFor("pane.close", "Mod+W", existing, "mac")).toEqual([
      { kind: "duplicate", keys: "Cmd+W", scope: "global", actions: ["tab.close", "pane.close"] },
    ]);
    expect(conflictsFor("tab.new", "Mod+T", existing, "mac")).toEqual([]);
    expect(conflictsFor("tab.new", "Ctrl+C", existing, "windows")[0]?.kind).toBe("reserved");
  });
});

describe("keymap: presets and overrides", () => {
  it("every action has an entry in both presets (or none on purpose) and the registry follows them", () => {
    for (const action of actions) {
      expect(action.id in MAC_PRESET, action.id).toBe(true);
      expect(action.id in WINDOWS_PRESET, action.id).toBe(action.id !== "terminal.secureKeyboardEntry");
    }
    expect(shortcutsFor(need(actions.find((a) => a.id === "terminal.secureKeyboardEntry")), "windows")).toEqual([]);
    expect(shortcutsFor(need(actions.find((a) => a.id === "terminal.secureKeyboardEntry")), "mac")).toEqual([
      "Mod+Alt+Shift+K",
    ]);
    expect(shortcutsFor(need(actions.find((a) => a.id === "tab.new")), "mac")).toEqual(["Mod+T"]);
    expect(primaryShortcut("tab.new", "windows")).toBe("Ctrl+Shift+T");
  });

  it("applies an override live: the binding, the tooltip and the handler's table", () => {
    expect(primaryShortcut("tab.new", "windows")).toBe("Ctrl+Shift+T");
    const versionBefore = keymap.version();
    expect(keymap.setOverrides({ "tab.new": "cmd+alt+n" }, {}, "windows")).toEqual([]);
    expect(keymap.version()).toBeGreaterThan(versionBefore);
    expect(primaryShortcut("tab.new", "windows")).toBe("Cmd+Alt+N");
    const resolved = resolveBindings("windows").filter((binding) => binding.action.id === "tab.new");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.chord).toMatchObject({ meta: true, alt: true, code: "KeyN" });
    // The old default no longer fires the action.
    expect(bindings("windows").some((b) => b.action.id === "tab.new" && b.keys === "Ctrl+Shift+T")).toBe(false);
  });

  it("an empty value unbinds; a list binds several; scoped and native entries survive", () => {
    keymap.setOverrides(
      { "tab.new": "", "view.palette": ["Mod+P", "mod+shift+o"], "terminal.paste": "Mod+Shift+Y", "tab.rename": [] },
      {},
      "mac",
    );
    expect(shortcutsFor(need(actions.find((a) => a.id === "tab.new")), "mac")).toEqual([]);
    expect(shortcutsFor(need(actions.find((a) => a.id === "view.palette")), "mac")).toEqual(["Mod+P", "Mod+Shift+O"]);
    expect(bindings("mac").find((b) => b.action.id === "terminal.paste")).toMatchObject({
      keys: "Mod+Shift+Y",
      native: true,
    });
    // tab.rename keeps its tab-strip-only F2.
    expect(
      bindings("mac")
        .filter((b) => b.action.id === "tab.rename")
        .map((b) => [b.keys, b.scope]),
    ).toEqual([["F2", "tabStrip"]]);
  });

  it("ignores a bad chord with a problem report and keeps the default; other entries still apply", () => {
    const problems = keymap.setOverrides(
      {
        "tab.new": "Mod+Nope",
        "pane.close": ["Mod+Q", "???"],
        "no.such.action": "Mod+Z",
        "tab.close": 7,
        "view.sidebar": null,
      },
      {},
      "mac",
    );
    expect(problems).toEqual([
      { key: "tab.new", value: "Mod+Nope", reason: "invalidChord" },
      { key: "pane.close", value: "???", reason: "invalidChord" },
      { key: "no.such.action", value: "Mod+Z", reason: "unknownAction" },
      { key: "tab.close", value: "7", reason: "invalidValue" },
    ]);
    expect(primaryShortcut("tab.new", "mac")).toBe("Mod+T");
    expect(shortcutsFor(need(actions.find((a) => a.id === "pane.close")), "mac")).toEqual(["Mod+Q"]);
    expect(shortcutsFor(need(actions.find((a) => a.id === "view.sidebar")), "mac")).toEqual([]);
    expect(keymap.problems).toHaveLength(4);
  });

  it("the config's own defaults and a written default are not overrides; the palette alias works", () => {
    keymap.setOverrides(
      { "palette.open": ["Cmd+K", "Cmd+Shift+P"], "pane.splitRight": "Cmd+D" },
      { "palette.open": ["Cmd+K", "Cmd+Shift+P"], "pane.splitRight": "Cmd+D" },
      "windows",
    );
    expect(keymap.overrides).toEqual({});
    keymap.setOverrides({ "palette.open": "Ctrl+Shift+Y" }, { "palette.open": ["Cmd+K"] }, "windows");
    expect(primaryShortcut("view.palette", "windows")).toBe("Ctrl+Shift+Y");
    // "Reset" writes the default back: no longer custom.
    keymap.setOverrides({ "tab.new": "Ctrl+Shift+T" }, {}, "windows");
    expect(keymap.isCustom("tab.new")).toBe(false);
  });

  it("the Terminal-safe preset moves Ctrl+F and Ctrl+K on Windows only", () => {
    keymap.setPreset("terminal-safe");
    expect(primaryShortcut("terminal.find", "windows")).toBe("Ctrl+Shift+F");
    expect(primaryShortcut("view.palette", "windows")).toBe("Ctrl+Shift+P");
    expect(primaryShortcut("terminal.find", "mac")).toBe("Mod+F");
  });

  it("notifies subscribers once per real change", () => {
    let calls = 0;
    const off = keymap.subscribe(() => {
      calls += 1;
    });
    keymap.setOverrides({ "tab.new": "Mod+Q" }, {}, "mac");
    keymap.setOverrides({ "tab.new": "Mod+Q" }, {}, "mac");
    expect(calls).toBe(1);
    off();
  });
});

describe("TOML snippets", () => {
  it("round-trips overrides", () => {
    const text = toToml({ "view.palette": ["Mod+K", "Mod+Shift+P"], "tab.new": ["Mod+Alt+N"], "tab.close": [] });
    expect(text).toBe(
      '[keybindings]\n"tab.close" = []\n"tab.new" = "Mod+Alt+N"\n"view.palette" = ["Mod+K", "Mod+Shift+P"]\n',
    );
    const back = parseTomlSnippet(text);
    expect(back.errors).toEqual([]);
    expect(back.entries).toEqual({
      "tab.close": [],
      "tab.new": ["Mod+Alt+N"],
      "view.palette": ["Mod+K", "Mod+Shift+P"],
    });
  });

  it("normalises chords, accepts bare keys and comments, and reports bad lines with their number", () => {
    const parsed = parseTomlSnippet(
      '# mine\n[keybindings]\npane.splitRight = "cmd+d"  # split\n"tab.new" = ["ctrl+shift+t"]\nnot toml\n"x" = "Mod+Nope"\n"y" = 5\n"z" = ""\n',
    );
    expect(parsed.entries).toEqual({ "pane.splitRight": ["Cmd+D"], "tab.new": ["Ctrl+Shift+T"], z: [] });
    expect(parsed.errors.map((e) => e.line)).toEqual([5, 6, 7]);
    expect(parseTomlSnippet("").entries).toEqual({});
  });
});
