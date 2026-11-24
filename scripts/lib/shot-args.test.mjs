import { describe, expect, it } from "vitest";
import { parseShotArgs } from "./shot-args.mjs";

describe("screenshot arguments", () => {
  it("resolves relative routes and accepts output settings", () => {
    expect(parseShotArgs(["--url", "/?gallery", "--name", "gallery", "--out", "tmp/shots"])).toEqual({
      url: "http://localhost:1421/?gallery",
      name: "gallery",
      out: "tmp/shots",
    });
  });
  it("rejects missing values, unknown options, unsafe names and protocols", () => {
    for (const args of [["--url"], ["--bad", "x"], ["--name", "../x"], ["--url", "file:///tmp/a"]]) {
      expect(() => parseShotArgs(args)).toThrow();
    }
  });
});
