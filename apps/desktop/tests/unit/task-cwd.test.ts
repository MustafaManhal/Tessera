import { describe, expect, it } from "vitest";
import type { RootState } from "../../src/store";
import { startFolderFor } from "../../src/terminal/taskCwd";

const state = {
  projects: {
    projects: { p1: { id: "p1", path: "/code/Tessera/Tessera" } },
    tasks: {
      main: { id: "main", project_id: "p1", worktree_path: null },
      tree: { id: "tree", project_id: "p1", worktree_path: "/data/worktrees/p1/boss-2" },
    },
  },
} as unknown as RootState;

describe("a task's terminal starts in its checkout", () => {
  it("uses the remembered folder when it is the checkout or inside it", () => {
    expect(startFolderFor(state, "main", "/code/Tessera/Tessera")).toBe("/code/Tessera/Tessera");
    expect(startFolderFor(state, "main", "/code/Tessera/Tessera/apps/desktop")).toBe(
      "/code/Tessera/Tessera/apps/desktop",
    );
    expect(startFolderFor(state, "tree", "/data/worktrees/p1/boss-2/src/")).toBe("/data/worktrees/p1/boss-2/src/");
  });
  it("uses the checkout when the remembered folder is elsewhere (the project moved)", () => {
    expect(startFolderFor(state, "main", "/code/Tessera")).toBe("/code/Tessera/Tessera");
    expect(startFolderFor(state, "tree", "/code/Tessera/Tessera")).toBe("/data/worktrees/p1/boss-2");
  });
  it("leaves a pane without a task, or an unknown task, alone", () => {
    expect(startFolderFor(state, undefined, "/anywhere")).toBe("/anywhere");
    expect(startFolderFor(state, "gone", "/anywhere")).toBe("/anywhere");
  });
});
