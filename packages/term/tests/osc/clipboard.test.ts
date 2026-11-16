import { describe, expect, it } from "vitest";
import { decideOsc52, OSC52_MAX_BYTES, parseOsc52 } from "../../src/osc";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("OSC 52", () => {
  it("decodes a write (UTF-8) for any selection target", () => {
    expect(parseOsc52(`c;${b64("hello ✓")}`)).toEqual({ kind: "write", text: "hello ✓" });
    expect(parseOsc52(`;${b64("x")}`)).toEqual({ kind: "write", text: "x" });
    expect(parseOsc52(`cps01;${b64("x")}`)).toEqual({ kind: "write", text: "x" });
  });

  it("recognises reads and clears", () => {
    expect(parseOsc52("c;?")).toEqual({ kind: "read" });
    expect(parseOsc52("c;")).toEqual({ kind: "clear" });
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "c", "z;aGk=", "c;not base64!", "c;a", "c;aGk=x"]) {
      expect(parseOsc52(bad).kind, bad).toBe("invalid");
    }
  });

  it("caps writes at 1 MiB without decoding them", () => {
    const big = "A".repeat(Math.ceil(((OSC52_MAX_BYTES + 3) * 4) / 3 / 4) * 4);
    expect(parseOsc52(`c;${big}`)).toMatchObject({ kind: "tooLarge" });
    const fits = b64("a".repeat(OSC52_MAX_BYTES));
    expect(parseOsc52(`c;${fits}`).kind).toBe("write");
  });

  it("follows the policy for writes and always drops reads", () => {
    const write = parseOsc52(`c;${b64("x")}`);
    expect(decideOsc52(write, "allow")).toBe("write");
    expect(decideOsc52(write, "ask")).toBe("ask");
    expect(decideOsc52(write, "deny")).toBe("drop");
    for (const policy of ["allow", "ask", "deny"] as const) {
      expect(decideOsc52({ kind: "read" }, policy)).toBe("drop");
      expect(decideOsc52({ kind: "tooLarge", bytes: 5 }, policy)).toBe("drop");
      expect(decideOsc52({ kind: "invalid" }, policy)).toBe("drop");
    }
  });
});
