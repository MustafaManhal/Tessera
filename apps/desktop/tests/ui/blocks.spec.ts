import { expect, type Page, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { fakeLog, openTerminal, run } from "./terminal-helpers";

// M2.2 command blocks over the fake shell (it prints OSC 133 A/B/C/D and OSC 633;E like the M2.1 integration scripts).
// "Desktop Chrome" reports Windows, so chords are the Windows ones.

const errors: string[] = [];

test.beforeEach(async ({ page, context }) => {
  errors.length = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockTauri(page);
});

test.afterEach(() => {
  expect(errors, "console errors").toEqual([]);
});

const rows = (page: Page, status?: string) =>
  page.locator(status ? `.block-row[data-status="${status}"]` : ".block-row");
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const engineValue = (page: Page, key: "viewportLine" | "bufferLength") =>
  page.evaluate((name) => Array.from(window.__tesseraPanes?.values() ?? [])[0]?.engine[name], key);
const currentBlock = (page: Page) =>
  page.evaluate(() => Array.from(window.__tesseraPanes?.values() ?? [])[0]?.blocks.current() ?? null);
const written = async (page: Page) => (await fakeLog(page)).writes.map((w) => String.fromCharCode(...w.bytes));

/** The colour a token resolves to, as getComputedStyle reports colours. */
const tokenColour = (page: Page, token: string) =>
  page.evaluate((name) => {
    const probe = document.createElement("div");
    probe.style.background = `var(${name})`;
    document.body.appendChild(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  }, token);
const dotColour = (page: Page, status: string) =>
  rows(page, status)
    .first()
    .locator(".block-dot")
    .evaluate((dot) => getComputedStyle(dot, "::before").backgroundColor);

test("dots: green for success, red for failure, a spinner while running, durations over 1 s", async ({ page }) => {
  await openTerminal(page);
  await expect(page.locator('[data-terminal][data-block-gutter="on"]')).toHaveCount(1);
  await run(page, "ok");
  await run(page, "fail 2");
  await expect(rows(page, "success")).toHaveCount(1);
  await expect(rows(page, "failure")).toHaveCount(1);
  expect(await dotColour(page, "success")).toBe(await tokenColour(page, "--st-done"));
  expect(await dotColour(page, "failure")).toBe(await tokenColour(page, "--st-error"));
  await expect(rows(page, "failure").locator(".block-dot")).toHaveAttribute(
    "title",
    /^fail 2: Failed with exit code 2, took \d+ms$/,
  );
  // The first block has no separator above it; the next one does.
  await expect(rows(page).first()).toHaveAttribute("data-first", "true");

  await run(page, "sleep 1.2");
  await expect(rows(page, "running")).toHaveCount(1);
  await expect(rows(page, "running").locator(".block-duration")).toHaveText("");
  await expect(rows(page, "success")).toHaveCount(2, { timeout: 5000 });
  await expect(rows(page, "success").last().locator(".block-duration")).toHaveText(/^1\.\ds$/);
  await expect(rows(page, "success").first().locator(".block-duration")).toHaveText("");
});

test("hovering a dot shows the block controls; a right click opens the block menu", async ({ page }) => {
  await openTerminal(page);
  await run(page, "echo hello world");
  await expect(rows(page, "success")).toHaveCount(1);
  await rows(page, "success").locator(".block-dot").hover();
  const toolbar = page.getByRole("toolbar", { name: "Block actions" });
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toContainText("echo hello world: Succeeded");
  await toolbar.getByRole("button", { name: "Copy output" }).click();
  await expect.poll(() => clipboard(page)).toBe("hello world");

  await rows(page, "success").locator(".block-dot").click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const agent = menu.getByRole("menuitem", { name: /Send to agent/ });
  await expect(agent).not.toHaveAttribute("aria-disabled", "true");
  await menu.getByRole("menuitem", { name: /Copy command/ }).click();
  await expect.poll(() => clipboard(page)).toBe("echo hello world");
});

test("Ctrl+Shift+Up/Down jump between prompts", async ({ page }) => {
  await openTerminal(page);
  // A prompt that scrolls away before the next frame gets its gutter row only when scrolled back into view, so this
  // waits on the blocks themselves.
  const finished = (command: string) =>
    expect.poll(
      async () => {
        const block = await currentBlock(page);
        return block?.command === command && block.status === "success";
      },
      { timeout: 10_000 },
    );
  await run(page, "flood 120");
  await finished("flood 120").toBe(true);
  await run(page, "ok");
  await finished("ok").toBe(true);
  await run(page, "flood 80");
  await finished("flood 80").toBe(true);

  await page.keyboard.press("Control+Shift+ArrowUp");
  expect((await currentBlock(page))?.command).toBe("flood 80");
  expect(await engineValue(page, "viewportLine")).toBe((await currentBlock(page))?.promptLine);
  await page.keyboard.press("Control+Shift+ArrowUp");
  expect((await currentBlock(page))?.command).toBe("ok");
  await expect(rows(page).filter({ has: page.locator('[title^="ok:"]') })).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Control+Shift+ArrowUp");
  expect((await currentBlock(page))?.command).toBe("flood 120");
  expect(await engineValue(page, "viewportLine")).toBe((await currentBlock(page))?.promptLine);
  await page.keyboard.press("Control+Shift+ArrowDown");
  expect((await currentBlock(page))?.command).toBe("ok");
  await page.keyboard.press("Control+Shift+ArrowDown");
  await page.keyboard.press("Control+Shift+ArrowDown");
  await page.keyboard.press("Control+Shift+ArrowDown");
  // Past the last prompt: back at the bottom.
  const [top, length] = [await engineValue(page, "viewportLine"), await engineValue(page, "bufferLength")];
  expect((top ?? 0) + 24).toBeGreaterThanOrEqual((length ?? 0) - 24);
});

test("copy output and copy command from the keyboard; a 50,000-line block copies in chunks", async ({ page }) => {
  await openTerminal(page);
  await run(page, "echo   spaced out   ");
  await expect(rows(page, "success")).toHaveCount(1);
  await page.keyboard.press("Control+Alt+Shift+O");
  await expect.poll(() => clipboard(page)).toBe("spaced out");
  await page.keyboard.press("Control+Alt+Shift+C");
  await expect.poll(() => clipboard(page)).toBe("echo   spaced out");

  await page.evaluate(() =>
    window.__tesseraStore?.dispatch({ type: "settings/setTerminal", payload: { scrollback: 60_000 } }),
  );
  await run(page, "flood 50000");
  await expect(rows(page, "success")).toHaveCount(2, { timeout: 60_000 });
  await page.keyboard.press("Control+Alt+Shift+O");
  await expect.poll(async () => (await clipboard(page)).split("\n").length, { timeout: 20_000 }).toBe(50_000);
  const text = await clipboard(page);
  expect(text.split("\n")[49_999]).toMatch(/^ {2}50000 the quick brown fox/);
  const perf = await page.evaluate(() => window.__tesseraPerf?.lastCopy);
  expect(perf?.lines).toBe(50_000);
  // Chunks of 5,000 lines: no single chunk holds the main thread for long.
  expect(perf?.longestChunkMs ?? 0).toBeLessThan(200);
  test.info().annotations.push({ type: "perf", description: JSON.stringify(perf) });
});

test("re-run writes the command; a multi-line command asks first", async ({ page }) => {
  await openTerminal(page);
  await run(page, "echo again");
  await expect(rows(page, "success")).toHaveCount(1);
  await page.keyboard.press("Control+Alt+Shift+E");
  await expect.poll(() => written(page)).toContain("echo again\r");
  await expect(rows(page, "success")).toHaveCount(2);

  await run(page, "echo one \\");
  await run(page, "two");
  await expect(rows(page, "success")).toHaveCount(3);
  expect((await currentBlock(page))?.command).toBe("echo one \\\ntwo");
  await page.keyboard.press("Control+Alt+Shift+E");
  const dialog = page.getByRole("alertdialog", { name: "Run this command again?" });
  await expect(dialog).toContainText("It has 2 lines");
  await dialog.getByRole("button", { name: "Run again" }).click();
  await expect.poll(() => written(page)).toContain("\x1b[200~echo one \\\rtwo\x1b[201~");
  await expect(rows(page, "success")).toHaveCount(4);
});

test("collapse covers the output, Find still finds it and expands the block", async ({ page }) => {
  await openTerminal(page);
  await run(page, "flood 30");
  await expect.poll(async () => (await currentBlock(page))?.status, { timeout: 10_000 }).toBe("success");
  await run(page, "ok");
  await expect.poll(async () => (await currentBlock(page))?.command).toBe("ok");
  await page.keyboard.press("Control+Shift+ArrowUp");
  await page.keyboard.press("Control+Shift+ArrowUp");
  expect((await currentBlock(page))?.command).toBe("flood 30");
  await page.keyboard.press("Control+Alt+Shift+H");
  const cover = page.locator(".block-cover");
  await expect(cover).toHaveCount(1);
  await expect(cover).toContainText("30 lines hidden · Expand");
  expect((await currentBlock(page))?.collapsed).toBe(true);
  // The palette names the action by state.
  await page.keyboard.press("Control+K");
  await page.keyboard.type("expand output");
  await expect(page.getByRole("option", { name: /Expand output/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("option")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea")))
    .toBe(true);

  await page.keyboard.press("Control+F");
  await page.keyboard.type("17 the quick");
  await page.keyboard.press("Enter");
  await expect(cover).toHaveCount(0);
  expect((await currentBlock(page))?.collapsed).toBe(false);
  await page.keyboard.press("Escape");

  // The bar's Expand button works too.
  await page.keyboard.press("Control+Alt+Shift+H");
  await expect(cover).toHaveCount(1);
  await cover.locator("[data-block-expand]").click();
  await expect(cover).toHaveCount(0);
});

test("the gutter goes away with the pane toggle and with the setting", async ({ page }) => {
  await openTerminal(page);
  await run(page, "ok");
  await expect(rows(page, "success")).toHaveCount(1);
  await page.keyboard.press("Control+Alt+Shift+B");
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator('[data-terminal][data-block-gutter="off"]')).toHaveCount(1);
  await page.keyboard.press("Control+Alt+Shift+B");
  await expect(rows(page, "success")).toHaveCount(1);
  await page.evaluate(() =>
    window.__tesseraStore?.dispatch({ type: "settings/setTerminal", payload: { blockGutter: false } }),
  );
  await expect(rows(page)).toHaveCount(0);
  // Blocks are still tracked: the actions keep working without the gutter.
  await page.keyboard.press("Control+Alt+Shift+O");
  await expect.poll(() => clipboard(page)).toContain("12 checks passed");
});
