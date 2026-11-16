import { describe, expect, it } from "vitest";
import { WINDOWS_10_BUILD, WINDOWS_11_BUILD, windowsBuildFor } from "../../src/terminal/windowsBuild";

describe("windowsBuildFor", () => {
  it("reads Windows 11 from client hints 13 and up", () => {
    expect(windowsBuildFor("13.0.0")).toBe(WINDOWS_11_BUILD);
    expect(windowsBuildFor("15.0.0")).toBe(WINDOWS_11_BUILD);
  });

  it("treats Windows 10 and anything unreadable as the older ConPTY", () => {
    expect(windowsBuildFor("10.0.0")).toBe(WINDOWS_10_BUILD);
    expect(windowsBuildFor("")).toBe(WINDOWS_10_BUILD);
    expect(windowsBuildFor(undefined)).toBe(WINDOWS_10_BUILD);
    expect(WINDOWS_10_BUILD).toBeLessThan(21376);
    expect(WINDOWS_11_BUILD).toBeGreaterThanOrEqual(21376);
  });
});
