import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { hostsIn, networkCodeIn, scan } from "../../../../scripts/network-audit.mjs";

describe("network audit", () => {
  it("the source only talks to the allowed files and hosts", () => {
    expect(scan()).toEqual([]);
  });
  it("finds hosts in URLs, with credentials and ports, and ignores placeholders", () => {
    expect([
      ...hostsIn(
        'a "https://api.github.com/x" and http://user:pw@evil.example.org:8080/p, https://x and https://me:pw@',
      ),
    ]).toEqual(["api.github.com", "evil.example.org"]);
  });
  it("recognises network-capable code", () => {
    expect(networkCodeIn("let c = reqwest::Client::new();")).toBe(true);
    expect(networkCodeIn("await fetch(url)")).toBe(true);
    expect(networkCodeIn("const x = new WebSocket(u)")).toBe(true);
    expect(networkCodeIn("fetchSomething() prefetch")).toBe(false);
  });
});
