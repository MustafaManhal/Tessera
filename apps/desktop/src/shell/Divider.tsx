// A draggable divider between two children of a split (APG window splitter): an 8 px hit area around a 1 px line in
// --border; arrows move it (Shift: a bigger step), Home and End move it to its limits, a double click equalizes the
// split. The ratio change goes through the reducer, which clamps it.
import { cn, t } from "@tessera/ui";
import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { type Divider as DividerModel, findSplit, paneIds, type Tab } from "../layout";
import { paneElementId, type Size } from "./dom";
import { useAppDispatch, useAppStore } from "../store/hooks";
import { layout } from "../store/layoutSlice";

/** Smallest pane, in pixels, a drag or key press may leave. */
export const MIN_PANE_PX = 80;
const STEP_PX = 16;
const BIG_STEP_PX = 64;

interface DividerProps {
  tab: Tab;
  divider: DividerModel;
  /** Size of the pane area in pixels (the divider's rects are in a unit square). */
  area: Size;
}

export function Divider({ tab, divider, area }: DividerProps) {
  const vertical = divider.direction === "row";
  const splitPx = vertical ? divider.splitRect.w * area.width : divider.splitRect.h * area.height;
  const minRatio = splitPx > 0 ? Math.min(0.45, MIN_PANE_PX / splitPx) : undefined;
  const drag = useRef<{ start: number; startRatio: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const dispatch = useAppDispatch();
  const store = useAppStore();

  const currentRatio = () => {
    const tabNow = store.getState().layout.tabs.find((t) => t.id === tab.id);
    const split = tabNow ? findSplit(tabNow.root, divider.splitId) : null;
    return split?.ratios[divider.index] ?? 0;
  };

  const resize = (delta: number) =>
    dispatch(layout({ type: "pane/resize", splitId: divider.splitId, index: divider.index, delta, minRatio }));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || splitPx <= 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    drag.current = { start: vertical ? event.clientX : event.clientY, startRatio: currentRatio() };
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const moved = (vertical ? event.clientX : event.clientY) - drag.current.start;
    // Aim at where the pointer is from where the drag began, so a clamped move never drifts.
    resize(drag.current.startRatio + moved / splitPx - currentRatio());
  };

  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const back = vertical ? "ArrowLeft" : "ArrowUp";
    const forward = vertical ? "ArrowRight" : "ArrowDown";
    const step = (event.shiftKey ? BIG_STEP_PX : STEP_PX) / Math.max(splitPx, 1);
    let delta = 0;
    if (event.key === back) delta = -step;
    else if (event.key === forward) delta = step;
    else if (event.key === "Home") delta = -1;
    else if (event.key === "End") delta = 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    resize(delta);
  };

  const split = findSplit(tab.root, divider.splitId);
  const before = split?.children[divider.index];
  const controls = before ? paneElementId(paneIds(before)[0] ?? "") : undefined;
  const half = "calc(var(--space-8) / 2)";

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot take focus or pointer drags; APG uses a separator role.
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={t("pane.resize")}
      aria-controls={controls}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(divider.position * 100)}
      data-split-id={divider.splitId}
      data-divider-index={divider.index}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => dispatch(layout({ type: "pane/equalize", splitId: divider.splitId }))}
      onKeyDown={onKeyDown}
      className={cn(
        "group absolute z-10 flex touch-none items-center justify-center outline-offset-0",
        vertical ? "w-2 cursor-col-resize" : "h-2 cursor-row-resize",
      )}
      style={
        vertical
          ? {
              left: `calc(${divider.x * 100}% - ${half})`,
              top: `${divider.y * 100}%`,
              height: `${divider.length * 100}%`,
            }
          : {
              top: `calc(${divider.y * 100}% - ${half})`,
              left: `${divider.x * 100}%`,
              width: `${divider.length * 100}%`,
            }
      }
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none bg-border transition-colors group-hover:bg-border-strong",
          vertical ? "h-full w-px" : "h-px w-full",
          dragging && "bg-accent-ink group-hover:bg-accent-ink",
        )}
      />
    </div>
  );
}
