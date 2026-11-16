import { expect, type Page, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { fakeLog, openTerminal, run } from "./terminal-helpers";

// M2.3 over the fake shell: OSC 7 cwd in the status bar and tab, new tabs, splits and restarts in that cwd, a foreign
// host ignored, and the long-command alert. "Desktop Chrome" reports Windows, so chords are the Windows ones.

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

const spawnCwds = async (page: Page) => (await fakeLog(page)).spawns.map((spawn) => spawn.cwd);
const shown = (page: Page) => page.evaluate(() => (window.__tesseraNotifications?.shown ?? []).map((n) => n.body));
const setWindowFocus = (page: Page, focused: boolean | null) =>
  page.evaluate((value) => window.__tesseraWindowFocus?.(value), focused);
const setTerminal = (page: Page, payload: Record<string, unknown>) =>
  page.evaluate((value) => window.__tesseraStore?.dispatch({ type: "settings/setTerminal", payload: value }), payload);

test("the cwd from OSC 7 shows in the status bar and tab, and new tabs, splits and restarts start there", async ({
  page,
}) => {
  await openTerminal(page);
  await run(page, "cd /home/you/shop api");
  // The fake shell sends it percent-encoded (file://localhost/home/you/shop%20api).
  await expect(page.locator('[data-segment="cwd"]')).toHaveText("/home/you/shop api");
  await expect(page.getByRole("tab").first()).toContainText("shop api");

  await page.keyboard.press("Control+Shift+D");
  await expect.poll(() => spawnCwds(page)).toEqual(["~", "/home/you/shop api"]);
  await page.keyboard.press("Control+Shift+T");
  await expect.poll(() => spawnCwds(page)).toEqual(["~", "/home/you/shop api", "/home/you/shop api"]);

  await run(page, "cd /tmp");
  await expect(page.locator('[data-segment="cwd"]')).toHaveText("/tmp");
  await run(page, "exit 1");
  await expect(page.getByText("Process exited with code 1.")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await spawnCwds(page)).at(-1)).toBe("/tmp");
});

test("an OSC 7 from another host (SSH) never becomes the cwd", async ({ page }) => {
  await openTerminal(page);
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __cwds: string[] }).__cwds = seen;
    const store = window.__tesseraStore;
    store?.subscribe(() => {
      for (const info of Object.values(store.getState().layout.panes)) seen.push(info.cwd);
    });
  });
  await run(page, "osc7 file://my-mac.local/Users/me/work");
  await run(page, "osc7 file://build-server/srv/app");
  await run(page, "osc7 file:///bad%ZZ");
  await expect(page.locator('[data-segment="cwd"]')).toHaveText("/home/you");
  const seen = await page.evaluate(() => (window as unknown as { __cwds: string[] }).__cwds);
  // The first host the pane reports is its own (trusted); the build server is not.
  expect(seen).toContain("/Users/me/work");
  expect(seen).not.toContain("/srv/app");
});

test("Windows drive and UNC OSC 7 paths display and seed new panes unchanged", async ({ page }) => {
  await openTerminal(page);
  await run(page, "cd C:\\Users\\me\\work");
  await expect(page.locator('[data-segment="cwd"]')).toHaveText("C:/Users/me/work");
  await expect(page.getByRole("tab").first()).toContainText("work");

  await page.keyboard.press("Control+Shift+T");
  await expect.poll(() => spawnCwds(page)).toEqual(["~", "C:/Users/me/work"]);
  await run(page, "cd \\\\server\\share\\project");
  await expect(page.locator('[data-segment="cwd"]')).toHaveText("\\\\server\\share\\project");
  await expect(page.getByRole("tab").last()).toContainText("project");

  await page.keyboard.press("Control+Shift+D");
  await expect.poll(() => spawnCwds(page)).toEqual(["~", "C:/Users/me/work", "\\\\server\\share\\project"]);
});

test("a long command that ends while you look elsewhere notifies once and badges the tab", async ({ page }) => {
  await openTerminal(page);
  await setTerminal(page, { longCommandSeconds: 1 });

  // Looking at it: no alert.
  await run(page, "sleep 1.2");
  await page.waitForTimeout(1600);
  expect(await shown(page)).toEqual([]);

  await run(page, "sleep 1.3");
  await setWindowFocus(page, false);
  await expect.poll(() => shown(page), { timeout: 5000 }).toEqual(["sleep 1.3 finished in 1.3s, exit 0"]);
  const tab = page.getByRole("tab").first();
  await expect(tab.locator('[data-badge="finished"]')).toHaveCount(1);
  await expect(tab).toContainText("A command finished");

  // Short ones never alert; nor does anything with the switch off.
  await run(page, "ok");
  await setTerminal(page, { longCommandAlert: false });
  await run(page, "sleep 1.2");
  await page.waitForTimeout(1600);
  expect(await shown(page)).toHaveLength(1);

  await setWindowFocus(page, true);
  await expect(tab.locator("[data-badge]")).toHaveCount(0);
});

test("a long command in a background tab notifies even while the window is focused", async ({ page }) => {
  await openTerminal(page);
  await setTerminal(page, { longCommandSeconds: 1 });
  await run(page, "sleep 1.2");
  await page.keyboard.press("Control+Shift+T");
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect.poll(() => shown(page), { timeout: 5000 }).toEqual(["sleep 1.2 finished in 1.2s, exit 0"]);
  await expect(page.getByRole("tab").first().locator('[data-badge="finished"]')).toHaveCount(1);
  await page.getByRole("tab").first().click();
  await expect(page.getByRole("tab").first().locator("[data-badge]")).toHaveCount(0);
});
