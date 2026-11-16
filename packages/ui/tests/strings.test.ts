import { describe, expect, it } from "vitest";
import { cn } from "../src/cn";
import { statuses, statusMeta } from "../src/status";
import { strings, t } from "../src/strings";

describe("t", () => {
  it("returns the catalog text", () => {
    expect(t("status.needs")).toBe("Needs you");
  });

  it("fills placeholders it has values for and leaves the rest", () => {
    expect(t("toast.region", { hotkey: "F8" })).toBe("Notifications (F8)");
    expect(t("toast.region")).toBe("Notifications ({hotkey})");
    expect(t("toast.region", { other: "x" })).toBe("Notifications ({hotkey})");
  });

  it("has no empty strings", () => {
    for (const [key, value] of Object.entries(strings)) expect(value.trim(), key).not.toBe("");
  });
});

describe("statusMeta", () => {
  it("pairs every status with an icon, a catalog label and its colour tokens", () => {
    for (const status of statuses) {
      const meta = statusMeta[status];
      expect(meta.icon).toBeDefined();
      expect(meta.label in strings).toBe(true);
      expect(meta.color).toBe(`text-st-${status}`);
      expect(meta.tint).toBe(`bg-st-${status}-tint`);
    }
  });

  it("gives each status its own icon", () => {
    expect(new Set(statuses.map((s) => statusMeta[s].icon)).size).toBe(statuses.length);
  });
});

describe("cn", () => {
  it("keeps the last of two conflicting theme classes", () => {
    expect(cn("shadow-popover", "shadow-dialog")).toBe("shadow-dialog");
    expect(cn("text-muted", "text-fg")).toBe("text-fg");
    expect(cn("rounded-md", "rounded-xl")).toBe("rounded-xl");
    expect(cn("bg-surface", "bg-surface-2")).toBe("bg-surface-2");
  });

  it("keeps classes that do not conflict", () => {
    expect(cn("text-sm", "text-muted")).toBe("text-sm text-muted");
    expect(cn("text-base", "text-fg", false, undefined)).toBe("text-base text-fg");
  });
});
