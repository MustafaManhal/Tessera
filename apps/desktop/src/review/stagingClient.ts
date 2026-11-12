import { commands, unwrap } from "@tessera/ipc";
import { isNativeRuntime } from "../native/runtime";
export interface IndexFile {
  path: string;
  old_path: string | null;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflict: boolean;
}
export interface Hunk {
  index: number;
  header: string;
  patch: string;
}
export interface CommitInfo {
  hash: string;
  output: string;
}
export interface StagingClient {
  index(taskId: string): Promise<IndexFile[]>;
  hunks(taskId: string, path: string, staged: boolean): Promise<Hunk[]>;
  stage(taskId: string, path: string, hunk: Hunk | null): Promise<void>;
  unstage(taskId: string, path: string, hunk: Hunk | null): Promise<void>;
  discard(taskId: string, path: string, hunk: Hunk | null, confirmed: boolean): Promise<void>;
  commit(taskId: string, message: string): Promise<CommitInfo>;
}
export class TauriStagingClient implements StagingClient {
  index(id: string) {
    return unwrap(commands.gitReviewIndex(id));
  }
  hunks(id: string, path: string, staged: boolean) {
    return unwrap(commands.gitReviewHunks(id, path, staged));
  }
  async stage(id: string, path: string, hunk: Hunk | null) {
    await unwrap(commands.gitStage(id, path, hunk));
  }
  async unstage(id: string, path: string, hunk: Hunk | null) {
    await unwrap(commands.gitUnstage(id, path, hunk));
  }
  async discard(id: string, path: string, hunk: Hunk | null, confirmed: boolean) {
    await unwrap(commands.gitDiscard(id, path, hunk, confirmed));
  }
  commit(id: string, message: string) {
    return unwrap(commands.gitCommit(id, message));
  }
}
interface Fixture {
  files: IndexFile[];
  unstaged: Record<string, Hunk[]>;
  staged: Record<string, Hunk[]>;
}
export class FakeStagingClient implements StagingClient {
  private fixtures = new Map<string, Fixture>();
  private serial = 1;
  calls: { method: string; taskId: string; path?: string; hunk?: number; message?: string }[] = [];
  hookFailure: string | null = null;
  set(taskId: string, files: IndexFile[], unstaged: Record<string, Hunk[]>, staged: Record<string, Hunk[]> = {}) {
    this.fixtures.set(taskId, structuredClone({ files, unstaged, staged }));
  }
  private fixture(id: string) {
    let row = this.fixtures.get(id);
    if (!row) {
      row = { files: [], unstaged: {}, staged: {} };
      this.fixtures.set(id, row);
    }
    return row;
  }
  async index(id: string) {
    return structuredClone(this.fixture(id).files);
  }
  async hunks(id: string, path: string, staged: boolean) {
    return structuredClone((staged ? this.fixture(id).staged : this.fixture(id).unstaged)[path] ?? []);
  }
  private mutate(id: string, path: string, hunk: Hunk | null, mode: "stage" | "unstage" | "discard") {
    const fixture = this.fixture(id),
      file = fixture.files.find((f) => f.path === path);
    if (!file) throw Error("The file has no index or working-tree changes.");
    const source = mode === "unstage" ? fixture.staged : fixture.unstaged;
    const target = mode === "unstage" ? fixture.unstaged : fixture.staged;
    const current = source[path] ?? [];
    const chosen = hunk ? current.filter((h) => h.index === hunk.index && h.patch === hunk.patch) : current;
    if (hunk && !chosen.length) throw Error("The hunk changed. Refresh before applying it.");
    source[path] = hunk ? current.filter((h) => !chosen.includes(h)) : [];
    source[path] = source[path].map((h, index) => ({ ...h, index }));
    if (mode !== "discard") target[path] = [...(target[path] ?? []), ...chosen].map((h, index) => ({ ...h, index }));
    if (mode === "stage") {
      file.staged = true;
      file.untracked = false;
      file.unstaged = (source[path]?.length ?? 0) > 0;
    }
    if (mode === "unstage") {
      file.unstaged = true;
      file.staged = (source[path]?.length ?? 0) > 0;
    }
    if (mode === "discard") {
      file.unstaged = (source[path]?.length ?? 0) > 0;
      if (!file.unstaged) file.untracked = false;
    }
    if (!file.staged && !file.unstaged && !file.untracked) fixture.files = fixture.files.filter((f) => f !== file);
    this.calls.push({ method: mode, taskId: id, path, hunk: hunk?.index });
  }
  async stage(id: string, path: string, hunk: Hunk | null) {
    this.mutate(id, path, hunk, "stage");
  }
  async unstage(id: string, path: string, hunk: Hunk | null) {
    this.mutate(id, path, hunk, "unstage");
  }
  async discard(id: string, path: string, hunk: Hunk | null, confirmed: boolean) {
    if (!confirmed) throw Error("Confirm discard first.");
    this.mutate(id, path, hunk, "discard");
  }
  async commit(id: string, message: string) {
    const f = this.fixture(id);
    if (!f.files.some((f) => f.staged)) throw Error("There are no staged changes to commit.");
    if (this.hookFailure) throw Error(`Git commit failed:\n${this.hookFailure}`);
    this.calls.push({ method: "commit", taskId: id, message });
    for (const file of f.files) file.staged = false;
    f.files = f.files.filter((file) => file.unstaged || file.untracked);
    f.staged = {};
    return { hash: (this.serial++).toString(16).padStart(40, "0"), output: message };
  }
}
declare global {
  interface Window {
    __tesseraStaging?: FakeStagingClient;
  }
}
const fake = new FakeStagingClient();
if (typeof window !== "undefined" && import.meta.env.DEV && !isNativeRuntime()) window.__tesseraStaging = fake;
let native: StagingClient | undefined;
export function stagingClient(): StagingClient {
  if (!isNativeRuntime()) return fake;
  native ??= new TauriStagingClient();
  return native;
}
