// FakeProjectsClient: an in-memory backend for the browser dev server (`?demo`) and tests. Deterministic ids and
// clock, optional latency, and the failure modes of the real commands:
//   - project add: a path containing "not-a-repo" → NotAGitRepo (`canInit` unless it contains "no-init"); a path already
//     added → AlreadyAdded; a clone URL containing "fail" → CloneFailed; `cancelClone()` → Cancelled.
//   - task create: a name containing "exists" → BranchExists; "fail-worktree" → WorktreeFailed.
//   - task delete: a task with `unmerged` commits → UnmergedCommits{list} until confirmed.
// Every state change emits `task:changed` like the Rust watcher does.
import type { ProjectsClient, Unsubscribe } from "./client";
import { ProjectsError } from "./errors";
import { branchFor, copyPathProblem, slugify, uniqueSlug } from "./slug";
import {
  type CloneProgress,
  type CommitInfo,
  type Project,
  type ProjectInput,
  type ProjectPatch,
  type RemoteProjectInput,
  type RepoFacts,
  type RunScript,
  type RunScriptInput,
  SETUP_HASH_CHARS,
  type SetupInfo,
  type SetupState,
  type Task,
  type TaskChangedEvent,
  type TaskCreateInput,
  type WorktreeFacts,
  type TaskCreateResult,
  type TaskGroupCreateInput,
  type TaskGroupInfo,
  type TaskFilter,
  type TaskSummary,
} from "./types";

export interface FakeProjectsOptions {
  /** Milliseconds every call waits (simulated IPC); 0 in unit tests. */
  latencyMs?: number;
  /** Clock for timestamps. */
  now?: () => number;
  /** Seed demo data (`?demo`). */
  demo?: boolean;
}

interface FakeTask extends TaskSummary {
  /** Commits not merged into the base branch: deleting asks first. */
  unmerged: CommitInfo[];
}

const baseName = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1) || path;

/** A stable short hash of shell + NUL + script (the real one is SHA-256; this only needs to change when the text does). */
export function fakeHash(shell: string | null, script: string | null): string {
  const text = `${shell ?? ""}\0${script ?? ""}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return `${hex(h1)}${hex(h2)}${hex(h1 ^ h2)}`;
}

export function setupStateOf(
  project: Pick<Project, "setup_script" | "setup_shell" | "setup_approved_hash">,
): SetupState {
  if (!project.setup_script || project.setup_script.trim() === "") return "none";
  return project.setup_approved_hash === fakeHash(project.setup_shell, project.setup_script)
    ? "approved"
    : "needs_approval";
}

export class FakeProjectsClient implements ProjectsClient {
  private projects: Project[] = [];
  private scripts: RunScript[] = [];
  private tasks: FakeTask[] = [];
  private nextProject = 1;
  private nextTask = 1;
  private nextScript = 1;
  private readonly latency: number;
  private readonly now: () => number;
  private readonly changed = new Set<(event: TaskChangedEvent) => void>();
  private readonly progress = new Set<(progress: CloneProgress) => void>();
  private readonly initialised = new Set<string>();
  private cloneTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelCurrent: (() => void) | null = null;
  /** `cancelClone` arrived before the clone itself started (during the simulated latency). */
  private cancelEarly = false;
  private cloning = false;
  /** Calls received, by method (tests). */
  readonly calls: { method: string; args: unknown[] }[] = [];
  /** Folders `projectAdd` accepts as repos with facts; any other absolute path is a repo on `main`. */
  readonly repos = new Map<string, Omit<RepoFacts, "root">>();

  constructor(options: FakeProjectsOptions = {}) {
    this.latency = options.latencyMs ?? 0;
    let tick = 1_700_000_000_000;
    this.now = options.now ?? (() => (tick += 1000));
    if (options.demo) this.seed();
  }

  // Projects ----------------------------------------------------------------------------------------------------

  async projectList(): Promise<Project[]> {
    await this.wait("projectList");
    return this.projects.map((project) => structuredClone(project));
  }

  async projectAdd(input: ProjectInput): Promise<Project> {
    this.cloning = input.clone_url !== undefined;
    this.cancelEarly = false;
    await this.wait("projectAdd", input);
    let path = input.path;
    let remote: string | null = null;
    if (input.clone_url) {
      path = await this.clone(input.clone_url, input.clone_dir ?? "/home/you/code");
      remote = input.clone_url;
    }
    if (!path || !/^([/\\]|[A-Za-z]:)/.test(path)) throw new ProjectsError("Unknown", `Not a folder: ${path ?? ""}`);
    const normalised = path.replace(/[\\/]+$/, "") || "/";
    if (this.projects.some((project) => project.path === normalised))
      throw new ProjectsError("AlreadyAdded", `${baseName(normalised)} is already added.`);
    if (normalised.includes("not-a-repo") && !this.initialised.has(normalised))
      throw new ProjectsError("NotAGitRepo", `${normalised} is not a git repository.`, {
        canInit: !normalised.includes("no-init"),
      });
    const facts = this.repos.get(normalised);
    const name = input.name?.trim() || baseName(normalised);
    const project: Project = {
      id: `prj_${this.nextProject++}`,
      name,
      path: normalised,
      remote_url: remote ?? facts?.remote_url ?? null,
      default_branch: facts?.default_branch ?? "main",
      worktree_dir: null,
      setup_script: null,
      setup_shell: null,
      setup_approved_hash: null,
      setup_state: "none",
      copy_files: [],
      port_base: null,
      default_profile_id: null,
      is_muted: false,
      sort: this.projects.length,
      work_mode: "worktrees",
      created_at: this.now(),
      updated_at: this.now(),
    };
    this.projects.push(project);
    return structuredClone(project);
  }

  async projectAddRemote(input: RemoteProjectInput): Promise<Project> {
    await this.wait("projectAddRemote", input);
    const alias = input.host_id.replace(/^config:/, "");
    const typed = input.path.trim();
    const path = typed.startsWith("~/") ? `/home/you/${typed.slice(2)}` : typed;
    if (!path.startsWith("/"))
      throw new ProjectsError(
        "Unknown",
        "Enter the folder on the host as an absolute path, or one that starts with ~/.",
      );
    if (path.includes("not-a-repo"))
      throw new ProjectsError("NotAGitRepo", "That folder on the host is not a Git repository.", { canInit: false });
    const full = `ssh://${alias}${path.replace(/\/+$/, "")}`;
    if (this.projects.some((project) => project.path === full))
      throw new ProjectsError("AlreadyAdded", `${baseName(full)} is already added.`);
    const project: Project = {
      id: `prj_${this.nextProject++}`,
      name: input.name?.trim() || baseName(full),
      path: full,
      remote_url: null,
      default_branch: "main",
      worktree_dir: `ssh://${alias}/home/you/.tessera/worktrees`,
      setup_script: null,
      setup_shell: null,
      setup_approved_hash: null,
      setup_state: "none",
      copy_files: [],
      port_base: null,
      default_profile_id: null,
      is_muted: false,
      sort: this.projects.length,
      work_mode: "worktrees",
      created_at: this.now(),
      updated_at: this.now(),
    };
    this.projects.push(project);
    this.repos.set(full, { branch: "main", default_branch: "main", remote_url: null, bare: false });
    return structuredClone(project);
  }

  async projectGitInit(path: string): Promise<void> {
    await this.wait("projectGitInit", path);
    this.repos.set(path.replace(/[\\/]+$/, ""), {
      branch: "main",
      default_branch: "main",
      remote_url: null,
      bare: false,
    });
    // The folder is a repo from now on: the name no longer matches the "not a repo" rule.
    this.initialised.add(path.replace(/[\\/]+$/, ""));
  }

  async projectUpdate(id: string, patch: ProjectPatch): Promise<Project> {
    await this.wait("projectUpdate", id, patch);
    const project = this.requireProject(id);
    if (patch.copy_files) {
      for (const file of patch.copy_files) {
        if (copyPathProblem(file.path))
          throw new ProjectsError("InvalidCopyFile", `"${file.path}" must be a relative path without "..".`);
      }
    }
    if (patch.name !== undefined && patch.name.trim() === "")
      throw new ProjectsError("Unknown", "The name cannot be empty.");
    Object.assign(project, patch, { updated_at: this.now() });
    // Changing the script or its shell resets the approval (the hash changes).
    project.setup_state = setupStateOf(project);
    return structuredClone(project);
  }

  async projectRemove(id: string): Promise<{ tasks_with_worktrees: number }> {
    await this.wait("projectRemove", id);
    this.requireProject(id);
    const own = this.tasks.filter((task) => task.project_id === id);
    this.projects = this.projects.filter((project) => project.id !== id);
    this.scripts = this.scripts.filter((script) => script.project_id !== id);
    this.tasks = this.tasks.filter((task) => task.project_id !== id);
    return { tasks_with_worktrees: own.filter((task) => task.worktree_path !== null).length };
  }

  async projectApproveSetup(id: string): Promise<Project> {
    await this.wait("projectApproveSetup", id);
    const project = this.requireProject(id);
    project.setup_approved_hash = fakeHash(project.setup_shell, project.setup_script);
    project.setup_state = setupStateOf(project);
    return structuredClone(project);
  }

  // Run scripts -------------------------------------------------------------------------------------------------

  async runScriptList(projectId: string): Promise<RunScript[]> {
    await this.wait("runScriptList", projectId);
    return this.scripts.filter((script) => script.project_id === projectId).map((script) => ({ ...script }));
  }

  async runScriptAdd(projectId: string, input: RunScriptInput): Promise<RunScript> {
    await this.wait("runScriptAdd", projectId, input);
    this.requireProject(projectId);
    if (input.name.trim() === "" || input.command.trim() === "")
      throw new ProjectsError("Unknown", "A run script needs a name and a command.");
    const script: RunScript = {
      id: `rs_${this.nextScript++}`,
      project_id: projectId,
      sort: this.scripts.filter((candidate) => candidate.project_id === projectId).length,
      ...input,
    };
    this.scripts.push(script);
    return { ...script };
  }

  async runScriptUpdate(id: string, patch: Partial<RunScriptInput>): Promise<RunScript> {
    await this.wait("runScriptUpdate", id, patch);
    const script = this.scripts.find((candidate) => candidate.id === id);
    if (!script) throw new ProjectsError("NotFound", `Unknown run script ${id}`);
    Object.assign(script, patch);
    return { ...script };
  }

  async runScriptRemove(id: string): Promise<void> {
    await this.wait("runScriptRemove", id);
    this.scripts = this.scripts.filter((script) => script.id !== id);
  }

  // Tasks -------------------------------------------------------------------------------------------------------

  async taskCreate(input: TaskCreateInput): Promise<TaskCreateResult> {
    await this.wait("taskCreate", input);
    const project = this.requireProject(input.project_id);
    const name = input.name?.trim() || `task-${this.nextTask}`;
    const base = slugify(name) || `task-${this.nextTask}`;
    if (name.includes("exists"))
      throw new ProjectsError("BranchExists", `The branch ${branchFor(base)} already exists.`);
    if (name.includes("fail-worktree"))
      throw new ProjectsError("WorktreeFailed", "Git could not create the worktree: the folder is not writable.");
    const slug = uniqueSlug(
      base,
      new Set(this.tasks.filter((task) => task.project_id === project.id).map((task) => task.slug)),
    );
    const dir = project.worktree_dir ?? `${project.path}-worktrees`;
    const created = this.now();
    // Branch mode: the task works on a branch inside the project folder, with no worktree of its own.
    const inFolder = input.use_main_checkout || project.work_mode === "branches";
    const needsSetup = input.run_setup && !inFolder && project.setup_state !== "none";
    const task: FakeTask = {
      id: `tsk_${this.nextTask++}`,
      project_id: project.id,
      group_id: null,
      name,
      slug,
      branch: input.existing_branch
        ? input.existing_branch
        : input.use_main_checkout
          ? (this.repos.get(project.path)?.branch ?? project.default_branch)
          : branchFor(slug),
      base_branch: input.base_branch,
      worktree_path: inFolder ? null : `${dir}/${slug}`,
      uses_main_checkout: inFolder,
      keeps_branch: Boolean(input.existing_branch) && !inFolder,
      state: needsSetup ? "setting_up" : "active",
      prompt: input.prompt?.trim() ? input.prompt : null,
      port_start: project.port_base === null ? null : project.port_base + this.tasks.length * 10,
      port_count: 10,
      last_message: null,
      created_at: created,
      updated_at: created,
      archived_at: null,
      ahead: 0,
      behind: 0,
      changed_files: 0,
      ports: [],
      unmerged: [],
    };
    this.tasks.push(task);
    this.emit(task);
    return {
      group_id: null,
      tasks: [this.plain(task)],
      setup: needsSetup ? this.setupInfo(project) : { state: "none", script: null, shell: null, hash: null },
    };
  }

  readonly groups = new Map<string, TaskGroupInfo>();
  private groupListeners = new Set<(group: TaskGroupInfo) => void>();

  async taskGroupCreate(input: TaskGroupCreateInput): Promise<{ group_id: string; tasks: Task[] }> {
    await this.wait("taskGroupCreate", input);
    this.requireProject(input.project_id);
    if (input.profile_ids.length < 2) throw new ProjectsError("WorktreeFailed", "A group needs at least two agents.");
    const groupId = `grp_${this.nextTask++}`;
    const group: TaskGroupInfo = {
      id: groupId,
      project_id: input.project_id,
      name: input.name,
      prompt: input.prompt,
      picked_task_id: null,
      created_at: Math.floor(Date.now() / 1000),
    };
    this.groups.set(groupId, group);
    const tasks: Task[] = [];
    for (const profileId of input.profile_ids) {
      const result = await this.taskCreate({
        project_id: input.project_id,
        name: `${input.name} ${profileId}`,
        prompt: input.prompt,
        base_branch: input.base_branch,
        agents: [{ profile_id: profileId }],
        use_main_checkout: false,
        run_setup: false,
      });
      const task = result.tasks[0];
      if (task) {
        const stored = this.tasks.find((t) => t.id === task.id);
        if (stored) {
          stored.group_id = groupId;
          this.emit(stored);
        }
        tasks.push(task);
      }
    }
    this.emitGroup(group);
    return { group_id: groupId, tasks };
  }

  async taskGroupsList(projectId: string | null): Promise<TaskGroupInfo[]> {
    return [...this.groups.values()].filter((g) => projectId === null || g.project_id === projectId);
  }

  async taskGroupPick(groupId: string, taskId: string): Promise<TaskGroupInfo> {
    const group = this.groups.get(groupId);
    if (!group) throw new ProjectsError("Unknown", "Group not found");
    group.picked_task_id = taskId;
    this.emitGroup(group);
    return { ...group };
  }

  onTaskGroupChanged(listener: (group: TaskGroupInfo) => void): Promise<() => void> {
    this.groupListeners.add(listener);
    return Promise.resolve(() => this.groupListeners.delete(listener));
  }

  private emitGroup(group: TaskGroupInfo) {
    for (const listener of this.groupListeners) listener({ ...group });
  }

  async taskList(filter: TaskFilter): Promise<TaskSummary[]> {
    await this.wait("taskList", filter);
    return this.tasks
      .filter((task) => task.state !== "deleted")
      .filter((task) => (filter.project_id ? task.project_id === filter.project_id : true))
      .filter((task) => filter.include_archived || task.state !== "archived")
      .map((task) => this.summary(task));
  }

  async taskRename(id: string, name: string): Promise<Task> {
    await this.wait("taskRename", id, name);
    const task = this.requireTask(id);
    if (name.trim() === "") throw new ProjectsError("Unknown", "The name cannot be empty.");
    task.name = name.trim();
    task.updated_at = this.now();
    this.emit(task);
    return this.plain(task);
  }

  async taskArchive(id: string): Promise<Task> {
    await this.wait("taskArchive", id);
    const task = this.requireTask(id);
    task.state = "archived";
    task.archived_at = this.now();
    task.updated_at = task.archived_at;
    task.port_start = null;
    this.emit(task);
    return this.plain(task);
  }

  async taskRestore(id: string): Promise<Task> {
    await this.wait("taskRestore", id);
    const task = this.requireTask(id);
    task.state = "active";
    task.archived_at = null;
    task.updated_at = this.now();
    this.emit(task);
    return this.plain(task);
  }

  async taskDelete(id: string, confirmLostCommits: boolean): Promise<void> {
    await this.wait("taskDelete", id, confirmLostCommits);
    const task = this.requireTask(id);
    if (task.unmerged.length > 0 && !confirmLostCommits) {
      throw new ProjectsError(
        "UnmergedCommits",
        `${task.branch} has ${task.unmerged.length} commits that are not merged.`,
        {
          commits: task.unmerged,
        },
      );
    }
    task.state = "deleted";
    task.updated_at = this.now();
    this.emit(task);
    this.tasks = this.tasks.filter((candidate) => candidate.id !== id);
  }

  async taskPorts(id: string): Promise<number[]> {
    await this.wait("taskPorts", id);
    return [...this.requireTask(id).ports];
  }

  /** Checkouts other than the project folder, by project path (tests seed it). */
  readonly extraWorktrees = new Map<string, WorktreeFacts[]>();

  async worktreeList(path: string): Promise<WorktreeFacts[]> {
    await this.wait("worktreeList", path);
    const root = path.replace(/[\\/]+$/, "");
    const facts = this.repos.get(root);
    return [
      { path: root, branch: facts?.branch ?? "main", detached: false, bare: false },
      ...(this.extraWorktrees.get(root) ?? []),
    ];
  }

  async worktreeRemove(projectPath: string, worktreePath: string, force: boolean): Promise<void> {
    await this.wait("worktreeRemove", projectPath, worktreePath, force);
    const root = projectPath.replace(/[\\/]+$/, "");
    const list = this.extraWorktrees.get(root) ?? [];
    this.extraWorktrees.set(
      root,
      list.filter((entry) => entry.path !== worktreePath),
    );
  }

  async gitBranches(path: string): Promise<string[]> {
    await this.wait("gitBranches", path);
    const facts = this.repos.get(path.replace(/[\\/]+$/, ""));
    return [
      ...new Set([
        facts?.default_branch ?? "main",
        facts?.branch ?? "main",
        "develop",
        "tessera/boss",
        "remotes/origin/main",
      ]),
    ];
  }

  async repoInfo(path: string): Promise<RepoFacts> {
    await this.wait("repoInfo", path);
    const root = path.replace(/[\\/]+$/, "");
    if (root.includes("not-a-repo") && !this.initialised.has(root))
      throw new ProjectsError("NotAGitRepo", `${root} is not a git repository.`, { canInit: true });
    const facts = this.repos.get(root);
    return {
      root,
      branch: facts?.branch ?? "main",
      default_branch: facts?.default_branch ?? "main",
      remote_url: facts?.remote_url ?? null,
      bare: false,
    };
  }

  async cancelClone(): Promise<void> {
    if (this.cancelCurrent) this.cancelCurrent();
    else if (this.cloning) this.cancelEarly = true;
  }

  async onTaskChanged(listener: (event: TaskChangedEvent) => void): Promise<Unsubscribe> {
    this.changed.add(listener);
    return () => {
      this.changed.delete(listener);
    };
  }

  async onCloneProgress(listener: (progress: CloneProgress) => void): Promise<Unsubscribe> {
    this.progress.add(listener);
    return () => {
      this.progress.delete(listener);
    };
  }

  // Test and demo helpers -----------------------------------------------------------------------------------------

  /** Changes a task behind the UI's back (a worktree changed on disk) and emits `task:changed`. */
  touchTask(
    id: string,
    patch: Partial<Pick<TaskSummary, "ahead" | "behind" | "changed_files" | "ports" | "state" | "last_message">>,
  ): void {
    const task = this.requireTask(id);
    Object.assign(task, patch);
    this.emit(task);
  }

  /** Marks commits as unmerged so deleting asks first. */
  setUnmerged(id: string, commits: CommitInfo[]): void {
    this.requireTask(id).unmerged = commits;
  }

  taskIds(): string[] {
    return this.tasks.map((task) => task.id);
  }

  // Internals ---------------------------------------------------------------------------------------------------

  private async wait(method: string, ...args: unknown[]): Promise<void> {
    this.calls.push({ method, args });
    if (this.latency > 0) await new Promise((resolve) => setTimeout(resolve, this.latency));
  }

  private requireProject(id: string): Project {
    const project = this.projects.find((candidate) => candidate.id === id);
    if (!project) throw new ProjectsError("NotFound", `Unknown project ${id}`);
    return project;
  }

  private requireTask(id: string): FakeTask {
    const task = this.tasks.find((candidate) => candidate.id === id);
    if (!task) throw new ProjectsError("NotFound", `Unknown task ${id}`);
    return task;
  }

  private setupInfo(project: Project): SetupInfo {
    return {
      state: project.setup_state,
      script: project.setup_script,
      shell: project.setup_shell,
      hash: fakeHash(project.setup_shell, project.setup_script).slice(0, SETUP_HASH_CHARS),
    };
  }

  private plain(task: FakeTask): Task {
    const { ahead: _a, behind: _b, changed_files: _c, ports: _p, unmerged: _u, ...rest } = task;
    return structuredClone(rest);
  }

  private summary(task: FakeTask): TaskSummary {
    const { unmerged: _unmerged, ...rest } = task;
    return structuredClone(rest);
  }

  private emit(task: FakeTask): void {
    const event: TaskChangedEvent = { task_id: task.id, summary: this.summary(task) };
    for (const listener of this.changed) listener(event);
  }

  private clone(url: string, dir: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.cancelEarly) {
        this.cancelEarly = false;
        this.cloning = false;
        reject(new ProjectsError("Cancelled", "The clone was cancelled."));
        return;
      }
      const name = baseName(url.replace(/\.git$/, ""));
      let percent = 0;
      const fail = (error: ProjectsError) => {
        this.cloneTimer = null;
        this.cancelCurrent = null;
        reject(error);
      };
      this.cancelCurrent = () => {
        if (this.cloneTimer) clearTimeout(this.cloneTimer);
        fail(new ProjectsError("Cancelled", "The clone was cancelled."));
      };
      const step = () => {
        if (url.includes("fail")) return fail(new ProjectsError("CloneFailed", `Could not read from ${url}.`));
        percent += 25;
        for (const listener of this.progress) listener({ percent, message: `Receiving objects: ${percent}%` });
        if (percent >= 100) {
          this.cloneTimer = null;
          this.cancelCurrent = null;
          resolve(`${dir.replace(/[\\/]+$/, "")}/${name}`);
        } else this.cloneTimer = setTimeout(step, Math.max(this.latency, 20));
      };
      this.cloneTimer = setTimeout(step, Math.max(this.latency, 20));
    });
  }

  private seed(): void {
    const shop = this.addDemoProject("shop-api", "/Users/you/code/shop-api", "main");
    const web = this.addDemoProject("web", "/Users/you/code/web", "main");
    this.addDemoProject("dotfiles", "/Users/you/code/dotfiles", "main").is_muted = true;
    // Checkouts git already had: Tessera lists them and warns, and never opens them by itself.
    this.extraWorktrees.set("/Users/you/code/shop-api", [
      { path: "/Users/you/code/shop-api-hotfix", branch: "hotfix/login", detached: false, bare: false },
    ]);
    this.extraWorktrees.set("/Users/you/code/web", [
      { path: "/Users/you/code/web-boss", branch: "tessera/boss", detached: false, bare: false },
    ]);
    shop.setup_script = "pnpm install\npnpm db:migrate";
    shop.setup_shell = "zsh";
    shop.setup_approved_hash = fakeHash("zsh", shop.setup_script);
    shop.setup_state = setupStateOf(shop);
    shop.copy_files = [
      { path: ".env", mode: "copy" },
      { path: "node_modules", mode: "symlink" },
    ];
    shop.port_base = 4000;
    this.scripts.push({
      id: `rs_${this.nextScript++}`,
      project_id: shop.id,
      name: "dev",
      command: "pnpm dev",
      auto_start: true,
      sort: 0,
    });
    const demo = (project: Project, name: string, extra: Partial<FakeTask> = {}) => {
      const slug = slugify(name);
      const created = this.now();
      this.tasks.push({
        id: `tsk_${this.nextTask++}`,
        project_id: project.id,
        group_id: null,
        name,
        slug,
        branch: branchFor(slug),
        base_branch: project.default_branch,
        worktree_path: `${project.path}-worktrees/${slug}`,
        uses_main_checkout: false,
        keeps_branch: false,
        state: "active",
        prompt: null,
        port_start: null,
        port_count: 10,
        last_message: null,
        created_at: created,
        updated_at: created,
        archived_at: null,
        ahead: 0,
        behind: 0,
        changed_files: 0,
        ports: [],
        unmerged: [],
        ...extra,
      });
    };
    demo(shop, "Fix checkout rounding", {
      ahead: 2,
      changed_files: 3,
      ports: [4000],
      unmerged: [
        { hash: "a1b2c3d", subject: "Round to cents" },
        { hash: "e4f5a6b", subject: "Add test" },
      ],
    });
    demo(shop, "Add order export", { ahead: 1, behind: 4, changed_files: 0 });
    demo(shop, "Main checkout", {
      uses_main_checkout: true,
      keeps_branch: false,
      worktree_path: null,
      branch: "main",
      slug: "main-checkout",
    });
    demo(shop, "Old spike", { state: "archived", archived_at: this.now() });
    demo(web, "Dark mode", { changed_files: 7 });
  }

  private addDemoProject(name: string, path: string, branch: string): Project {
    const project: Project = {
      id: `prj_${this.nextProject++}`,
      name,
      path,
      remote_url: null,
      default_branch: branch,
      worktree_dir: null,
      setup_script: null,
      setup_shell: null,
      setup_approved_hash: null,
      setup_state: "none",
      copy_files: [],
      port_base: null,
      default_profile_id: null,
      is_muted: false,
      sort: this.projects.length,
      work_mode: "worktrees",
      created_at: this.now(),
      updated_at: this.now(),
    };
    this.projects.push(project);
    return project;
  }
}
