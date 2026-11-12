import { describe, expect, it } from "vitest";
import { formatCost, formatTokens } from "../../src/usage/format";

describe("usage formatting", () => {
  it("keeps small token counts whole and abbreviates large ones", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(15_400)).toBe("15k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
    expect(formatTokens(25_000_000)).toBe("25M");
  });
  it("formats cost in dollars with a floor for tiny amounts", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(0.424)).toBe("$0.42");
    expect(formatCost(12.3)).toBe("$12.30");
  });
});
