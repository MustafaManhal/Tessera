// The dock badge (macOS) / taskbar overlay count (Windows): how many panes need the user right now.
import { commands, unwrap } from "@tessera/ipc";
import { isNativeRuntime } from "./runtime";

export async function setAttentionCount(count: number): Promise<void> {
  if (import.meta.env.DEV && typeof window !== "undefined") {
    (window as unknown as { __tesseraAttentionCount?: number[] }).__tesseraAttentionCount ??= [];
    (window as unknown as { __tesseraAttentionCount: number[] }).__tesseraAttentionCount.push(count);
  }
  if (isNativeRuntime()) await unwrap(commands.windowSetAttentionCount(count));
}
