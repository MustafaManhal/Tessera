// The window-level progress (OSC 9;4 from any pane) for the macOS dock and Windows taskbar.
import { commands, unwrap, type ProgressState } from "@tessera/ipc";
import type { PaneProgress } from "../store/attentionSlice";
import { isNativeRuntime } from "./runtime";

export interface ProgressSink {
  set(progress: PaneProgress | null): Promise<void>;
}

export interface ProgressCommands {
  set(state: ProgressState, value: number): Promise<void>;
}

declare global {
  interface Window {
    __tesseraProgressSink?: (PaneProgress | null)[];
  }
}

const nativeProgress: ProgressCommands = {
  async set(state, value) {
    await unwrap(commands.windowSetProgress(state, value));
  },
};

export function createProgressSink(
  native: ProgressCommands = nativeProgress,
  isNative: () => boolean = isNativeRuntime,
): ProgressSink {
  let last = "";
  let requested = "";
  let pending: Promise<void> = Promise.resolve();
  let current: Promise<void> | null = null;
  return {
    set(progress) {
      const key = progress ? `${progress.state}:${progress.value}` : "none";
      if (key === requested && current) return current;
      if (key === last && !current) return Promise.resolve();
      requested = key;
      if (import.meta.env.DEV && typeof window !== "undefined") {
        window.__tesseraProgressSink ??= [];
        window.__tesseraProgressSink.push(progress);
        console.debug("[progress sink]", progress ?? "cleared");
      }
      const request = pending
        .catch(() => {})
        .then(async () => {
          if (key === last) return;
          if (isNative()) await native.set(progress?.state ?? "none", progress?.value ?? 0);
          last = key;
        });
      pending = request;
      current = request;
      const clear = () => {
        if (current !== request) return;
        current = null;
        requested = last;
      };
      void request.then(clear, clear);
      return request;
    },
  };
}
