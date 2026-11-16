// What a pane learns from the escape sequences its shell prints (pure, unit-tested; the parsers live in
// packages/term/src/osc):
// - OSC 7 `file://host/path` → the cwd (FR-25, the cwd of new tabs and splits).
// - Shell integration: OSC 633;E;<command line> (VS Code) names the command, OSC 133;C marks it started and
//   OSC 133;D;<code> finished. Between C and D a process runs in the foreground, so closing asks first (F-03 step 7).

import { decodeCommandLine } from "@tessera/term";

/** The path of an OSC 7 payload (any host), or null; panes use `createCwdFilter` from @tessera/term instead. */
export { parseOsc7 } from "@tessera/term";

export interface CommandTracker {
  /** Feeds an OSC 133 payload ("A", "B", "C", "D;0"); returns the running command when it changes, else undefined. */
  osc133(data: string): string | null | undefined;
  /** Feeds an OSC 633 payload ("E;npm run dev"). */
  osc633(data: string): void;
  readonly running: string | null;
}

/** The name shown for a command we could not name. */
export const UNNAMED_COMMAND = "a command";

export function createCommandTracker(): CommandTracker {
  let pending: string | null = null;
  let running: string | null = null;
  return {
    get running() {
      return running;
    },
    osc633(data) {
      pending = decodeCommandLine(data)?.trim() ?? (data.startsWith("E;") ? null : pending);
    },
    osc133(data) {
      const mark = data.split(";")[0];
      if (mark === "C") {
        const next = pending ?? UNNAMED_COMMAND;
        pending = null;
        if (next === running) return undefined;
        running = next;
        return running;
      }
      if (mark === "D" || mark === "A") {
        pending = mark === "A" ? null : pending;
        if (running === null) return undefined;
        running = null;
        return null;
      }
      return undefined;
    },
  };
}
