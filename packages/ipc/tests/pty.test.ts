import { describe, expect, it } from "vitest";
import { decodeFrame } from "../src/pty";

describe("decodeFrame", () => {
  it("decodes a data frame without copying the tag", () => {
    const frame = decodeFrame(Uint8Array.from([0, 104, 105]).buffer);
    expect(frame).toEqual({ kind: "data", bytes: Uint8Array.from([104, 105]) });
  });

  it("decodes an exit frame, little endian", () => {
    expect(decodeFrame(Uint8Array.from([1, 4, 3, 2, 1]).buffer)).toEqual({ kind: "exit", code: 0x01020304 });
    expect(decodeFrame(Uint8Array.from([1, 7, 0, 0, 0]))).toEqual({ kind: "exit", code: 7 });
  });

  it("accepts the JSON number-array fallback", () => {
    expect(decodeFrame([0, 65])).toEqual({ kind: "data", bytes: Uint8Array.from([65]) });
  });

  it("ignores empty, truncated and unknown frames", () => {
    expect(decodeFrame(new ArrayBuffer(0))).toBeUndefined();
    expect(decodeFrame(Uint8Array.from([1, 7]).buffer)).toBeUndefined();
    expect(decodeFrame(Uint8Array.from([9, 1]).buffer)).toBeUndefined();
    expect(decodeFrame("text")).toBeUndefined();
    expect(decodeFrame(undefined)).toBeUndefined();
  });
});
