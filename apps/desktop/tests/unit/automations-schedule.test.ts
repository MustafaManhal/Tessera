import { describe, expect, it } from "vitest";
import { describeCron, untilText } from "../../src/automations/schedule";

describe("automation schedules", () => {
  it("names the common expressions and leaves the rest as written", () => {
    expect(describeCron("* * * * *")).toBe("Every minute");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("0 * * * *")).toBe("Every hour");
    expect(describeCron("30 9 * * *")).toBe("Every day at 09:30");
    expect(describeCron("0 9 * * 1-5")).toBe("Weekdays at 09:00");
    expect(describeCron("0 22 * * 0")).toBe("Sundays at 22:00");
    expect(describeCron("5 4 1 * *")).toBe("5 4 1 * *");
    expect(describeCron("bad")).toBe("bad");
  });
  it("says how far away a time is", () => {
    expect(untilText(100, 100)).toBe("now");
    expect(untilText(130, 100)).toBe("in a minute");
    expect(untilText(100 + 600, 100)).toBe("in 10 min");
    expect(untilText(100 + 7200, 100)).toBe("in 2 h");
  });
});
