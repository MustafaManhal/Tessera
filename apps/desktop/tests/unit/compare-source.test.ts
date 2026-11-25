import { describe, expect, it } from "vitest";
import { unifiedText } from "../../src/compare/source";

describe("unifiedText", () => {
  it("lists removed and added lines of a changed file", () => {
    const text = unifiedText("a.ts", "one\ntwo\nthree\n", "one\n2\nthree\n");
    expect(text).toContain("-two");
    expect(text).toContain("+2");
    expect(text).not.toContain("-one");
  });
  it("shows a new file as all additions", () => {
    expect(unifiedText("n.ts", "", "x\ny\n")).toContain("+x\n+y");
  });
});
