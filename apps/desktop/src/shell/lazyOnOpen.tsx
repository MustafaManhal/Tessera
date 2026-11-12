// Loads a rarely used screen after the first terminal is up (cold start, NFR-03): the code is fetched when the window is
// idle, or at the latest the first time the screen is opened. Once loaded it stays mounted, so its close animation and
// state work as before. `useOpen` is a hook that says whether the screen is wanted now.
import { type ComponentType, useEffect, useState } from "react";

/** Idle time to wait before fetching, in ms (the first shell is requested well before this). */
const IDLE_MS = 400;

export function lazyOnOpen(load: () => Promise<{ default: ComponentType }>, useOpen: () => boolean): ComponentType {
  let loaded: ComponentType | null = null;
  let loading: Promise<void> | null = null;
  const start = (): Promise<void> => {
    loading ??= load().then((module) => {
      loaded = module.default;
    });
    return loading;
  };
  // biome-ignore lint/correctness/noComponentHookFactories: called once per screen at module load, never during a render.
  return function LazyOnOpen() {
    const open = useOpen();
    const [, rerender] = useState(0);
    useEffect(() => {
      if (loaded) return;
      const done = () => void start().then(() => rerender((n) => n + 1));
      if (open) {
        done();
        return;
      }
      const useIdle = typeof window.requestIdleCallback === "function";
      const handle = useIdle
        ? window.requestIdleCallback(done, { timeout: IDLE_MS * 4 })
        : window.setTimeout(done, IDLE_MS);
      return () => {
        if (useIdle) window.cancelIdleCallback(handle);
        else window.clearTimeout(handle);
      };
    }, [open]);
    const Loaded = loaded;
    return Loaded ? <Loaded /> : null;
  };
}
