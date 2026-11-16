import { commands, events, unwrap } from "@tessera/ipc";
import { isNativeRuntime } from "../native/runtime";
export interface ChangedFile {
  path: string;
  old_path: string | null;
  status: string;
  added: number;
  removed: number;
  is_binary: boolean;
}
export interface FileDiff {
  base_text: string | null;
  head_text: string | null;
  too_large: boolean;
  binary: boolean;
  conflict: boolean;
}
export interface ReviewClient {
  files(taskId: string): Promise<ChangedFile[]>;
  diff(taskId: string, path: string): Promise<FileDiff>;
  onChanged(fn: (taskId: string) => void): Promise<() => void>;
}
export class TauriReviewClient implements ReviewClient {
  files(taskId: string) {
    return unwrap(commands.reviewFiles(taskId));
  }
  diff(taskId: string, path: string) {
    return unwrap(commands.reviewFileDiff(taskId, path));
  }
  async onChanged(fn: (taskId: string) => void) {
    const offTask = await events.taskChanged.listen((event) => fn(event.payload.task_id));
    try {
      const offGit = await events.reviewGitChanged.listen((event) => fn(event.payload.task_id));
      return () => {
        offTask();
        offGit();
      };
    } catch (cause) {
      offTask();
      throw cause;
    }
  }
}
export class FakeReviewClient implements ReviewClient {
  private fixtures = new Map<string, { files: ChangedFile[]; diffs: Record<string, FileDiff> }>();
  private listeners = new Set<(id: string) => void>();
  calls: { method: string; taskId: string; path?: string }[] = [];
  set(taskId: string, files: ChangedFile[], diffs: Record<string, FileDiff>) {
    this.fixtures.set(taskId, structuredClone({ files, diffs }));
  }
  notify(taskId: string) {
    for (const listener of this.listeners) listener(taskId);
  }
  async files(taskId: string) {
    this.calls.push({ method: "files", taskId });
    return structuredClone(this.fixtures.get(taskId)?.files ?? []);
  }
  async diff(taskId: string, path: string) {
    this.calls.push({ method: "diff", taskId, path });
    return structuredClone(
      this.fixtures.get(taskId)?.diffs[path] ?? {
        base_text: "",
        head_text: "",
        too_large: false,
        binary: false,
        conflict: false,
      },
    );
  }
  async onChanged(fn: (id: string) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}
declare global {
  interface Window {
    __tesseraReview?: FakeReviewClient;
  }
}
const fake = new FakeReviewClient();
if (typeof window !== "undefined" && import.meta.env.DEV && !isNativeRuntime()) window.__tesseraReview = fake;
let native: ReviewClient | undefined;
export function reviewClient(): ReviewClient {
  if (!isNativeRuntime()) return fake;
  native ??= new TauriReviewClient();
  return native;
}
