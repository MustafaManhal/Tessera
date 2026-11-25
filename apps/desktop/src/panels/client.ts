// What the top-bar panels read: the editors on this computer, a folder's entries, and a folder's changed files. In the
// app they call the backend; in a browser (tests, the gallery) they answer from a small fixed sample.
import { commands, unwrap } from "@tessera/ipc";
import { isNativeRuntime } from "../native/runtime";

export interface EditorChoice {
  id: string;
  name: string;
  installed: boolean;
}
export interface FolderEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number | null;
}
export interface ChangedEntry {
  path: string;
  /** One letter: M modified, A added, D deleted, R renamed, ? new (untracked), U conflict. */
  letter: string;
  staged: boolean;
}
export interface Changes {
  branch: string | null;
  files: ChangedEntry[];
}

const SAMPLE_EDITORS: EditorChoice[] = [
  { id: "code", name: "Visual Studio Code", installed: true },
  { id: "cursor", name: "Cursor", installed: true },
  { id: "zed", name: "Zed", installed: false },
];

export async function listEditors(): Promise<EditorChoice[]> {
  if (!isNativeRuntime()) return SAMPLE_EDITORS;
  return commands.editorList();
}

const join = (folder: string, name: string) => `${folder.replace(/[\\/]+$/, "")}/${name}`;

export async function listFolder(path: string): Promise<FolderEntry[]> {
  if (!isNativeRuntime()) {
    const entry = (name: string, dir: boolean): FolderEntry => ({
      name,
      path: join(path, name),
      is_dir: dir,
      size: dir ? 0 : 120,
    });
    return path.endsWith("/src") ? [entry("main.ts", false)] : [entry("src", true), entry("README.md", false)];
  }
  return unwrap(commands.dirList(path));
}

function letterOf(file: { index: string; worktree: string; untracked: boolean; conflicted: boolean }): string {
  if (file.conflicted) return "U";
  if (file.untracked) return "?";
  const letter = file.index !== "." ? file.index : file.worktree;
  return letter && letter !== "." ? letter : "M";
}

export async function readChanges(path: string): Promise<Changes> {
  if (!isNativeRuntime()) {
    return { branch: "main", files: [{ path: "src/main.ts", letter: "M", staged: false }] };
  }
  const status = await unwrap(commands.gitStatus(path));
  return {
    branch: status.branch,
    files: status.files.map((file) => ({ path: file.path, letter: letterOf(file), staged: file.staged })),
  };
}
