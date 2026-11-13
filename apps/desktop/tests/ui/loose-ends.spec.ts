import { expect, type Page, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { fakeLog, openTerminal } from "./terminal-helpers";

// Brief 08 part D: WebGL contexts follow pane visibility, and `terminal.paste_confirm`.

const errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await mockTauri(page);
});

test.afterEach(() => {
  expect(errors, "console errors").toEqual([]);
});

const renderers = (page: Page) =>
  page.evaluate(() => {
    const store = window.__tesseraStore?.getState();
    const visible = new Set(
      store?.layout.tabs.filter((tab) => tab.id === store.layout.activeTab).flatMap((tab) => [tab.focusedPane]) ?? [],
    );
    return Array.from(window.__tesseraPanes?.entries() ?? []).map(([id, pane]) => ({
      visible: visible.has(id),
      renderer: pane.engine.renderer,
    }));
  });

test("only panes on screen hold a WebGL context", async ({ page }) => {
  await openTerminal(page, "");
  const first = await renderers(page);
  test.skip(first[0]?.renderer !== "webgl", "no WebGL in this browser: the unit test with a counting stub covers it");
  for (let i = 0; i < 20; i++) await page.keyboard.press("Control+Shift+T");
  await expect.poll(async () => (await renderers(page)).length, { timeout: 20_000 }).toBe(21);
  await expect.poll(async () => (await renderers(page)).filter((pane) => pane.renderer === "webgl").length).toBe(1);
  const list = await renderers(page);
  expect(list.find((pane) => pane.visible)?.renderer).toBe("webgl");
  // Back to the first tab: it takes a context again, the one it leaves gives its back.
  await page.keyboard.press("Control+1");
  await expect.poll(async () => (await renderers(page)).filter((pane) => pane.renderer === "webgl").length).toBe(1);
  expect((await renderers(page)).find((pane) => pane.visible)?.renderer).toBe("webgl");
});

async function paste(page: Page, text: string) {
  await page.evaluate((value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    document
      .querySelector(".xterm-helper-textarea")
      ?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}
const written = async (page: Page) => (await fakeLog(page)).writes.map((w) => String.fromCharCode(...w.bytes)).join("");
const setPasteConfirm = (page: Page, mode: string) =>
  page.evaluate(
    (value) => window.__tesseraStore?.dispatch({ type: "settings/setTerminal", payload: { pasteConfirm: value } }),
    mode,
  );

test("terminal.paste_confirm: always asks even for one line, never does not ask", async ({ page }) => {
  await openTerminal(page);
  await setPasteConfirm(page, "always");
  await paste(page, "ls");
  const dialog = page.getByRole("alertdialog", { name: "Paste this text?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Paste", exact: true }).click();
  await expect.poll(() => written(page)).toContain("\x1b[200~ls\x1b[201~");

  await setPasteConfirm(page, "never");
  await paste(page, "echo a\necho b");
  await expect.poll(() => written(page)).toContain("\x1b[200~echo a\recho b\x1b[201~");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  await setPasteConfirm(page, "multiline");
  await paste(page, "pwd");
  await expect.poll(() => written(page)).toContain("\x1b[200~pwd\x1b[201~");
  await paste(page, "a\nb");
  await expect(page.getByRole("alertdialog", { name: "Paste 2 lines?" })).toBeVisible();
});
