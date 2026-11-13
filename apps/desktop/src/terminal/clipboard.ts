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
