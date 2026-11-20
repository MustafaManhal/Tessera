// DOM ids and small hooks shared by the shell components.
import { useEffect, useState } from "react";
import type { PaneId, TabId } from "../layout";

export const tabElementId = (tabId: TabId) => `tab-${tabId}`;
export const tabPanelId = (tabId: TabId) => `tabpanel-${tabId}`;
export const paneElementId = (paneId: PaneId) => `pane-${paneId}`;

/** Focuses a tab in the tab strip (after a keyboard move or a rename). */
export function focusTabElement(tabId: TabId): void {
  requestAnimationFrame(() => document.getElementById(tabElementId(tabId))?.focus({ preventScroll: false }));
}

export interface Size {
  width: number;
  height: number;
}

/** The element's content size, kept up to date with a ResizeObserver. */
export function useElementSize(element: HTMLElement | null): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    if (!element) return;
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

export function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}

/** Smooth scrolling unless the user asked for reduced motion. */
export function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}
