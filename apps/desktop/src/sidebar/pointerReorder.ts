// Press, hold and move a project or a task in the sidebar, then let go to put it there. Built on pointer events, not
// HTML drag and drop: the desktop webview keeps native drag and drop for files (Tauri's drag-drop handler), which
// swallows HTML drag events on Windows, and a pointer drag also works with a trackpad's press-and-hold.
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";

export type DragKind = "project" | "task";

export interface DragItem {
  kind: DragKind;
  id: string;
  /** The task's project (tasks only move within their project). */
  projectId: string;
}

export interface DropTarget {
  id: string;
  /** Put the dragged item after the target instead of before it. */
  after: boolean;
}

/** How far the pointer moves (px) before a press becomes a drag; less is a click. */
export const DRAG_THRESHOLD = 5;

/** Which row the pointer is over, and whether over its top or bottom half. Pure, for unit tests. */
export function dropTargetAt(
  item: DragItem,
  element: Element | null,
  y: number,
): { id: string; after: boolean; rect: DOMRect } | null {
  if (!element) return null;
  const selector = item.kind === "project" ? "[data-project-card]" : "[data-task]";
  const row = element.closest<HTMLElement>(selector);
  if (!row) return null;
  const id = item.kind === "project" ? row.dataset.projectCard : row.dataset.task;
  if (!id || id === item.id) return null;
  if (item.kind === "task" && row.dataset.taskProject !== item.projectId) return null;
  const rect = row.getBoundingClientRect();
  return { id, after: y > rect.top + rect.height / 2, rect };
}

/** `order` with `moved` taken out and put before or after `target`. */
export function reorderIds(order: readonly string[], moved: string, target: DropTarget): string[] {
  const next = order.filter((id) => id !== moved);
  const at = next.indexOf(target.id);
  if (at < 0) return [...next, moved];
  next.splice(target.after ? at + 1 : at, 0, moved);
  return next;
}

export function usePointerReorder(onDrop: (item: DragItem, target: DropTarget) => void) {
  const [dragging, setDragging] = useState<DragItem | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const press = useRef<{ item: DragItem; x: number; y: number; started: boolean } | null>(null);
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;
  const targetRef = useRef<DropTarget | null>(null);

  const stop = useCallback(() => {
    press.current = null;
    targetRef.current = null;
    setDragging(null);
    setTarget(null);
  }, []);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const current = press.current;
      if (!current) return;
      if (!current.started) {
        if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < DRAG_THRESHOLD) return;
        current.started = true;
        setDragging(current.item);
      }
      event.preventDefault();
      const hit = dropTargetAt(current.item, document.elementFromPoint(event.clientX, event.clientY), event.clientY);
      const next = hit ? { id: hit.id, after: hit.after } : null;
      const previous = targetRef.current;
      if (next?.id !== previous?.id || next?.after !== previous?.after) {
        targetRef.current = next;
        setTarget(next);
      }
    };
    const up = () => {
      const current = press.current;
      if (!current) return;
      const drop = targetRef.current;
      if (current.started) {
        // The release would also be a click on the row under it; that click must not open the task.
        const swallow = (event: MouseEvent) => {
          event.stopPropagation();
          event.preventDefault();
        };
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
        if (drop) dropRef.current(current.item, drop);
      }
      stop();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && press.current?.started) {
        event.preventDefault();
        stop();
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("keydown", key, true);
    };
  }, [stop]);

  /** Spread on a row: starts a possible drag on a primary-button press that is not on a button or a field. */
  const start = useCallback((item: DragItem) => {
    return (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey) return;
      if ((event.target as HTMLElement).closest("button, input, textarea, [role='menuitem']")) return;
      press.current = { item, x: event.clientX, y: event.clientY, started: false };
    };
  }, []);

  return { dragging, target, start };
}
