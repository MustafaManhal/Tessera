import { commands, unwrap } from "@tessera/ipc";
import type { Platform } from "@tessera/ui";
import { isNativeRuntime } from "../native/runtime";

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

/** Whether the web clipboard holds an image (the browser build, or when the native read fails). */
async function webClipboardHasImage(): Promise<boolean> {
  try {
    const items = await navigator.clipboard.read();
    return items.some((item) => item.types.some((type) => type.startsWith("image/")));
  } catch {
    return false;
  }
}

/**
 * The clipboard's text, or whether it holds an image, for a paste that has no native paste event (the right-click
 * menu, the palette, middle click). The app reads it natively: `navigator.clipboard.readText` would show WebView2's
 * "wants to see your clipboard" box on Windows and WebKit's extra Paste bubble on macOS.
 */
export async function readClipboard(): Promise<{ text: string; hasImage: boolean }> {
  if (isNativeRuntime()) {
    try {
      const content = await unwrap(commands.clipboardRead());
      return { text: content.text, hasImage: content.has_image };
    } catch {
      // Fall back to the web clipboard below.
    }
  }
  const text = await navigator.clipboard.readText().catch(() => "");
  return { text, hasImage: text === "" && (await webClipboardHasImage()) };
}
