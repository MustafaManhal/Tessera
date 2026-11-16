import { describe, expect, it } from "vitest";
import { createCwdFilter, parseOsc7, parseOsc7Url } from "../../src/osc";

describe("OSC 7", () => {
  it("parses file URLs with and without a host, percent-decoded", () => {
    expect(parseOsc7Url("file:///Users/me/my%20project")).toEqual({ host: "", path: "/Users/me/my project" });
    expect(parseOsc7Url("file://Mac.local/Users/me/%E2%9C%93")).toEqual({ host: "mac.local", path: "/Users/me/✓" });
    expect(parseOsc7("FILE://localhost/tmp")).toBe("/tmp");
  });

  it("turns Windows drive and UNC paths into Windows paths", () => {
    expect(parseOsc7("file:///C:/Users/x")).toBe("C:/Users/x");
    expect(parseOsc7("file://host/D:/")).toBe("D:/");
    expect(parseOsc7("file:///C:")).toBe("C:");
    expect(parseOsc7("file:////server/share/folder")).toBe("\\\\server\\share\\folder");
    expect(parseOsc7("file://localhost//server/share")).toBe("\\\\server\\share");
  });

  it("rejects anything that is not a usable file URL", () => {
    for (const bad of [
      "",
      "/Users/me",
      "http://example.com/x",
      "file://host",
      "file:///bad%ZZescape",
      "file:///with%0Anewline",
      "file://bad host/x",
      "file:////server",
    ]) {
      expect(parseOsc7(bad), bad).toBeNull();
    }
  });

  it("trusts localhost and the first host a pane reports, and ignores other hosts", () => {
    const filter = createCwdFilter();
    expect(filter.accept("file://localhost/a")).toBe("/a");
    expect(filter.trustedHost).toBeNull();
    expect(filter.accept("file://my-mac.local/b")).toBe("/b");
    expect(filter.trustedHost).toBe("my-mac.local");
    expect(filter.accept("file://MY-MAC.local/c")).toBe("/c");
    expect(filter.accept("file://build-server/home/ci")).toBeNull();
    expect(filter.accept("file:///d")).toBe("/d");
  });

  it("trusts hosts it is told are local", () => {
    const filter = createCwdFilter(["Desk"]);
    expect(filter.accept("file://desk/x")).toBe("/x");
    expect(filter.trustedHost).toBeNull();
  });
});
