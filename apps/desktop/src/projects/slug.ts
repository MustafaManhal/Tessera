// The task name → slug → branch rule, shown live in the new-task dialog and used by the fake backend. The real rule is
// Rust's (`tessera-git` `unique_slug`: lowercase, runs of other characters become `-`, trimmed, length limited); this
// mirrors it so the preview matches. Collisions get `-2`, `-3`… on the Rust side; the preview cannot know them.

export const SLUG_MAX = 40;
export const BRANCH_PREFIX = "tessera/";

export function slugify(name: string): string {
  const folded = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return folded.slice(0, SLUG_MAX).replace(/-+$/g, "");
}

export function branchFor(slug: string, prefix: string = BRANCH_PREFIX): string {
  return slug === "" ? "" : `${prefix}${slug}`;
}

/** The first free `base`, `base-2`, `base-3`… among `taken`. */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, SLUG_MAX - String(n).length - 1)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Why a copy-file path is not allowed, or null: relative, no `..`, no drive letter, not empty. */
export function copyPathProblem(path: string): "empty" | "absolute" | "parent" | "drive" | null {
  const trimmed = path.trim();
  if (trimmed === "") return "empty";
  if (/^[A-Za-z]:/.test(trimmed)) return "drive";
  if (trimmed.startsWith("/") || trimmed.startsWith("\\") || trimmed.startsWith("~")) return "absolute";
  if (trimmed.split(/[\\/]+/).includes("..")) return "parent";
  return null;
}
