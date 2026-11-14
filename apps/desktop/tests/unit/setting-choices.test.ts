import { describe, expect, it } from "vitest";
import { choiceSetFor, parseChoice, withCurrent } from "../../src/settings/choices";

describe("setting choices", () => {
  it("covers every setting that used to be typed", () => {
    for (const key of [
      "editor.command",
      "shell.default",
      "font.family",
      "font.size",
      "font.line-height",
      "appearance.ui-zoom",
      "appearance.window-opacity",
      "appearance.dim-unfocused",
      "appearance.padding",
      "quick-terminal.hotkey",
      "quick-terminal.height",
      "worktrees.branch-prefix",
      "worktrees.dir",
      "terminal.scrollback",
      "terminal.long-command-notify-seconds",
    ]) {
      expect(choiceSetFor(key), key).not.toBeNull();
    }
  });

  it("keeps a value from an older config selectable as Custom", () => {
    const set = choiceSetFor("font.size");
    if (!set) throw new Error("missing");
    const choices = withCurrent(set, 17);
    expect(choices[0]).toEqual({ value: "17", label: "Custom: 17" });
    expect(withCurrent(set, 13)).toBe(set.choices);
  });

  it("parses numbers back to numbers", () => {
    const set = choiceSetFor("appearance.ui-zoom");
    if (!set) throw new Error("missing");
    expect(parseChoice(set, "1.25")).toBe(1.25);
    const text = choiceSetFor("shell.default");
    if (!text) throw new Error("missing");
    expect(parseChoice(text, "zsh")).toBe("zsh");
  });
});
