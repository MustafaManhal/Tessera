// The checkouts git already has for a project, and the ones Tessera did not make. Tessera never opens, changes or
// deletes those; it tells the user they exist.
import { useEffect, useState } from "react";
import { useAppSelector } from "../store/hooks";
import { projectsClient } from "./service";
import type { Project, WorktreeFacts } from "./types";

const same = (a: string, b: string) => a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");

/** All checkouts of the project's repository (the project folder first), or null while loading or when git fails. */
export function useCheckouts(project: Project | undefined): WorktreeFacts[] | null {
  const [list, setList] = useState<WorktreeFacts[] | null>(null);
  const taskCount = useAppSelector((state) => Object.keys(state.projects.tasks).length);
  const path = project?.path;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a changed task count means worktrees may have changed.
  useEffect(() => {
    if (!path) return;
    let live = true;
    projectsClient()
      .worktreeList(path)
      .then((found) => live && setList(found))
      .catch(() => live && setList(null));
    return () => {
      live = false;
    };
  }, [path, taskCount]);
  return list;
}

/** Checkouts that are neither the project folder nor a worktree of one of Tessera's tasks. */
export function useForeignWorktrees(project: Project | undefined): WorktreeFacts[] {
  const checkouts = useCheckouts(project);
  const tasks = useAppSelector((state) => state.projects.tasks);
  if (!project || !checkouts) return [];
  const own = Object.values(tasks)
    .map((task) => task.worktree_path)
    .filter((path): path is string => !!path);
  return checkouts.filter(
    (entry) => !entry.bare && !same(entry.path, project.path) && !own.some((path) => same(path, entry.path)),
  );
}
