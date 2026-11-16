import { beforeEach, describe, expect, it } from "vitest";
import { FakeProjectsClient, fakeHash } from "../../src/projects/fake";
import { mapProjectsError, ProjectsError } from "../../src/projects/errors";
import { setProjectsClient } from "../../src/projects/service";
import { branchFor, copyPathProblem, slugify, uniqueSlug } from "../../src/projects/slug";
import { startProjectsSync } from "../../src/projects/sync";
import {
  addProject,
  archiveTask,
  createTask,
  deleteTask,
  initAndAddProject,
  loadProjects,
  removeProject,
  renameTask,
  reorderProjects,
  restoreTask,
  updateProject,
} from "../../src/projects/thunks";
import { createAppStore } from "../../src/store";
import { selectGroups, setFilter, toggleCollapsed, isCollapsed } from "../../src/store/projectsSlice";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(demo = true) {
  const client = new FakeProjectsClient({ demo });
  setProjectsClient(client);
  const store = createAppStore();
  return { client, store };
}

describe("slug rules", () => {
  it("slugifies names like the backend", () => {
    expect(slugify("Fix checkout rounding!")).toBe("fix-checkout-rounding");
    expect(slugify("  Ünïcode — dash  ")).toBe("unicode-dash");
    expect(slugify("???")).toBe("");
    expect(slugify("a".repeat(80))).toHaveLength(40);
    expect(slugify(`${"a".repeat(39)} b`)).toBe("a".repeat(39));
    expect(branchFor("x")).toBe("tessera/x");
    expect(branchFor("")).toBe("");
    expect(uniqueSlug("a", new Set(["a", "a-2"]))).toBe("a-3");
    expect(uniqueSlug("a", new Set())).toBe("a");
  });

  it("rejects copy paths that are absolute, climb out, or have a drive", () => {
    expect(copyPathProblem(".env")).toBeNull();
    expect(copyPathProblem("config/local.json")).toBeNull();
    expect(copyPathProblem("")).toBe("empty");
    expect(copyPathProblem("  ")).toBe("empty");
    expect(copyPathProblem("/etc/passwd")).toBe("absolute");
    expect(copyPathProblem("~/x")).toBe("absolute");
    expect(copyPathProblem("\\server\\x")).toBe("absolute");
    expect(copyPathProblem("C:\\x")).toBe("drive");
    expect(copyPathProblem("../secret")).toBe("parent");
    expect(copyPathProblem("a/../../b")).toBe("parent");
    expect(copyPathProblem("a..b/c")).toBeNull();
  });
});

describe("mapProjectsError", () => {
  it("maps backend codes and extras to kinds", () => {
    expect(mapProjectsError({ code: "project.not_a_git_repo", message: "no", can_init: true })).toMatchObject({
      kind: "NotAGitRepo",
      extra: { canInit: true },
    });
    expect(mapProjectsError({ code: "task.BranchExists", message: "x" }).kind).toBe("BranchExists");
    expect(
      mapProjectsError({
        code: "task.unmerged_commits",
        message: "x",
        data: { list: [{ hash: "a", subject: "s" }, "raw"] },
      }).commits,
    ).toEqual([
      { hash: "a", subject: "s" },
      { hash: "", subject: "raw" },
    ]);
    expect(mapProjectsError({ code: "weird", message: "m" })).toMatchObject({ kind: "Unknown", message: "m" });
    expect(mapProjectsError(new Error("boom")).message).toBe("boom");
    expect(mapProjectsError("text").message).toBe("text");
    const existing = new ProjectsError("Cancelled", "c");
    expect(mapProjectsError(existing)).toBe(existing);
  });
});

describe("FakeProjectsClient failure modes", () => {
  let client: FakeProjectsClient;
  beforeEach(() => {
    client = new FakeProjectsClient();
  });

  it("add: NotAGitRepo with and without canInit, AlreadyAdded, relative paths", async () => {
    await expect(client.projectAdd({ path: "/tmp/not-a-repo" })).rejects.toMatchObject({
      kind: "NotAGitRepo",
      extra: { canInit: true },
    });
    await expect(client.projectAdd({ path: "/tmp/not-a-repo-no-init" })).rejects.toMatchObject({
      extra: { canInit: false },
    });
    await expect(client.projectAdd({ path: "relative/dir" })).rejects.toMatchObject({ kind: "Unknown" });
    const project = await client.projectAdd({ path: "/code/shop/" });
    expect(project).toMatchObject({ name: "shop", path: "/code/shop", default_branch: "main" });
    await expect(client.projectAdd({ path: "/code/shop" })).rejects.toMatchObject({ kind: "AlreadyAdded" });
    await client.projectGitInit("/tmp/not-a-repo");
    await expect(client.projectAdd({ path: "/tmp/not-a-repo" })).resolves.toMatchObject({ name: "not-a-repo" });
  });

  it("clone: progress, failure and cancel", async () => {
    const seen: number[] = [];
    await client.onCloneProgress((progress) => seen.push(progress.percent ?? -1));
    const project = await client.projectAdd({ clone_url: "https://example.com/team/web.git", clone_dir: "/code" });
    expect(project).toMatchObject({ path: "/code/web", remote_url: "https://example.com/team/web.git" });
    expect(seen).toEqual([25, 50, 75, 100]);
    await expect(client.projectAdd({ clone_url: "https://example.com/fail.git" })).rejects.toMatchObject({
      kind: "CloneFailed",
    });
    const pending = client.projectAdd({ clone_url: "https://example.com/team/slow.git" });
    await settle();
    await client.cancelClone();
    await expect(pending).rejects.toMatchObject({ kind: "Cancelled" });
  });

  it("update: copy files validated, setup approval resets when the script changes", async () => {
    const project = await client.projectAdd({ path: "/code/a" });
    await expect(
      client.projectUpdate(project.id, { copy_files: [{ path: "../x", mode: "copy" }] }),
    ).rejects.toMatchObject({ kind: "InvalidCopyFile" });
    await expect(client.projectUpdate(project.id, { name: " " })).rejects.toBeInstanceOf(ProjectsError);
    const withScript = await client.projectUpdate(project.id, { setup_script: "pnpm i", setup_shell: "zsh" });
    expect(withScript.setup_state).toBe("needs_approval");
    expect((await client.projectApproveSetup(project.id)).setup_state).toBe("approved");
    expect((await client.projectUpdate(project.id, { setup_script: "pnpm i " })).setup_state).toBe("needs_approval");
    expect((await client.projectUpdate(project.id, { setup_script: null })).setup_state).toBe("none");
    expect(fakeHash("zsh", "a")).not.toBe(fakeHash("bash", "a"));
    expect(fakeHash("zsh", "a")).toBe(fakeHash("zsh", "a"));
  });

  it("task create: BranchExists, WorktreeFailed, unique slugs, main checkout, setup state", async () => {
    const project = await client.projectAdd({ path: "/code/a" });
    const input = {
      project_id: project.id,
      base_branch: "main",
      agents: [],
      use_main_checkout: false,
      run_setup: true,
    };
    await expect(client.taskCreate({ ...input, name: "branch exists" })).rejects.toMatchObject({
      kind: "BranchExists",
    });
    await expect(client.taskCreate({ ...input, name: "fail-worktree now" })).rejects.toMatchObject({
      kind: "WorktreeFailed",
    });
    const first = await client.taskCreate({ ...input, name: "Add login" });
    const second = await client.taskCreate({ ...input, name: "Add login" });
    expect(first.tasks[0]).toMatchObject({
      slug: "add-login",
      branch: "tessera/add-login",
      state: "active",
      worktree_path: "/code/a-worktrees/add-login",
    });
    expect(second.tasks[0]?.slug).toBe("add-login-2");
    expect(first.setup.state).toBe("none");
    const main = await client.taskCreate({ ...input, name: "Direct", use_main_checkout: true });
    expect(main.tasks[0]).toMatchObject({ worktree_path: null, uses_main_checkout: true });
    await client.projectUpdate(project.id, { setup_script: "make", setup_shell: "bash" });
    const withSetup = await client.taskCreate({ ...input, name: "Needs setup" });
    expect(withSetup.tasks[0]?.state).toBe("setting_up");
    expect(withSetup.setup).toMatchObject({ state: "needs_approval", script: "make", shell: "bash" });
    expect(withSetup.setup.hash).toHaveLength(12);
    const generated = await client.taskCreate({ ...input });
    expect(generated.tasks[0]?.name).toMatch(/^task-\d+$/);
  });

  it("delete: refuses unmerged commits until confirmed; archive and restore emit events", async () => {
    const { client: demo } = setup();
    const events: string[] = [];
    await demo.onTaskChanged((event) => events.push(`${event.summary.state}:${event.task_id}`));
    const [id] = demo.taskIds();
    expect(id).toBeDefined();
    await expect(demo.taskDelete(id as string, false)).rejects.toMatchObject({ kind: "UnmergedCommits" });
    const err = await demo.taskDelete(id as string, false).catch((cause) => cause as ProjectsError);
    expect((err as ProjectsError).commits.map((commit) => commit.subject)).toEqual(["Round to cents", "Add test"]);
    await demo.taskArchive(id as string);
    await demo.taskRestore(id as string);
    await demo.taskDelete(id as string, true);
    expect(events).toEqual([`archived:${id}`, `active:${id}`, `deleted:${id}`]);
    await expect(demo.taskDelete(id as string, true)).rejects.toMatchObject({ kind: "NotFound" });
  });

  it("remove project reports worktrees; run scripts validate", async () => {
    const { client: demo } = setup();
    const [project] = await demo.projectList();
    expect(await demo.projectRemove(project?.id as string)).toEqual({ tasks_with_worktrees: 3 });
    const other = await client.projectAdd({ path: "/code/b" });
    await expect(client.runScriptAdd(other.id, { name: "", command: "x", auto_start: false })).rejects.toBeInstanceOf(
      ProjectsError,
    );
    const script = await client.runScriptAdd(other.id, { name: "dev", command: "pnpm dev", auto_start: true });
    expect((await client.runScriptUpdate(script.id, { command: "pnpm start" })).command).toBe("pnpm start");
    await client.runScriptRemove(script.id);
    expect(await client.runScriptList(other.id)).toEqual([]);
    await expect(client.runScriptUpdate("nope", {})).rejects.toMatchObject({ kind: "NotFound" });
  });
});

describe("projects slice and thunks", () => {
  it("loads, groups newest first with archived apart, and filters", async () => {
    const { store } = setup();
    await store.dispatch(loadProjects());
    const groups = selectGroups(store.getState());
    expect(groups.map((group) => group.project.name)).toEqual(["shop-api", "web", "dotfiles"]);
    expect(groups[0]?.tasks.map((task) => task.name)).toEqual([
      "Main checkout",
      "Add order export",
      "Fix checkout rounding",
    ]);
    expect(groups[0]?.archived.map((task) => task.name)).toEqual(["Old spike"]);
    expect(selectGroups(store.getState())).toBe(groups);
    store.dispatch(setFilter("dark"));
    expect(selectGroups(store.getState()).map((group) => group.project.name)).toEqual(["web"]);
    store.dispatch(setFilter("shop"));
    expect(selectGroups(store.getState())[0]?.tasks).toHaveLength(3);
    store.dispatch(setFilter("tessera/add-order"));
    expect(selectGroups(store.getState())[0]?.tasks.map((task) => task.name)).toEqual(["Add order export"]);
    store.dispatch(setFilter("nothing like this"));
    expect(selectGroups(store.getState())).toEqual([]);
  });

  it("collapse defaults: groups open, archived sections closed", () => {
    const { store } = setup(false);
    const state = () => store.getState().projects;
    expect(isCollapsed(state(), "prj_1")).toBe(false);
    expect(isCollapsed(state(), "archived:prj_1")).toBe(true);
    store.dispatch(toggleCollapsed({ key: "prj_1" }));
    store.dispatch(toggleCollapsed({ key: "archived:prj_1" }));
    expect(isCollapsed(state(), "prj_1")).toBe(true);
    expect(isCollapsed(state(), "archived:prj_1")).toBe(false);
  });

  it("add, init-and-add, update (optimistic rename with rollback), remove", async () => {
    const { store, client } = setup(false);
    await store.dispatch(loadProjects());
    const added = await store.dispatch(addProject({ path: "/code/shop" }));
    expect(store.getState().projects.order).toEqual([added.id]);
    await expect(store.dispatch(addProject({ path: "/code/shop" }))).rejects.toMatchObject({ kind: "AlreadyAdded" });
    const init = await store.dispatch(initAndAddProject("/tmp/not-a-repo"));
    expect(store.getState().projects.projects[init.id]?.name).toBe("not-a-repo");

    const pending = store.dispatch(updateProject(added.id, { name: "Shop" }));
    expect(store.getState().projects.projects[added.id]?.name).toBe("Shop");
    await pending;
    // A refused rename goes back.
    const refused = store.dispatch(updateProject(added.id, { name: " " }));
    expect(store.getState().projects.projects[added.id]?.name).toBe(" ");
    await expect(refused).rejects.toBeInstanceOf(ProjectsError);
    expect(store.getState().projects.projects[added.id]?.name).toBe("Shop");
    // Not optimistic: a script change waits for the backend.
    const script = store.dispatch(updateProject(added.id, { setup_script: "make" }));
    expect(store.getState().projects.projects[added.id]?.setup_script).toBeNull();
    await script;
    expect(store.getState().projects.projects[added.id]?.setup_script).toBe("make");

    await store.dispatch(removeProject(init.id));
    expect(store.getState().projects.order).toEqual([added.id]);
    expect(client.calls.map((call) => call.method)).toContain("projectRemove");
  });

  it("reorders optimistically, saves sort, and rolls back on failure", async () => {
    const { store, client } = setup();
    await store.dispatch(loadProjects());
    const ids = store.getState().projects.order;
    await store.dispatch(reorderProjects([...ids].reverse()));
    expect(store.getState().projects.order).toEqual([...ids].reverse());
    expect((await client.projectList()).map((project) => project.id)).toEqual(ids);
    expect((await client.projectList()).map((project) => project.sort).sort()).toEqual([0, 1, 2]);
    client.projectUpdate = async () => {
      throw new ProjectsError("Unknown", "disk full");
    };
    await expect(store.dispatch(reorderProjects(ids))).rejects.toThrow("disk full");
    expect(store.getState().projects.order).toEqual([...ids].reverse());
  });

  it("creates, renames, archives, restores and deletes tasks; the unmerged refusal keeps the task", async () => {
    const { store, client } = setup();
    await store.dispatch(loadProjects());
    const shop = store.getState().projects.order[0] as string;
    const result = await store.dispatch(
      createTask({
        project_id: shop,
        name: "New thing",
        base_branch: "main",
        agents: [],
        use_main_checkout: false,
        run_setup: true,
      }),
    );
    const id = result.tasks[0]?.id as string;
    expect(store.getState().projects.tasks[id]).toMatchObject({ name: "New thing", ahead: null, ports: [] });
    await expect(
      store.dispatch(
        createTask({
          project_id: shop,
          name: "exists",
          base_branch: "main",
          agents: [],
          use_main_checkout: false,
          run_setup: true,
        }),
      ),
    ).rejects.toMatchObject({ kind: "BranchExists" });

    const rename = store.dispatch(renameTask(id, "Renamed"));
    expect(store.getState().projects.tasks[id]?.name).toBe("Renamed");
    await rename;
    await expect(store.dispatch(renameTask(id, " "))).rejects.toBeInstanceOf(ProjectsError);
    expect(store.getState().projects.tasks[id]?.name).toBe("Renamed");

    await store.dispatch(archiveTask(id));
    expect(store.getState().projects.tasks[id]?.state).toBe("archived");
    await store.dispatch(restoreTask(id));
    expect(store.getState().projects.tasks[id]?.state).toBe("active");

    const unmerged = client.taskIds()[0] as string;
    await expect(store.dispatch(deleteTask(unmerged, false))).rejects.toMatchObject({ kind: "UnmergedCommits" });
    expect(store.getState().projects.tasks[unmerged]).toBeDefined();
    await store.dispatch(deleteTask(unmerged, true));
    expect(store.getState().projects.tasks[unmerged]).toBeUndefined();
  });

  it("follows task:changed events (git facts, state, deletion) through startProjectsSync", async () => {
    const { store, client } = setup();
    const stop = startProjectsSync(client, store);
    await settle();
    await settle();
    const id = client.taskIds()[1] as string;
    expect(store.getState().projects.tasks[id]?.changed_files).toBe(0);
    client.touchTask(id, { changed_files: 5, ahead: 3, ports: [3000] });
    expect(store.getState().projects.tasks[id]).toMatchObject({ changed_files: 5, ahead: 3, ports: [3000] });
    client.touchTask(id, { state: "deleted" });
    expect(store.getState().projects.tasks[id]).toBeUndefined();
    stop();
    client.touchTask(client.taskIds()[0] as string, { changed_files: 9 });
    expect(store.getState().projects.tasks[client.taskIds()[0] as string]?.changed_files).toBe(3);
  });

  it("a failing load leaves an error state", async () => {
    const { store, client } = setup();
    client.projectList = async () => {
      throw new ProjectsError("Unknown", "no backend");
    };
    await store.dispatch(loadProjects());
    expect(store.getState().projects).toMatchObject({ status: "error", error: "no backend" });
  });
});
