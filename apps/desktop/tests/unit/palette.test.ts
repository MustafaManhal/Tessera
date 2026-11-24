import { describe, expect, it } from "vitest";
import { actions } from "../../src/actions/registry";
import { fuzzyMatch, rank } from "../../src/palette/fuzzy";
import { type Entry, highlightRuns, paletteSections } from "../../src/palette/sections";

describe("fuzzyMatch", () => {
  it("matches characters in order, case-insensitively, and returns their positions", () => {
    expect(fuzzyMatch("spr", "Split right")?.indices).toEqual([0, 1, 6]);
    expect(fuzzyMatch("SPLIT", "split down")?.indices).toEqual([0, 1, 2, 3, 4]);
  });

  it("returns null when the characters are not all there in order", () => {
    expect(fuzzyMatch("xyz", "Split right")).toBeNull();
    expect(fuzzyMatch("thgir", "right")).toBeNull();
    expect(fuzzyMatch("longer than the text", "short")).toBeNull();
  });

  it("an empty query matches everything with no highlight", () => {
    expect(fuzzyMatch("  ", "anything")).toEqual({ score: 0, indices: [] });
  });

  it("prefers a prefix and word starts over scattered letters", () => {
    const prefix = fuzzyMatch("new", "New tab")?.score ?? 0;
    const scattered = fuzzyMatch("new", "Rename window")?.score ?? 0;
    expect(prefix).toBeGreaterThan(scattered);
    const wordStarts = fuzzyMatch("sr", "Split right")?.score ?? 0;
    const inside = fuzzyMatch("sr", "Usurp")?.score ?? 0;
    expect(wordStarts).toBeGreaterThan(inside);
  });
});

describe("rank", () => {
  const labels = ["Rename tab", "New tab", "Next tab", "Zoom pane"];
  it("orders by score, keeps ties in their original order, and drops non-matches", () => {
    const ranked = rank("tab", labels, (label) => label).map((r) => r.item);
    expect(ranked).toHaveLength(3);
    expect(ranked).not.toContain("Zoom pane");
    expect(rank("n", ["Next tab", "New tab"], (l) => l).map((r) => r.item)).toEqual(["Next tab", "New tab"]);
  });

  it("falls back to keywords, scored lower and not highlighted", () => {
    const ranked = rank(
      "maximize",
      ["Zoom pane", "Maximize window"],
      (label) => label,
      (label) => (label === "Zoom pane" ? ["maximize"] : []),
    );
    expect(ranked.map((r) => r.item)).toEqual(["Maximize window", "Zoom pane"]);
    expect(ranked[1]?.match.indices).toEqual([]);
  });
});

describe("highlightRuns", () => {
  it("groups matched and unmatched characters", () => {
    expect(highlightRuns("Split", [0, 1, 4])).toEqual([
      { start: 0, text: "Sp", hit: true },
      { start: 2, text: "li", hit: false },
      { start: 4, text: "t", hit: true },
    ]);
  });
});

describe("paletteSections", () => {
  const entries: Entry[] = actions.map((action) => ({ action, label: action.id, available: { ok: true } }));

  it("lists recent actions first, most recent first, without repeating them in their groups", () => {
    const sections = paletteSections("", entries, ["pane.zoom", "tab.new"]);
    expect(sections[0]?.heading).toBe("group.recent");
    expect(sections[0]?.items.map((item) => item.entry.action.id)).toEqual(["pane.zoom", "tab.new"]);
    const rest = sections.slice(1).flatMap((section) => section.items.map((item) => item.entry.action.id));
    expect(rest).not.toContain("pane.zoom");
    expect(rest).not.toContain("tab.new");
    expect(sections.slice(1).map((section) => section.heading)).toEqual([
      "group.tabs",
      "group.panes",
      "group.projects",
      "group.terminal",
      "group.view",
    ]);
  });

  it("has no recent section when nothing was run, and ignores unknown recent ids", () => {
    expect(paletteSections("", entries, [])[0]?.heading).toBe("group.tabs");
    expect(paletteSections("", entries, ["gone"])[0]?.heading).toBe("group.tabs");
  });

  it("treats a leading > as the actions prefix", () => {
    const withPrefix = paletteSections("> tab.new", entries, []);
    const without = paletteSections("tab.new", entries, []);
    expect(withPrefix).toEqual(without);
    expect(withPrefix[0]?.items[0]?.entry.action.id).toBe("tab.new");
  });

  it("returns nothing when nothing matches", () => {
    expect(paletteSections("qqqqzzzz", entries, [])).toEqual([]);
  });
});
