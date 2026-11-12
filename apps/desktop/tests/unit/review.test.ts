import { expect, it } from "vitest";
import { fileTree, shouldAutoRefresh } from "../../src/review/model";
import { FakeReviewClient, type ChangedFile } from "../../src/review/client";
import { whitespaceDiff } from "../../src/review/DiffView";
const file = (path: string): ChangedFile => ({
  path,
  old_path: null,
  status: "M",
  added: 1,
  removed: 1,
  is_binary: false,
});
it("builds sorted folders once without losing non-ASCII or spaced paths", () => {
  const tree = fileTree([file("src/z.ts"), file("README.md"), file("src/nested/界 file.ts"), file("src/a.ts")]);
  expect(tree.map((e) => e.path)).toEqual([
    "README.md",
    "src",
    "src/a.ts",
    "src/nested",
    "src/nested/界 file.ts",
    "src/z.ts",
  ]);
  expect(tree.find((e) => e.path === "src/nested/界 file.ts")?.depth).toBe(2);
  expect(tree.filter((e) => !e.file).map((e) => e.path)).toEqual(["src", "src/nested"]);
});
it("defers refresh while hovering or loading and refreshes pending updates on leave", () => {
  expect(shouldAutoRefresh(true, true, false)).toBe(false);
  expect(shouldAutoRefresh(true, false, true)).toBe(false);
  expect(shouldAutoRefresh(false, false, false)).toBe(false);
  expect(shouldAutoRefresh(true, false, false)).toBe(true);
});
it("ignores space and tab changes while preserving meaningful character changes", () => {
  expect(whitespaceDiff("const x = 1;\n", "const  x=1; \n")).toEqual([]);
  const changes = whitespaceDiff("let x = 1;", "let x = 2;");
  expect(changes.length).toBeGreaterThan(0);
  expect(changes.every((c) => c.fromA >= 0 && c.toA <= 10 && c.toB <= 10)).toBe(true);
});
it("fake returns isolated file/diff snapshots and task-scoped change events", async () => {
  const client = new FakeReviewClient();
  const content = { base_text: "old", head_text: "new", too_large: false, binary: false, conflict: false };
  client.set("task", [file("a.ts")], { "a.ts": content });
  const files = await client.files("task");
  if (files[0]) files[0].path = "mutated";
  expect((await client.files("task"))[0]?.path).toBe("a.ts");
  expect(await client.diff("task", "a.ts")).toEqual(content);
  const changes: string[] = [];
  const off = await client.onChanged((id) => changes.push(id));
  client.notify("task");
  off();
  client.notify("other");
  expect(changes).toEqual(["task"]);
});
