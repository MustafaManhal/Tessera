import { expect, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { fakeLog, openTerminal, run, screen } from "./terminal-helpers";

// The terminal pane over the fake shell (M1.2): input and echo, resize, flow control under a flood, exit and
// restart, one session per pane, and closing a pane kills its session. DOM renderer forced (`?renderer=dom`).

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

test("typing reaches the shell as bytes and the echo comes back", async ({ page }) => {
  await openTerminal(page);
  await run(page, "echo hello from tessera");
  await expect.poll(() => screen(page)).toContain("hello from tessera\n");
  const log = await fakeLog(page);
  // Every keystroke went out as raw bytes: "e" is 0x65.
  expect(log.writes[0]?.bytes).toEqual([0x65]);
  // The cwd and title came back through OSC 7 and OSC 0.
  await expect(page.locator("footer")).toContainText("/home/you");
  await expect(page.getByRole("tab").first()).toHaveText("you");
});

test("the browser harness selects the Windows platform", async ({ page }) => {
  await openTerminal(page);
  await expect(page.locator("html")).toHaveAttribute("data-platform", "windows");
});

test("resizing the window changes the grid the shell sees", async ({ page }) => {
  await openTerminal(page);
  const first = (await fakeLog(page)).spawns[0];
  await page.setViewportSize({ width: 900, height: 600 });
  await expect.poll(async () => (await fakeLog(page)).resizes.length).toBeGreaterThan(0);
  const last = (await fakeLog(page)).resizes.at(-1);
  expect(last?.cols).toBeLessThan(first?.cols ?? 0);
  expect(last?.rows).toBeLessThan(first?.rows ?? 0);
});

test("the Windows title bar exposes keyboard-operable sidebar, split and palette controls", async ({ page }) => {
  await openTerminal(page);
  const titlebar = page.locator("header[data-tauri-drag-region]");
  await expect(titlebar.getByRole("button", { name: "Toggle sidebar" })).toBeVisible();
  await expect(titlebar.getByRole("button", { name: "Split right" })).toBeEnabled();
  await expect(titlebar.getByRole("button", { name: "Split down" })).toBeEnabled();
  await expect(titlebar.getByRole("button", { name: "Command palette" })).toBeEnabled();
  await titlebar.getByRole("button", { name: "Split right" }).click();
  await expect(page.locator(".xterm-rows")).toHaveCount(2);
});

test("a flood keeps the page responsive and acks keep the credit moving", async ({ page }) => {
  await openTerminal(page);
  await run(page, "flood 200000");
  await expect.poll(async () => (await fakeLog(page)).acks.length).toBeGreaterThan(5);
  // The UI answers during the flood: the sidebar toggles.
  const started = Date.now();
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toHaveCount(0);
  expect(Date.now() - started).toBeLessThan(2000);
  const acked = async () => (await fakeLog(page)).acks.reduce((sum, a) => sum + a.bytes, 0);
  const before = await acked();
  await expect.poll(acked).toBeGreaterThan(before);
  // Stop it, and the prompt comes back.
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+C");
  await expect.poll(() => screen(page)).toContain("^C");
});

test("exit shows the overlay; Restart and Enter respawn in the same cwd", async ({ page }) => {
  await openTerminal(page);
  await run(page, "cd /tmp");
  await run(page, "exit 3");
  const overlay = page.getByRole("status").filter({ hasText: "Process exited with code 3." });
  await expect(overlay).toBeVisible();
  await page.getByRole("button", { name: "Restart" }).click();
  await expect(overlay).toHaveCount(0);
  await expect.poll(async () => (await fakeLog(page)).spawns.length).toBe(2);
  expect((await fakeLog(page)).spawns[1]?.cwd).toBe("/tmp");
  await page.locator(".xterm-helper-textarea").focus();
  await run(page, "exit 0");
  await expect(page.getByText("Process exited with code 0.")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await fakeLog(page)).spawns.length).toBe(3);
});

test("two panes keep their own sessions; closing a pane kills its session", async ({ page }) => {
  await openTerminal(page);
  await page.keyboard.press("Control+Shift+D");
  await expect.poll(async () => (await fakeLog(page)).spawns.length).toBe(2);
  await expect(page.locator(".xterm-rows")).toHaveCount(2);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea")))
    .toBe(true);
  await run(page, "echo right");
  await page.keyboard.press("Control+Alt+ArrowLeft");
  await run(page, "echo left");
  const log = await fakeLog(page);
  const sessions = new Set(log.writes.map((w) => w.session));
  expect(sessions.size).toBe(2);
  await page.keyboard.press("Control+Shift+W");
  await expect.poll(async () => (await fakeLog(page)).kills.length).toBe(1);
  await expect(page.locator(".xterm-rows")).toHaveCount(1);
});

test("broadcast sends input only to the two selected panes and Escape stops it", async ({ page }) => {
  await openTerminal(page);
  await page.keyboard.press("Control+Shift+D");
  await page.keyboard.press("Control+Shift+E");
  const sections = page.locator('[role="tabpanel"]:not([hidden]) section[data-pane-id]:not([hidden])');
  await expect(sections).toHaveCount(3);
  await expect.poll(async () => (await fakeLog(page)).spawns.length).toBe(3);

  await page.getByRole("button", { name: "Broadcast input to panes", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Broadcasting to 1 panes");
  const selectors = sections.locator('input[type="checkbox"]');
  await expect(selectors).toHaveCount(3);
  await selectors.nth(0).setChecked(true);
  await selectors.nth(1).setChecked(true);
  await selectors.nth(2).setChecked(false);
  await expect(page.getByRole("status")).toContainText("Broadcasting to 2 panes");

  const phrase = "broadcast-check-19";
  await sections.nth(0).locator(".xterm-helper-textarea").focus();
  await run(page, `echo ${phrase}`);
  await expect.poll(() => screen(page, 0)).toContain(phrase);
  await expect.poll(() => screen(page, 1)).toContain(phrase);
  await expect.poll(() => screen(page, 2)).not.toContain(phrase);
  const pastePhrase = "paste-broadcast-check";
  await page.evaluate((text) => Array.from(window.__tesseraPanes?.values() ?? [])[0]?.paste(text), pastePhrase);
  await expect.poll(() => screen(page, 0)).toContain(pastePhrase);
  await expect.poll(() => screen(page, 1)).toContain(pastePhrase);
  await expect.poll(() => screen(page, 2)).not.toContain(pastePhrase);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("status")).toHaveCount(0);
  await run(page, "echo after-broadcast");
  await expect.poll(() => screen(page, 0)).toContain("after-broadcast");
  await expect.poll(() => screen(page, 1)).not.toContain("after-broadcast");
  await expect.poll(() => screen(page, 2)).not.toContain("after-broadcast");
});

test("Escape closes an open dialog before stopping broadcast", async ({ page }) => {
  await openTerminal(page);
  await page.getByRole("button", { name: "Broadcast input to panes", exact: true }).click();
  await page.keyboard.press("Control+K");
  await expect(page.getByRole("combobox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("combobox")).toBeHidden();
  await expect(page.getByRole("status")).toContainText("Broadcasting to 1 panes");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("broadcast skips an exited pane and holds input while paste confirmation is open", async ({ page }) => {
  await openTerminal(page);
  await page.keyboard.press("Control+Shift+D");
  await expect.poll(async () => (await fakeLog(page)).spawns.length).toBe(2);
  const sections = page.locator('[role="tabpanel"]:not([hidden]) section[data-pane-id]:not([hidden])');
  await sections.nth(1).locator(".xterm-helper-textarea").focus();
  await run(page, "exit 0");
  await expect(page.getByText("Process exited with code 0.")).toBeVisible();

  await page.getByRole("button", { name: "Broadcast input to panes", exact: true }).click();
  const selectors = sections.locator('input[type="checkbox"]');
  await selectors.nth(0).setChecked(true);
  await selectors.nth(1).setChecked(true);
  await sections.nth(0).locator(".xterm-helper-textarea").focus();
  const before = (await fakeLog(page)).writes.length;
  await page.keyboard.type("live-only");
  await expect.poll(async () => (await fakeLog(page)).writes.length).toBeGreaterThan(before);
  const writes = (await fakeLog(page)).writes.slice(before);
  expect(writes.length).toBe("live-only".length);
  expect(new Set(writes.map((write) => write.session))).toEqual(new Set(["fake-1"]));
  await expect.poll(() => screen(page, 0)).toContain("live-only");
  await expect.poll(() => screen(page, 1)).not.toContain("live-only");

  const textarea = sections.nth(0).locator(".xterm-helper-textarea");
  await textarea.evaluate((element) => {
    const data = new DataTransfer();
    data.setData("text/plain", "first line\nsecond line");
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: data }));
  });
  await expect(page.getByRole("alertdialog", { name: "Paste 2 lines?" })).toBeVisible();
  const heldWrites = (await fakeLog(page)).writes.length;
  await page.evaluate(() => {
    Array.from(window.__tesseraPanes?.values() ?? [])[0]?.engine.paste("blocked");
  });
  await expect.poll(async () => (await fakeLog(page)).writes.length).toBe(heldWrites);
});

test("a running command asks before the tab closes", async ({ page }) => {
  await openTerminal(page);
  await page.keyboard.press("Control+Shift+T");
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect.poll(() => screen(page)).toContain("$");
  await run(page, "serve");
  await expect.poll(() => screen(page)).toContain("Listening on");
  await page.keyboard.press("Control+F4");
  const dialog = page.getByRole("alertdialog", { name: "Close tab?" });
  await expect(dialog).toContainText("serve is still running.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.locator('[role="tabpanel"]:not([hidden]) .xterm-helper-textarea').focus();
  await page.keyboard.press("Control+C");
  await expect.poll(() => screen(page)).toContain("^C");
  await page.keyboard.press("Control+F4");
  await expect(page.getByRole("tab")).toHaveCount(1);
});

test("?placeholder still shows the placeholder", async ({ page }) => {
  await page.goto("/?placeholder");
  await expect(page.getByText("Terminal sessions start here in a later build.")).toBeVisible();
  await expect(page.locator(".xterm")).toHaveCount(0);
});
