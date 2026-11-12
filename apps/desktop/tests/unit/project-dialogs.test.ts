import { describe, expect, it } from "vitest";
import { NAME_MAX, previewName } from "../../src/projects/dialogs/NewTaskDialog";
import {
  type Draft,
  draftOf,
  hasErrors,
  patchOf,
  validateDraft,
} from "../../src/projects/dialogs/ProjectSettingsDialog";
import { FakeProjectsClient } from "../../src/projects/fake";
import { ProjectsError, errorTitleKey } from "../../src/projects/errors";
import { strings } from "@tessera/ui";

async function sample() {
  const client = new FakeProjectsClient({ demo: true });
  const [project] = await client.projectList();
  if (!project) throw new Error("no project");
  return project;
}

describe("project settings draft", () => {
  it("round-trips a project through its draft and back into a patch", async () => {
    const project = await sample();
    const draft = draftOf(project);
    expect(validateDraft(draft)).toEqual({});
    expect(patchOf(draft)).toMatchObject({
      name: "shop-api",
      default_branch: "main",
      worktree_dir: null,
      port_base: 4000,
      is_muted: false,
      setup_script: "pnpm install\npnpm db:migrate",
      setup_shell: "zsh",
      copy_files: [
        { path: ".env", mode: "copy" },
        { path: "node_modules", mode: "symlink" },
      ],
    });
  });

  it("rejects an empty name, empty base branch, relative worktree folder and bad ports", async () => {
    const draft = draftOf(await sample());
    const bad = (patch: Partial<Draft>) => validateDraft({ ...draft, ...patch });
    expect(bad({ name: "   " }).name).toBeDefined();
    expect(bad({ baseBranch: "" }).baseBranch).toBeDefined();
    expect(bad({ worktreeDir: "relative/dir" }).worktreeDir).toBeDefined();
    expect(bad({ worktreeDir: "/abs/dir" }).worktreeDir).toBeUndefined();
    expect(bad({ worktreeDir: "C:\\trees" }).worktreeDir).toBeUndefined();
    expect(bad({ worktreeDir: "" }).worktreeDir).toBeUndefined();
    for (const port of ["80", "1023", "65001", "abc", "4000.5", "-1", "4 000"])
      expect(bad({ portBase: port }).portBase, port).toBeDefined();
    for (const port of ["", "1024", "65000", " 5000 "]) expect(bad({ portBase: port }).portBase, port).toBeUndefined();
  });

  it("flags each bad copy path on its own row and accepts good ones", async () => {
    const draft = draftOf(await sample());
    const errors = validateDraft({
      ...draft,
      copyFiles: [
        { path: ".env", mode: "copy" },
        { path: "../secret", mode: "copy" },
        { path: "/etc/passwd", mode: "symlink" },
        { path: "C:\\x", mode: "copy" },
        { path: "", mode: "copy" },
        { path: "a/b/c.json", mode: "symlink" },
      ],
    });
    expect(Object.keys(errors.copy ?? {})).toEqual(["1", "2", "3", "4"]);
    expect(hasErrors(errors)).toBe(true);
    expect(hasErrors({})).toBe(false);
  });

  it("an empty setup script clears the script and its shell", async () => {
    const draft = draftOf(await sample());
    expect(patchOf({ ...draft, setupScript: "  \n" })).toMatchObject({ setup_script: null, setup_shell: null });
    expect(patchOf({ ...draft, setupScript: "make", setupShell: "bash" })).toMatchObject({
      setup_script: "make",
      setup_shell: "bash",
    });
  });
});

describe("new task helpers", () => {
  it("previews the name from the typed name, else the first words of the prompt", () => {
    expect(previewName(" Fix it ", "ignored")).toBe("Fix it");
    expect(previewName("", "  fix the flaky test in checkout now please ")).toBe("fix the flaky test in checkout");
    expect(previewName("", "")).toBe("");
    expect(NAME_MAX).toBe(80);
  });
});

describe("backend errors are mapped to catalog sentences", () => {
  it("has a plain sentence for every error kind", () => {
    const kinds = [
      "NotAGitRepo",
      "AlreadyAdded",
      "BranchExists",
      "WorktreeFailed",
      "SetupNotApproved",
      "UnmergedCommits",
      "InvalidCopyFile",
      "CloneFailed",
      "Cancelled",
      "NotFound",
      "Unknown",
    ] as const;
    for (const kind of kinds) expect(errorTitleKey(kind) in strings, kind).toBe(true);
    expect(new ProjectsError("Cancelled", "x").kind).toBe("Cancelled");
  });
});
