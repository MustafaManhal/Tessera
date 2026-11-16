// Split-tree helpers. Every function returns a new tree and never mutates its input.
import type { LayoutNode, PaneId, PaneNode, SplitId, SplitNode } from "./types";

/** Pane ids in tree order (left to right, top to bottom). */
export function paneIds(node: LayoutNode): PaneId[] {
  if (node.type === "pane") return [node.id];
  return node.children.flatMap(paneIds);
}

export function splitNodes(node: LayoutNode): SplitNode[] {
  if (node.type === "pane") return [];
  return [node, ...node.children.flatMap(splitNodes)];
}

export function findPane(node: LayoutNode, paneId: PaneId): PaneNode | null {
  if (node.type === "pane") return node.id === paneId ? node : null;
  for (const child of node.children) {
    const found = findPane(child, paneId);
    if (found) return found;
  }
  return null;
}

export function findSplit(node: LayoutNode, splitId: SplitId): SplitNode | null {
  if (node.type === "pane") return null;
  if (node.id === splitId) return node;
  for (const child of node.children) {
    const found = findSplit(child, splitId);
    if (found) return found;
  }
  return null;
}

/** Child indices from the root to the pane, or null when the pane is not in this tree. */
export function pathToPane(node: LayoutNode, paneId: PaneId): number[] | null {
  if (node.type === "pane") return node.id === paneId ? [] : null;
  for (const [index, child] of node.children.entries()) {
    const rest = pathToPane(child, paneId);
    if (rest) return [index, ...rest];
  }
  return null;
}

/** The node at a path; undefined if the path leaves the tree. */
export function nodeAt(node: LayoutNode, path: readonly number[]): LayoutNode | undefined {
  let current: LayoutNode | undefined = node;
  for (const index of path) {
    if (current?.type !== "split") return undefined;
    current = current.children[index];
  }
  return current;
}

/** Replaces the node at `path` (an empty path replaces the root). */
export function replaceAt(node: LayoutNode, path: readonly number[], replacement: LayoutNode): LayoutNode {
  const [index, ...rest] = path;
  if (index === undefined) return replacement;
  if (node.type !== "split") return node;
  const child = node.children[index];
  if (!child) return node;
  const children = node.children.slice();
  children[index] = replaceAt(child, rest, replacement);
  return { ...node, children };
}

/** Applies `update` to the split with this id. */
export function updateSplit(node: LayoutNode, splitId: SplitId, update: (split: SplitNode) => SplitNode): LayoutNode {
  if (node.type === "pane") return node;
  if (node.id === splitId) return update(node);
  let changed = false;
  const children = node.children.map((child) => {
    const next = updateSplit(child, splitId, update);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

/** Applies `update` to every split. */
export function updateSplits(node: LayoutNode, update: (split: SplitNode) => SplitNode): LayoutNode {
  if (node.type === "pane") return node;
  return update({ ...node, children: node.children.map((child) => updateSplits(child, update)) });
}

export function equalRatios(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count);
}

/** Ratios that are positive, finite and sum to 1; equal shares when the input cannot be used. */
export function normalizeRatios(ratios: readonly number[], count: number): number[] {
  if (ratios.length !== count || ratios.some((r) => !Number.isFinite(r) || r <= 0)) return equalRatios(count);
  const sum = ratios.reduce((a, b) => a + b, 0);
  return ratios.map((r) => r / sum);
}

/**
 * Restores the tree invariants: a split with one child becomes that child; a split inside a split of the same
 * direction is merged into it (its shares scaled by its own share); ratios are fixed up to sum to 1.
 */
export function normalizeNode(node: LayoutNode): LayoutNode {
  if (node.type === "pane" || node.children.length === 0) return node;
  const shares = normalizeRatios(node.ratios, node.children.length);
  const children: LayoutNode[] = [];
  const ratios: number[] = [];
  node.children.forEach((child, index) => {
    const share = shares[index] ?? 0;
    const normal = normalizeNode(child);
    if (normal.type === "split" && normal.direction === node.direction) {
      normal.children.forEach((grandchild, j) => {
        children.push(grandchild);
        ratios.push(share * (normal.ratios[j] ?? 0));
      });
    } else {
      children.push(normal);
      ratios.push(share);
    }
  });
  const [only] = children;
  if (children.length === 1 && only) return only;
  return { ...node, children, ratios: normalizeRatios(ratios, children.length) };
}
