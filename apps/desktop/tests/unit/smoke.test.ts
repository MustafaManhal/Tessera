import { describe, expect, it } from "vitest";
import { DEFAULT_DEV_PORT, parseDevPort, resolveDevPort } from "../../../../scripts/lib/port.mjs";

describe("parseDevPort", () => {
  it("parses a valid port", () => {
    expect(parseDevPort("1421")).toBe(1421);
    expect(parseDevPort(" 1422 ")).toBe(1422);
  });

  it("rejects a non-number", () => {
    expect(parseDevPort("abc")).toBeUndefined();
    expect(parseDevPort("14x1")).toBeUndefined();
  });

  it("rejects negative, zero and out-of-range values", () => {
    expect(parseDevPort("-1")).toBeUndefined();
    expect(parseDevPort("0")).toBeUndefined();
    expect(parseDevPort("70000")).toBeUndefined();
  });
});

describe("resolveDevPort", () => {
  it("uses the default when unset", () => {
    expect(resolveDevPort(undefined)).toBe(DEFAULT_DEV_PORT);
    expect(resolveDevPort("")).toBe(1420);
  });

  it("returns a valid port", () => {
    expect(resolveDevPort("1421")).toBe(1421);
  });

  it("throws on an invalid value instead of guessing", () => {
    expect(() => resolveDevPort("abc")).toThrow(/TESSERA_DEV_PORT/);
  });
});
