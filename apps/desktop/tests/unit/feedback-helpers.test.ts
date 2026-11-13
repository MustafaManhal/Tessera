import { describe, expect, it } from "vitest";
import { base64Bytes, fitScale } from "../../src/feedback/images";
import { issueUrl } from "../../src/feedback/issueUrl";

describe("feedback helpers", () => {
  it("shrinks only images that are too large and keeps the proportion", () => {
    expect(fitScale(800, 600)).toBe(1);
    expect(fitScale(3200, 1600)).toBe(0.5);
    expect(fitScale(1000, 4000)).toBe(0.4);
  });
  it("counts the bytes of a base64 string", () => {
    expect(base64Bytes("QUJD")).toBe(3);
    expect(base64Bytes("QUI=")).toBe(2);
    expect(base64Bytes("QQ==")).toBe(1);
  });
  it("builds a prefilled GitHub issue with a label, the report folded away, and a limit on the length", () => {
    const url = new URL(issueUrl({ kind: "idea", title: " A title ", body: "My idea", report: "log line" }));
    expect(url.origin + url.pathname).toBe("https://github.com/MustafaManhal/Tessera/issues/new");
    expect(url.searchParams.get("title")).toBe("A title");
    expect(url.searchParams.get("labels")).toBe("enhancement");
    expect(url.searchParams.get("body")).toContain("My idea");
    expect(url.searchParams.get("body")).toContain("<details>");
    const long = new URL(issueUrl({ kind: "bug", title: "t", body: "x".repeat(20_000), report: "" }));
    expect((long.searchParams.get("body") ?? "").length).toBeLessThan(6_000);
    expect(
      new URL(issueUrl({ kind: "bug", title: "t", body: "b", report: "" })).searchParams.get("body"),
    ).not.toContain("<details>");
  });
});
