import type { Platform } from "@tessera/ui";

/**
 * Windows Terminal's convention for plain Ctrl+C and Ctrl+V:
 * - Ctrl+C copies while text is selected; with nothing selected it reaches the shell as an interrupt.
 * - Ctrl+V pastes. The terminal pane's paste handler then sends text, or, for a copied image, the Ctrl+V byte that
 *   agents such as Claude Code answer by reading the image from the clipboard themselves.
 *
 * The caller keeps the key from the terminal (which would send ^C or ^V) but lets the WebView run its native copy
 * or paste, so the pane's `copy`/`paste` handlers do the work: a native clipboard event needs no clipboard permission,
 * unlike `navigator.clipboard`. Matched on the physical key, so it works with any keyboard layout (Arabic, ...).
 * macOS keeps Cmd+C / Cmd+V, which never reach the shell.
 */
export function nativeClipboardKey(
  event: Pick<KeyboardEvent, "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">,
  hasSelection: boolean,
  platform: Platform,
): "copy" | "paste" | null {
  if (platform === "mac" || !event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return null;
  if (event.code === "KeyC") return hasSelection ? "copy" : null;
  if (event.code === "KeyV") return "paste";
  return null;
}

// Clipboard writes that may finish after an await (a big block's output is read in chunks). WebKit only lets a page
// write while handling the user's click or key; `ClipboardItem` with a promise keeps that permission while the text
// is still being built. Without ClipboardItem (older engines) it falls back to writeText.
export async function writeClipboard(text: string | Promise<string>): Promise<void> {
  if (typeof text === "string") {
    await navigator.clipboard.writeText(text);
    return;
  }
  if (typeof ClipboardItem !== "undefined" && typeof navigator.clipboard.write === "function") {
    const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
    return;
  }
  await navigator.clipboard.writeText(await text);
}
