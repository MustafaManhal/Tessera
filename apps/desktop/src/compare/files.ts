// Pure helpers for the compare view: the union of changed files across sibling tasks and per-diff +/- counts.

export interface UnionFile {
  path: string;
  /** How many of the group's tasks changed this file. */
  changedIn: number;
  /** Total tasks in the group. */
  total: number;
}

/** Union of per-task file lists, sorted; each entry counts in how many tasks the file changed. */
export function unionFiles(perTask: ReadonlyMap<string, readonly string[]>): UnionFile[] {
  const counts = new Map<string, number>();
  for (const files of perTask.values()) {
    for (const path of new Set(files)) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  const total = perTask.size;
  return [...counts.entries()]
    .map(([path, changedIn]) => ({ path, changedIn, total }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** +/− line counts of a unified diff body (ignores the +++/--- headers). */
export function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}
