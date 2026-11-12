import type { ChangedFile } from "./client";
export interface TreeEntry {
  path: string;
  name: string;
  depth: number;
  file: ChangedFile | null;
}
export function fileTree(files: ChangedFile[]): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const folders = new Set<string>();
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const path = parts.slice(0, i).join("/");
      if (!folders.has(path)) {
        folders.add(path);
        entries.push({ path, name: parts[i - 1] ?? path, depth: i - 1, file: null });
      }
    }
    entries.push({ path: file.path, name: parts.at(-1) ?? file.path, depth: parts.length - 1, file });
  }
  return entries;
}
export function shouldAutoRefresh(dirty: boolean, hovering: boolean, busy: boolean) {
  return dirty && !hovering && !busy;
}
let open = false;
const listeners = new Set<() => void>();
export const reviewVisibility = {
  get: () => open,
  subscribe: (fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};
export function toggleReview() {
  open = !open;
  for (const fn of listeners) fn();
}
