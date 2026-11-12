import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FakeSettingsClient, SettingsError } from "../../src/settings/client";
import { configToTerminal, terminalPatchToConfig } from "../../src/settings/mapping";
import {
  flattenSchema,
  formatValue,
  getValue,
  type JsonSchema,
  matchesQuery,
  parseInput,
  patchFor,
} from "../../src/settings/schema";
import { startSettingsSync } from "../../src/settings/sync";
import { createAppStore } from "../../src/store";
import { setTerminal, defaultTerminalSettings } from "../../src/store/settingsSlice";

const real = JSON.parse(
  readFileSync(new URL("../../../../packages/ipc/schema/config.schema.json", import.meta.url), "utf8"),
) as JsonSchema;

function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing");
  return value;
}

describe("flattenSchema on the real config schema", () => {
  const fields = flattenSchema(real);
  const byKey = (key: string) => fields.find((field) => field.key === key);

  it("maps every shape to a kind", () => {
    expect(byKey("terminal.cursor-blink")).toMatchObject({ kind: "boolean", default: true });
    expect(byKey("terminal.scrollback")).toMatchObject({ kind: "integer", min: 0, max: 1_000_000, default: 10_000 });
    expect(byKey("font.size")).toMatchObject({ kind: "number", min: 6, max: 72 });
    expect(byKey("font.family")).toMatchObject({ kind: "string", default: "JetBrains Mono" });
    expect(byKey("font.features")).toMatchObject({ kind: "list", default: ["calt", "ss01"] });
    expect(byKey("terminal.cursor-style")).toMatchObject({ kind: "enum", default: "block" });
    expect(byKey("terminal.cursor-style")?.options?.map((option) => option.value)).toEqual([
      "block",
      "bar",
      "underline",
    ]);
    expect(byKey("appearance.window-opacity")).toMatchObject({ kind: "number", min: 0, max: 1, default: 1 });
    expect(byKey("appearance.background-blur")).toMatchObject({ kind: "boolean", default: true });
    expect(byKey("keybindings.palette.open")).toMatchObject({ kind: "chords" });
    expect(byKey("keybindings.pane.splitRight")?.kind).toBe("chords");
  });

  it("keeps the property description, not the definition's, and the section", () => {
    expect(byKey("terminal.osc52")).toMatchObject({
      section: "terminal",
      name: "osc52",
      description: "OSC 52 clipboard write permission.",
    });
  });

  it("covers every property of every section", () => {
    expect(fields.length).toBeGreaterThanOrEqual(35);
    expect(new Set(fields.map((field) => field.key)).size).toBe(fields.length);
  });
});

describe("flattenSchema on odd schemas", () => {
  it("falls back to read-only for unknown types and skips broken nodes", () => {
    const schema: JsonSchema = {
      properties: {
        a: {
          type: "object",
          properties: {
            weird: { type: "object" },
            objs: { type: "array", items: { type: "object" } },
            nothing: { description: "x" },
            bad: 5,
          },
        },
        b: { $ref: "#/$defs/Missing" },
        c: { $ref: "#/$defs/C" },
      },
      $defs: {
        C: { type: "object", properties: { mixed: { oneOf: [{ const: "x" }, { const: 3 }] }, ok: { type: "string" } } },
      },
    };
    const fields = flattenSchema(schema);
    expect(fields.map((field) => [field.key, field.kind])).toEqual([
      ["a.weird", "readonly"],
      ["a.objs", "readonly"],
      ["a.nothing", "readonly"],
      ["c.mixed", "readonly"],
      ["c.ok", "string"],
    ]);
  });
});

describe("values, patches, input", () => {
  it("reads dotted keys including names with dots", () => {
    const config = { terminal: { scrollback: 5 }, keybindings: { "palette.open": "Cmd+K" } };
    expect(getValue(config, "terminal.scrollback")).toBe(5);
    expect(getValue(config, "keybindings.palette.open")).toBe("Cmd+K");
    expect(getValue(config, "nope.x")).toBeUndefined();
    expect(getValue(null, "a.b")).toBeUndefined();
    expect(patchFor("keybindings.palette.open", "x")).toEqual({ keybindings: { "palette.open": "x" } });
  });

  it("parses typed text by kind and rejects bad numbers", () => {
    const fields = flattenSchema(real);
    const size = need(fields.find((field) => field.key === "font.size"));
    const lines = need(fields.find((field) => field.key === "terminal.scrollback"));
    const features = need(fields.find((field) => field.key === "font.features"));
    expect(parseInput(size, " 13.5 ")).toEqual({ value: 13.5 });
    expect(parseInput(size, "")).toEqual({ error: "invalidNumber" });
    expect(parseInput(size, "1e")).toEqual({ error: "invalidNumber" });
    expect(parseInput(lines, "2000")).toEqual({ value: 2000 });
    expect(parseInput(lines, "20.5")).toEqual({ error: "invalidInteger" });
    expect(parseInput(lines, "-3")).toEqual({ value: -3 });
    expect(parseInput(features, " calt, ss01 ,, ")).toEqual({ value: ["calt", "ss01"] });
    expect(formatValue(["a", "b"])).toBe("a, b");
    expect(formatValue(null)).toBe("");
  });

  it("searches label, key, description and enum values, all words", () => {
    const field = need(flattenSchema(real).find((candidate) => candidate.key === "terminal.cursor-style"));
    expect(matchesQuery(field, "Cursor style", "cursor")).toBe(true);
    expect(matchesQuery(field, "Cursor style", "terminal.cursor")).toBe(true);
    expect(matchesQuery(field, "Cursor style", "underline")).toBe(true);
    expect(matchesQuery(field, "Cursor style", "cursor shape")).toBe(true);
    expect(matchesQuery(field, "Cursor style", "cursor ligature")).toBe(false);
    expect(matchesQuery(field, "Cursor style", "  ")).toBe(true);
  });
});

describe("config ↔ terminal slice mapping", () => {
  const base = defaultTerminalSettings("mac");

  it("reads the mapped keys and keeps the rest", () => {
    const config = {
      font: { family: "Fira Code", size: 15, "line-height": 1.4, ligatures: true },
      terminal: {
        "cursor-style": "bar",
        "cursor-blink": false,
        scrollback: 500,
        "copy-on-select": true,
        "confirm-multiline-paste": false,
        osc52: "off",
        "long-command-notify-seconds": 90,
      },
    };
    expect(configToTerminal(config, base)).toMatchObject({
      fontFamily: "Fira Code",
      fontSize: 15,
      lineHeight: 1.4,
      ligatures: true,
      cursorStyle: "bar",
      cursorBlink: false,
      scrollback: 500,
      copyOnSelect: true,
      pasteConfirm: "never",
      osc52Write: "deny",
      longCommandSeconds: 90,
      longCommandAlert: true,
    });
  });

  it("ignores bad values, keeps 'always' while the config asks, and 0 turns the long alert off", () => {
    const out = configToTerminal(
      {
        font: { family: "  ", size: "big" },
        terminal: { "cursor-style": "blob", osc52: "weird", "long-command-notify-seconds": 0 },
      },
      { ...base, pasteConfirm: "always" },
    );
    expect(out.fontFamily).toBeUndefined();
    expect(out.fontSize).toBe(base.fontSize);
    expect(out.cursorStyle).toBeUndefined();
    expect(out.osc52Write).toBeUndefined();
    expect(out.pasteConfirm).toBe("always");
    expect(out.longCommandAlert).toBe(false);
    expect(configToTerminal({}, base).pasteConfirm).toBe("multiline");
  });

  it("builds the config patch only for mapped changes", () => {
    expect(terminalPatchToConfig(base, base)).toBeNull();
    expect(terminalPatchToConfig(base, { ...base, fontSize: 18, ligatures: true })).toEqual({
      font: { size: 18, ligatures: true },
    });
    expect(terminalPatchToConfig(base, { ...base, osc52Write: "deny", pasteConfirm: "never" })).toEqual({
      terminal: { osc52: "off", "confirm-multiline-paste": false },
    });
    // App-only keys never reach the config.
    expect(
      terminalPatchToConfig(base, {
        ...base,
        images: false,
        blockGutter: false,
        renderer: "dom",
        pasteConfirm: "always",
      }),
    ).toBeNull();
    expect(terminalPatchToConfig(base, { ...base, longCommandAlert: false })).toEqual({
      terminal: { "long-command-notify-seconds": 0 },
    });
  });
});

describe("FakeSettingsClient", () => {
  it("starts from the schema defaults, validates like Rust and emits changes", async () => {
    const client = new FakeSettingsClient(real);
    const seen: unknown[] = [];
    await client.onChanged((config) => seen.push(getValue(config, "font.size")));
    expect(getValue(await client.get(), "font.size")).toBe(13);
    await client.set({ font: { size: 20 } });
    expect(seen).toEqual([20]);
    await expect(client.set({ font: { size: 500 } })).rejects.toMatchObject({
      code: "config.invalid",
      key: "font.size",
    });
    await expect(client.set({ font: { size: "x" } })).rejects.toBeInstanceOf(SettingsError);
    await expect(client.set({ terminal: { "cursor-style": "blob" } })).rejects.toThrow(/expected one of/);
    await expect(client.set({ terminal: { scrollback: 1.5 } })).rejects.toThrow(/whole number/);
    await expect(client.set({ nope: { x: 1 } })).rejects.toMatchObject({ code: "config.unknown_key" });
    expect(client.value("font.size")).toBe(20);
  });
});

describe("startSettingsSync", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  it("loads the config, follows hand edits and writes app changes back once", async () => {
    const client = new FakeSettingsClient(real);
    const store = createAppStore();
    const stop = startSettingsSync(client, store);
    await settle();
    expect(store.getState().config.values).not.toBeNull();
    expect(store.getState().settings.terminal.fontSize).toBe(13);

    client.simulateHandEdit("font.size", 21);
    expect(store.getState().settings.terminal.fontSize).toBe(21);
    await settle();
    expect(client.patches).toEqual([]);

    store.dispatch(setTerminal({ fontSize: 17 }));
    store.dispatch(setTerminal({ fontSize: 18 }));
    await settle();
    expect(client.patches).toEqual([{ font: { size: 18 } }]);
    expect(store.getState().settings.terminal.fontSize).toBe(18);
    stop();
  });

  it("writes a big scrollback and ends on the file's value", async () => {
    const client = new FakeSettingsClient(real);
    const store = createAppStore();
    const stop = startSettingsSync(client, store);
    await settle();
    store.dispatch(setTerminal({ scrollback: 1_000_000 }));
    await settle();
    expect(client.value("terminal.scrollback")).toBe(1_000_000);
    stop();
  });
});
