import { describe, expect, it } from "vitest";
import {
  cleanText,
  createKittyNotifications,
  NOTIFY_MAX_CHARS,
  parseOsc9,
  parseOsc777,
  parseProgress,
} from "../../src/osc";

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe("OSC 9", () => {
  it("is a notification with the text as the body", () => {
    expect(parseOsc9("Build finished")).toEqual({
      kind: "notify",
      request: { title: "", body: "Build finished", occasion: "always", urgency: 1 },
    });
  });

  it("routes 9;4 to progress and 9;9 to the cwd, and never notifies for ConEmu's other codes", () => {
    expect(parseOsc9("4;1;42")).toEqual({ kind: "progress", request: { kind: "set", state: "normal", value: 42 } });
    expect(parseOsc9('9;"C:\\Users\\me"')).toEqual({ kind: "cwd", path: "C:\\Users\\me" });
    expect(parseOsc9("1;500")).toBeNull();
    expect(parseOsc9("12")).toBeNull();
    expect(parseOsc9("4;9")).toBeNull();
  });

  it("rejects empty, control-only and too long text and cleans control characters", () => {
    expect(parseOsc9("")).toBeNull();
    expect(parseOsc9("\x1b\x07  ")).toBeNull();
    expect(parseOsc9("x".repeat(NOTIFY_MAX_CHARS + 1))).toBeNull();
    expect(parseOsc9("a\x1b[31mb\u009bc")).toMatchObject({ request: { body: "a [31mb c" } });
    expect(cleanText("  two\n\nlines ")).toBe("two lines");
  });

  it("keeps a number-looking message that is not a ConEmu code", () => {
    expect(parseOsc9("42 tests passed")).toMatchObject({ kind: "notify", request: { body: "42 tests passed" } });
    expect(parseOsc9("13;x")).toMatchObject({ kind: "notify" });
  });
});

describe("OSC 9;4 progress", () => {
  it("parses every state", () => {
    expect(parseProgress("0")).toEqual({ kind: "clear" });
    expect(parseProgress("0;50")).toEqual({ kind: "clear" });
    expect(parseProgress("1;75")).toEqual({ kind: "set", state: "normal", value: 75 });
    expect(parseProgress("1")).toEqual({ kind: "set", state: "normal", value: 0 });
    expect(parseProgress("2")).toEqual({ kind: "set", state: "error", value: null });
    expect(parseProgress("2;30")).toEqual({ kind: "set", state: "error", value: 30 });
    expect(parseProgress("3;10")).toEqual({ kind: "set", state: "indeterminate", value: null });
    expect(parseProgress("4;60")).toEqual({ kind: "set", state: "paused", value: 60 });
  });

  it("clamps above 100 and rejects malformed input", () => {
    expect(parseProgress("1;250")).toEqual({ kind: "set", state: "normal", value: 100 });
    for (const bad of ["", "5;1", "1;-3", "1;4.5", "x", "1;50;7", "1;1000", "01x"]) {
      expect(parseProgress(bad), bad).toBeNull();
    }
  });
});

describe("OSC 777", () => {
  it("parses notify;title;body (the body may contain semicolons)", () => {
    expect(parseOsc777("notify;Tests;3 failed; 12 passed")).toEqual({
      title: "Tests",
      body: "3 failed; 12 passed",
      occasion: "always",
      urgency: 1,
    });
    expect(parseOsc777("notify;Only a title")).toMatchObject({ title: "Only a title", body: "" });
  });

  it("ignores other 777 commands and empty ones", () => {
    expect(parseOsc777("precmd")).toBeNull();
    expect(parseOsc777("notify;;")).toBeNull();
    expect(parseOsc777(`notify;${"t".repeat(NOTIFY_MAX_CHARS)};b`)).toBeNull();
  });
});

describe("OSC 99 (kitty)", () => {
  it("shows a one-shot title", () => {
    const kitty = createKittyNotifications();
    expect(kitty.feed(";Hello")).toMatchObject({ title: "Hello", body: "" });
  });

  it("assembles chunks with the same id, title then body", () => {
    const kitty = createKittyNotifications();
    expect(kitty.feed("i=1:d=0;Build")).toBeNull();
    expect(kitty.pending).toBe(1);
    expect(kitty.feed("i=1:d=0; done")).toBeNull();
    expect(kitty.feed("i=1:p=body:u=2:o=always;All green")).toEqual({
      title: "Build done",
      body: "All green",
      occasion: "always",
      urgency: 2,
    });
    expect(kitty.pending).toBe(0);
  });

  it("decodes base64 payloads", () => {
    const kitty = createKittyNotifications();
    expect(kitty.feed(`e=1;${b64("Grüße ✓")}`)).toMatchObject({ title: "Grüße ✓" });
    expect(kitty.feed("e=1;***")).toBeNull();
  });

  it("drops malformed metadata, unsupported payload types, close and oversized text", () => {
    const kitty = createKittyNotifications();
    expect(kitty.feed("no separator")).toBeNull();
    expect(kitty.feed("bad;x")).toBeNull();
    expect(kitty.feed("ii=1;x")).toBeNull();
    expect(kitty.feed("i=a b;x")).toBeNull();
    expect(kitty.feed("p=?;")).toBeNull();
    expect(kitty.feed("p=icon;abc")).toBeNull();
    expect(kitty.feed("i=2:d=0;half")).toBeNull();
    expect(kitty.feed("i=2:p=close;")).toBeNull();
    expect(kitty.pending).toBe(0);
    expect(kitty.feed(`;${"x".repeat(NOTIFY_MAX_CHARS * 2 + 1)}`)).toBeNull();
    expect(kitty.feed(`i=3:d=0;${"x".repeat(NOTIFY_MAX_CHARS)}`)).toBeNull();
    expect(kitty.feed("i=3;more")).toBeNull();
  });

  it("keeps at most 8 unfinished ids", () => {
    const kitty = createKittyNotifications();
    for (let i = 0; i < 20; i++) kitty.feed(`i=${i}:d=0;t`);
    expect(kitty.pending).toBe(8);
  });
});
