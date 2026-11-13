// ProjectsClient: the project, run-script and task commands behind one interface, like PtyClient.
// - FakeProjectsClient (fake.ts): in memory, for the browser dev server (`?demo`) and tests.
// - TauriProjectsClient (tauri.ts): the real commands and task events through the generated IPC bindings.
import type {
  CloneProgress,
  Project,
  ProjectInput,
  ProjectPatch,
  RepoFacts,
  RunScript,
  RunScriptInput,
  Task,
  TaskChangedEvent,
  TaskCreateInput,
  WorktreeDetail,
  WorktreeFacts,
  TaskCreateResult,
  TaskGroupCreateInput,
  TaskGroupInfo,
  TaskFilter,
  TaskSummary,
  RemoteProjectInput,
} from "./types";

export type Unsubscribe = () => void;

export interface ProjectsClient {
  projectList(): Promise<Project[]>;
  /** Rejects with ProjectsError: NotAGitRepo (maybe `canInit`), AlreadyAdded, CloneFailed, Cancelled. */
  projectAdd(input: ProjectInput): Promise<Project>;
  /** Adds a repository on an SSH host; tasks, worktrees and agents then run there (M10.2). */
  projectAddRemote(input: RemoteProjectInput): Promise<Project>;
  /** `git init` for a folder `projectAdd` refused with `canInit`. */
  projectGitInit(path: string): Promise<void>;
  projectUpdate(id: string, patch: ProjectPatch): Promise<Project>;
  /** Never deletes worktrees; resolves to how many tasks still have one. */
  projectRemove(id: string): Promise<{ tasks_with_worktrees: number }>;
  /** Approves the current setup script and shell (their hash). */
  projectApproveSetup(id: string): Promise<Project>;
  runScriptList(projectId: string): Promise<RunScript[]>;
  runScriptAdd(projectId: string, input: RunScriptInput): Promise<RunScript>;
  runScriptUpdate(id: string, patch: Partial<RunScriptInput>): Promise<RunScript>;
  runScriptRemove(id: string): Promise<void>;
  /** Rejects with BranchExists, WorktreeFailed, SetupNotApproved. */
  taskCreate(input: TaskCreateInput): Promise<TaskCreateResult>;
  /** Best-of-N (FR-36): one prompt, N agents in N worktrees under one group. Errors: task.branch_exists,
   *  task.worktree_failed, agent.profile_not_found, project.not_found. */
  taskGroupCreate(input: TaskGroupCreateInput): Promise<{ group_id: string; tasks: Task[] }>;
  taskGroupsList(projectId: string | null): Promise<TaskGroupInfo[]>;
  taskGroupPick(groupId: string, taskId: string): Promise<TaskGroupInfo>;
  onTaskGroupChanged(listener: (group: TaskGroupInfo) => void): Promise<Unsubscribe>;
  taskList(filter: TaskFilter): Promise<TaskSummary[]>;
  taskRename(id: string, name: string): Promise<Task>;
  taskArchive(id: string): Promise<Task>;
  taskRestore(id: string): Promise<Task>;
  /** Rejects with UnmergedCommits{list} unless `confirmLostCommits`. */
  taskDelete(id: string, confirmLostCommits: boolean): Promise<void>;
  taskPorts(id: string): Promise<number[]>;
  /** Facts about a folder inside a repo (`git_repo_info`); rejects with NotAGitRepo. */
  repoInfo(path: string): Promise<RepoFacts>;
  /** Local branches, then remote-tracking branches (`git_branches`). */
  gitBranches(path: string): Promise<string[]>;
  /** Every checkout of the repository, the project folder first (`worktree_list`). */
  worktreeList(path: string): Promise<WorktreeFacts[]>;
  /** Every worktree of the repository with its state, the project folder included (`worktree_details`). */
  worktreeDetails(path: string): Promise<WorktreeDetail[]>;
  /** Moves a linked worktree to a new folder. */
  worktreeMove(projectPath: string, worktreePath: string, newPath: string): Promise<void>;
  /** Detaches a worktree from its branch; the folder and files stay. */
  worktreeUnlink(projectPath: string, worktreePath: string): Promise<void>;
  /** Forgets worktrees whose folder is gone. */
  worktreePrune(projectPath: string): Promise<void>;
  /** Removes a linked worktree (never the project folder, never its branch); git refuses one with changes unless `force`. */
  worktreeRemove(projectPath: string, worktreePath: string, force: boolean): Promise<void>;
  /** Cancels a running clone (`projectAdd` then rejects with Cancelled). */
  cancelClone(): Promise<void>;
  onTaskChanged(listener: (event: TaskChangedEvent) => void): Promise<Unsubscribe>;
  onCloneProgress(listener: (progress: CloneProgress) => void): Promise<Unsubscribe>;
}
