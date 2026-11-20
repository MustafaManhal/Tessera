import { expect, test, type Page } from "@playwright/test";

const port = Number(process.env.TESSERA_BRIDGE_PORT);
const token = process.env.TESSERA_BRIDGE_TOKEN;
const shell = process.env.TESSERA_REAL_SHELL;
const isWindows = process.platform === "win32";
const query = new URLSearchParams({
  pty: `ws://127.0.0.1:${port}`,
  token: token ?? "",
  renderer: "dom",
});
if (shell) query.set("shell", shell);

function shellCommands() {
  return isWindows
    ? {
        success: "$null = 1",
        failure: "cmd /c exit 1",
        cwd: "cd $env:TEMP",
        sleep: "Start-Sleep -Seconds 2",
        title: '[Console]::Write("$([char]27)]0;tessera-title$([char]7)")',
        flood: "1..100000",
        resize: '"$($Host.UI.RawUI.WindowSize.Height) $($Host.UI.RawUI.WindowSize.Width)"',
      }
    : {
        success: "true",
        failure: "false",
        cwd: "cd /tmp",
        sleep: "sleep 2",
        title: "printf '\\033]0;tessera-title\\a'",
        flood: "seq 1 100000",
        resize: "stty size",
      };
}

function engineScreen(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".xterm-rows"), (row) =>
      (row.textContent ?? "").replaceAll("\u00a0", " "),
    ).join("\n"),
  );
}

async function openTerminal(page: Page) {
  await page.goto(`/?${query.toString()}`);
  await expect.poll(() => engineScreen(page), { timeout: 30_000 }).toMatch(/(?:mock\$|[$%❯>] ?)\s*$/m);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea")))
    .toBe(true);
}

async function run(page: Page, command: string) {
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

async function finishedBlock(page: Page, command: string, status: "success" | "failure" = "success") {
  const index = async () =>
    page
      .locator(".block-row")
      .evaluateAll(
        (rows, expected) =>
          rows.findIndex(
            (row) =>
              row.getAttribute("data-status") === expected.status &&
              row.querySelector(".block-dot")?.getAttribute("title")?.startsWith(expected.command),
          ),
        { command, status },
      );
  await expect.poll(index, { timeout: 30_000 }).toBeGreaterThanOrEqual(0);
  return page.locator(".block-row").nth(await index());
}

const pageErrors: string[] = [];

test.beforeEach(async ({ page, context }) => {
  if (!port || !token) throw new Error("Use pnpm test:real-shell to start and configure the PTY bridge");
  pageErrors.length = 0;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openTerminal(page);
});

test.afterEach(() => {
  expect(pageErrors, "browser errors").toEqual([]);
});

test("shell prompt, output, successful and failing command blocks, and shell-provided title", async ({ page }) => {
  const commands = shellCommands();
  await run(page, "echo tessera-ok");
  await expect.poll(() => engineScreen(page)).toContain("tessera-ok");
  const success = await finishedBlock(page, "echo tessera-ok");
  await expect(success.locator(".block-dot")).toHaveAttribute("title", /Succeeded/);

  await run(page, commands.success);
  await finishedBlock(page, commands.success);
  await run(page, commands.failure);
  const failure = await finishedBlock(page, commands.failure, "failure");
  await expect(failure.locator(".block-dot")).toHaveAttribute("title", /Failed with exit code 1/);

  await run(page, commands.title);
  await expect(page).toHaveTitle(/tessera-title/);
  expect(await engineScreen(page)).not.toBe("");
});

test("long commands are timed, prompts can be jumped, output copied, blocks re-run and collapsed", async ({ page }) => {
  await page.evaluate(() =>
    (window as unknown as { __tesseraStore?: { dispatch(action: unknown): void } }).__tesseraStore?.dispatch({
      type: "settings/setTerminal",
      payload: { longCommandSeconds: 1 },
    }),
  );
  await page.evaluate(() => window.__tesseraWindowFocus?.(false));
  const sleepCommand = shellCommands().sleep;
  await run(page, sleepCommand);
  const sleep = await finishedBlock(page, sleepCommand);
  await expect(sleep.locator(".block-duration")).toHaveText(/^2\.\d+s$/);
  await expect
    .poll(
      () => page.evaluate(() => window.__tesseraNotifications?.shown.map((notice) => notice.body).join("\n") ?? ""),
      { timeout: 10_000 },
    )
    .toContain(`${sleepCommand} finished`);
  await page.evaluate(() => window.__tesseraWindowFocus?.(true));

  await run(page, "echo tessera-copy-me");
  const copied = await finishedBlock(page, "echo tessera-copy-me");
  await copied.locator(".block-dot").hover();
  await page.getByRole("toolbar", { name: "Block actions" }).getByRole("button", { name: "Copy output" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("tessera-copy-me");

  await page.keyboard.press("Control+Alt+Shift+E");
  await expect
    .poll(() =>
      page
        .locator(".block-row")
        .evaluateAll(
          (rows) =>
            rows.filter((row) =>
              row.querySelector(".block-dot")?.getAttribute("title")?.startsWith("echo tessera-copy-me"),
            ).length,
        ),
    )
    .toBe(2);
  await page.keyboard.press("Control+Shift+ArrowUp");
  await page.keyboard.press("Control+Shift+ArrowUp");
  await expect(copied).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Control+Alt+Shift+H");
  await expect(page.locator(".block-cover")).toBeVisible();
  await expect(page.locator(".block-cover")).toContainText("Expand");
});

test("cwd updates from the shell, new tabs inherit it, and terminal resizing preserves input", async ({ page }) => {
  const commands = shellCommands();
  const expectedCwd = isWindows ? (process.env.TEMP?.split(/[\\/]/).filter(Boolean).at(-1) ?? "Temp") : "/tmp";
  await run(page, commands.cwd);
  await expect(page.locator('[data-segment="cwd"]')).toContainText(expectedCwd);
  await page.keyboard.press("Control+Shift+T");
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.locator('[data-segment="cwd"]')).toContainText(expectedCwd);

  const columns = () =>
    page.evaluate(() => {
      const pane = document.querySelector('[role="tabpanel"]:not([hidden]) [data-terminal-pane]');
      const id = pane?.getAttribute("data-terminal-pane");
      return id ? (window.__tesseraPanes?.get(id)?.engine.cols ?? 0) : 0;
    });
  // The new tab fits itself after it mounts: measure the width only once it has settled, or the shrink check races it.
  let before = 0;
  await expect
    .poll(async () => {
      const first = await columns();
      await page.waitForTimeout(300);
      before = await columns();
      return first > 0 && first === before;
    })
    .toBe(true);
  await page.setViewportSize({ width: 800, height: 600 });
  await page.evaluate(() => {
    const pane = document.querySelector('[role="tabpanel"]:not([hidden]) [data-terminal-pane]');
    const id = pane?.getAttribute("data-terminal-pane");
    if (id) window.__tesseraPanes?.get(id)?.engine.fit();
  });
  await expect
    .poll(() => {
      return page.evaluate(() => {
        const pane = document.querySelector('[role="tabpanel"]:not([hidden]) [data-terminal-pane]');
        const id = pane?.getAttribute("data-terminal-pane");
        return id ? (window.__tesseraPanes?.get(id)?.engine.cols ?? 0) : 0;
      });
    })
    .toBeLessThan(before);
  const size = await page.evaluate(() => {
    const pane = document.querySelector('[role="tabpanel"]:not([hidden]) [data-terminal-pane]');
    const id = pane?.getAttribute("data-terminal-pane");
    const engine = id ? window.__tesseraPanes?.get(id)?.engine : undefined;
    return engine ? { cols: engine.cols, rows: engine.rows } : null;
  });
  expect(size).not.toBeNull();
  await run(page, commands.resize);
  await expect.poll(() => engineScreen(page)).toContain(`${size?.rows} ${size?.cols}`);
  await run(page, "echo resize-ok");
  await expect.poll(() => engineScreen(page)).toContain("resize-ok");
});

test("a 100,000-line flood stays responsive and the prompt returns", async ({ page }) => {
  await page.evaluate(() =>
    (window as unknown as { __tesseraStore?: { dispatch(action: unknown): void } }).__tesseraStore?.dispatch({
      type: "settings/setTerminal",
      payload: { scrollback: 120_000 },
    }),
  );
  const start = Date.now();
  await run(page, shellCommands().flood);
  await expect
    .poll(() => page.evaluate(() => document.querySelector('[role="tabpanel"]')?.isConnected ?? false))
    .toBe(true);
  await finishedBlock(page, shellCommands().flood);
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(90_000);
  await expect.poll(() => page.evaluate(() => document.querySelectorAll(".block-row").length)).toBeGreaterThan(0);
  expect(await engineScreen(page)).toContain("100000");
});
