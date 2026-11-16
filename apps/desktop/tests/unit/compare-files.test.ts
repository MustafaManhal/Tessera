import { describe, expect, it } from "vitest";
import { diffStats, unionFiles } from "../../src/compare/files";

describe("unionFiles", () => {
  it("unions paths and counts changed-in across tasks", () => {
    const perTask = new Map([
      ["t1", ["b.ts", "a.ts"]],
      ["t2", ["a.ts", "c.ts"]],
      ["t3", ["a.ts"]],
    ]);
    expect(unionFiles(perTask)).toEqual([
      { path: "a.ts", changedIn: 3, total: 3 },
      { path: "b.ts", changedIn: 1, total: 3 },
      { path: "c.ts", changedIn: 1, total: 3 },
    ]);
  });
  it("dedupes a file listed twice in one task", () => {
    const perTask = new Map([
      ["t1", ["a.ts", "a.ts"]],
      ["t2", []],
    ]);
    expect(unionFiles(perTask)).toEqual([{ path: "a.ts", changedIn: 1, total: 2 }]);
  });
  it("empty input gives an empty union", () => {
    expect(unionFiles(new Map())).toEqual([]);
  });
});

describe("diffStats", () => {
  it("counts +/- lines and skips file headers", () => {
    const diff = ["--- a/x", "+++ b/x", "@@ -1 +1 @@", "-old", "+new", "+newer", " ctx"].join("\n");
    expect(diffStats(diff)).toEqual({ additions: 2, deletions: 1 });
  });
});
