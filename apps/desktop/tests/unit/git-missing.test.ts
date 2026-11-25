import { afterEach, describe, expect, it, vi } from "vitest";
import { GIT_MISSING_EVENT } from "../../src/gitsetup/events";
import { mapProjectsError } from "../../src/projects/errors";

describe("an operation that cannot start git opens the git setup check", () => {
  const seen = vi.fn();
  // The unit tests run in Node: a bare EventTarget stands in for the window.
  const target = new EventTarget();
  vi.stubGlobal("window", target);
  target.addEventListener(GIT_MISSING_EVENT, seen);
  afterEach(() => seen.mockClear());

  it.each([
    ["git.io", "git I/O: program not found"],
    ["git.io", "git I/O: No such file or directory (os error 2)"],
    ["project.git_failed", "The system cannot find the file specified. (os error 2)"],
  ])("%s: %s", (code, message) => {
    mapProjectsError({ code, message });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("other failures do not", () => {
    mapProjectsError({ code: "git.worktree_failed", message: "fatal: invalid reference: main" });
    mapProjectsError({ code: "project.already_added", message: "This folder is already a project." });
    expect(seen).not.toHaveBeenCalled();
  });
});
