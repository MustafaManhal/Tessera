// Pane and divider rectangles computed from the split tree. Directional focus uses these (geometry, not tree order),
// and the view positions panes and dividers with them.
import type { Direction, Divider, LayoutNode, PaneId, Rect, Tab } from "./types";

const EPSILON = 1e-6;
const UNIT: Rect = { x: 0, y: 0, w: 1, h: 1 };

export interface LayoutGeometry {
  panes: Map<PaneId, Rect>;
  dividers: Divider[];
}

/** Rects of every pane and divider when `node` fills `rect`. */
export function layoutGeometry(node: LayoutNode, rect: Rect = UNIT): LayoutGeometry {
  const geometry: LayoutGeometry = { panes: new Map(), dividers: [] };
  place(node, rect, geometry);
  return geometry;
}

function place(node: LayoutNode, rect: Rect, out: LayoutGeometry): void {
  if (node.type === "pane") {
    out.panes.set(node.id, rect);
    return;
  }
  const horizontal = node.direction === "row";
  const total = horizontal ? rect.w : rect.h;
  const last = node.children.length - 1;
  let offset = 0;
  let share = 0;
  node.children.forEach((child, index) => {
    const ratio = node.ratios[index] ?? 0;
    // The last child takes what is left, so rounding never leaves a gap.
    const size = index === last ? total - offset : ratio * total;
    const childRect = horizontal
      ? { x: rect.x + offset, y: rect.y, w: size, h: rect.h }
      : { x: rect.x, y: rect.y + offset, w: rect.w, h: size };
    place(child, childRect, out);
    offset += size;
    share += ratio;
    if (index < last) {
      out.dividers.push({
        splitId: node.id,
        index,
        direction: node.direction,
        x: horizontal ? rect.x + offset : rect.x,
        y: horizontal ? rect.y : rect.y + offset,
        length: horizontal ? rect.h : rect.w,
        splitRect: rect,
        position: share,
      });
    }
  });
}

/** Pane rects in pixels for a tab drawn at `width` × `height` (zoom ignored: this is the split layout). */
export function paneRects(tab: Tab, width: number, height: number): Record<PaneId, Rect> {
  const { panes } = layoutGeometry(tab.root, { x: 0, y: 0, w: width, h: height });
  return Object.fromEntries(panes);
}

const near = (a: number, b: number) => Math.abs(a - b) < EPSILON;
const overlap = (a: number, aSize: number, b: number, bSize: number) => Math.min(a + aSize, b + bSize) - Math.max(a, b);
const centre = (start: number, size: number) => start + size / 2;

/**
 * The pane next to `paneId` in `direction`: its edge must touch this pane's edge; the longest shared edge wins, then
 * the closest centre, then tree order. Null when nothing is there.
 */
export function neighbor(tab: Tab, paneId: PaneId, direction: Direction): PaneId | null {
  const { panes } = layoutGeometry(tab.root);
  const from = panes.get(paneId);
  if (!from) return null;
  let best: { id: PaneId; shared: number; distance: number } | null = null;
  for (const [id, rect] of panes) {
    if (id === paneId) continue;
    const vertical = direction === "up" || direction === "down";
    const touches =
      direction === "right"
        ? near(rect.x, from.x + from.w)
        : direction === "left"
          ? near(rect.x + rect.w, from.x)
          : direction === "down"
            ? near(rect.y, from.y + from.h)
            : near(rect.y + rect.h, from.y);
    if (!touches) continue;
    const shared = vertical ? overlap(from.x, from.w, rect.x, rect.w) : overlap(from.y, from.h, rect.y, rect.h);
    if (shared <= EPSILON) continue;
    const distance = vertical
      ? Math.abs(centre(rect.x, rect.w) - centre(from.x, from.w))
      : Math.abs(centre(rect.y, rect.h) - centre(from.y, from.h));
    const better =
      !best ||
      shared > best.shared + EPSILON ||
      (Math.abs(shared - best.shared) <= EPSILON && distance < best.distance - EPSILON);
    if (better) best = { id, shared, distance };
  }
  return best?.id ?? null;
}
