// TauriProjectsClient: the generated IPC bindings are the command and event contract.
import { listen } from "@tauri-apps/api/event";
import { type AppError_Serialize, commands, type CommandResult, events, unwrap } from "@tessera/ipc";
import type { ProjectsClient, Unsubscribe } from "./client";
import { mapProjectsError } from "./errors";
import type {
  CloneProgress,
  ProjectInput,
  ProjectPatch,
  RunScriptInput,
  TaskChangedEvent,
  TaskCreateInput,
  TaskCreateResult,
  Task,
  TaskFilter,
  TaskGroupCreateInput,
  TaskGroupInfo,
  RemoteProjectInput,
} from "./types";

function call<T>(result: Promise<CommandResult<T, AppError_Serialize>>): Promise<T> {
  return unwrap(result).catch((cause) => {
    throw mapProjectsError(cause);
  });
}

export class TauriProjectsClient implements ProjectsClient {
  projectList() {
    return call(commands.projectList());
  }
  projectAdd(input: ProjectInput) {
    return call(commands.projectAdd(input));
  }
  projectAddRemote(input: RemoteProjectInput) {
    return call(commands.projectAddRemote({ ...input, name: input.name ?? null }));
  }
  async projectGitInit(path: string) {
    await call(commands.projectGitInit(path));
  }
  projectUpdate(id: string, patch: ProjectPatch) {
    return call(commands.projectUpdate(id, patch));
  }
  projectRemove(id: string) {
    return call(commands.projectRemove(id));
  }
  projectApproveSetup(id: string) {
    return call(commands.projectApproveSetup(id));
  }
  runScriptList(projectId: string) {
    return call(commands.runScriptList(projectId));
  }
  runScriptAdd(projectId: string, input: RunScriptInput) {
    return call(commands.runScriptAdd(projectId, input));
  }
  runScriptUpdate(id: string, patch: Partial<RunScriptInput>) {
    return call(commands.runScriptUpdate(id, patch));
  }
  async runScriptRemove(id: string) {
    await call(commands.runScriptRemove(id));
  }
  async taskCreate(input: TaskCreateInput): Promise<TaskCreateResult> {
    return call(commands.taskCreate(input));
  }
  taskGroupCreate(input: TaskGroupCreateInput): Promise<{ group_id: string; tasks: Task[] }> {
    return call(commands.taskGroupCreate({ ...input, name: input.name.trim() === "" ? null : input.name }));
  }
  taskGroupsList(projectId: string | null): Promise<TaskGroupInfo[]> {
    return call(commands.taskGroupsList(projectId));
  }
  taskGroupPick(groupId: string, taskId: string): Promise<TaskGroupInfo> {
    return call(commands.taskGroupPick(groupId, taskId));
  }
  async onTaskGroupChanged(listener: (group: TaskGroupInfo) => void): Promise<Unsubscribe> {
    return events.taskGroupChanged.listen((event) => listener(event.payload));
  }
  taskList(filter: TaskFilter) {
    return call(commands.taskList(filter.project_id ?? null, filter.include_archived));
  }
  taskRename(id: string, name: string) {
    return call(commands.taskRename(id, name));
  }
  taskArchive(id: string) {
    return call(commands.taskArchive(id));
  }
  taskRestore(id: string) {
    return call(commands.taskRestore(id));
  }
  async taskDelete(id: string, confirmLostCommits: boolean) {
    await call(commands.taskDelete(id, confirmLostCommits));
  }
  taskPorts(id: string) {
    return call(commands.taskPorts(id));
  }
  repoInfo(path: string) {
    return call(commands.gitRepoInfo(path));
  }
  async cancelClone() {
    await call(commands.projectCloneCancel());
  }
  async onTaskChanged(listener: (event: TaskChangedEvent) => void): Promise<Unsubscribe> {
    return events.taskChanged.listen((event) => listener(event.payload));
  }
  async onCloneProgress(listener: (progress: CloneProgress) => void): Promise<Unsubscribe> {
    return listen<CloneProgress>("project:clone_progress", (event) => listener(event.payload));
  }
}
