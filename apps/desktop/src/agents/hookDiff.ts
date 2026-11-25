// Unified-diff line classification for the hook review dialog (M6.4). Kept pure so unit tests can pin it.
export type DiffLineKind = "add" | "remove" | "hunk" | "meta" | "context";

export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}

/** The diff as rows; a trailing newline does not produce a phantom empty row. */
export function diffLines(diff: string): string[] {
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
