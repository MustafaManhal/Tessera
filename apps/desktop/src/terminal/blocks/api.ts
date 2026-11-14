// What the rest of the app (registry actions, the pane menu, the gutter controls) can do with a pane's blocks.
// Every action takes a block id; without one it works on the current block (the one jumped to or clicked, else the
// last one that ran a command).
import type { Block } from "@tessera/term";

export interface BlockApi {
  current(): Block | null;
  block(id: number): Block | null;
  canJump(direction: "previous" | "next"): boolean;
  jump(direction: "previous" | "next"): void;
  commandText(id?: number): string | null;
  selectCommand(id?: number): void;
  selectOutput(id?: number): void;
  copyCommand(id?: number): Promise<void>;
  copyOutput(id?: number): Promise<void>;
  /** The block's output text (last 200 lines trimmed by the caller). */
  outputText(id?: number): Promise<{ text: string } | null>;
  /** Asks first when the block ran over a minute or the command has several lines. */
  rerun(id?: number): void;
  toggleCollapsed(id?: number): void;
  gutterVisible(): boolean;
  toggleGutter(): void;
}
