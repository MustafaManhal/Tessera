import { expect, type Page, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { openTerminal, run, screen } from "./terminal-helpers";

// M1.5 over the fake shell: titles, notifications (OSC 9 / 99 / 777) through the recording sink, OSC 9;4 progress on
// the tab, OSC 52 clipboard policy, and inline images. "Desktop Chrome" reports Windows, so chords are Windows ones.

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

const shown = (page: Page) =>
  page.evaluate(() => (window.__tesseraNotifications?.shown ?? []).map((n) => ({ title: n.title, body: n.body })));
const setWindowFocus = (page: Page, focused: boolean | null) =>
  page.evaluate((value) => window.__tesseraWindowFocus?.(value), focused);
const firstTab = (page: Page) => page.getByRole("tab").first();
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

test("OSC 0/2 titles name the tab and the window", async ({ page }) => {
  await openTerminal(page);
  await expect(firstTab(page)).toContainText("you");
  await expect.poll(() => page.title()).toBe("you — Tessera");
  await run(page, "title Building shop");
  await expect(firstTab(page)).toContainText("Building shop");
  await expect.poll(() => page.title()).toBe("Building shop — Tessera");
});

test("a notification is a toast while you look at the pane, an OS notification otherwise", async ({ page }) => {
  await openTerminal(page);
  await run(page, "notify looking at it");
  await expect(page.getByText("looking at it", { exact: true })).toBeVisible();
  expect(await shown(page)).toEqual([]);
  await expect(firstTab(page).locator("[data-badge]")).toHaveCount(0);

  await setWindowFocus(page, false);
  await run(page, "notify 777 Tests passed");
  // The toast above started this pane's 5 s interval: this one waits for its end.
  await expect
    .poll(() => shown(page), { timeout: 8000 })
    .toEqual([{ title: "Tests passed · you", body: "from OSC 777" }]);
  await expect(firstTab(page).locator('[data-badge="notification"]')).toHaveCount(1);
  await expect(firstTab(page)).toContainText("New notification");

  // Within 5 s of the last one: folded into one, sent when the interval ends.
  await run(page, "notify 99 Deploy");
  await run(page, "notify third");
  await page.waitForTimeout(300);
  expect(await shown(page)).toHaveLength(1);
  await expect.poll(() => shown(page), { timeout: 8000 }).toHaveLength(2);
  expect((await shown(page))[1]).toEqual({ title: "you", body: "third (and 1 more)" });

  // Back in the window: the badge clears.
  await setWindowFocus(page, true);
  await expect(firstTab(page).locator("[data-badge]")).toHaveCount(0);
});

test("the first notification with an undecided permission explains and asks; a click focuses the pane", async ({
  page,
}) => {
  await openTerminal(page);
  await page.evaluate(() => {
    const sink = window.__tesseraNotifications;
    if (sink) sink.permissionState = "default";
  });
  await setWindowFocus(page, false);
  await run(page, "notify build finished");
  const dialog = page.getByRole("alertdialog", { name: "Show notifications from programs?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("at most one every 5 seconds per pane");
  await dialog.getByRole("button", { name: "Allow notifications" }).click();
  await expect.poll(() => shown(page)).toEqual([{ title: "you", body: "build finished" }]);
  expect(await page.evaluate(() => window.__tesseraNotifications?.requests)).toBe(1);
  await expect(dialog).toHaveCount(0);

  // Another tab is in front; clicking the notification brings the pane back.
  await page.keyboard.press("Control+Shift+T");
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("tab").nth(1)).toHaveAttribute("aria-selected", "true");
  await page.evaluate(() => window.__tesseraNotifications?.click(0));
  await expect(firstTab(page)).toHaveAttribute("aria-selected", "true");
});

test("OSC 9;4 progress shows on the tab in every state and clears", async ({ page }) => {
  await openTerminal(page);
  const ring = firstTab(page).locator("[data-progress-state]");
  await run(page, "progress 40");
  await expect(ring).toHaveAttribute("data-progress-state", "normal");
  await expect(ring).toHaveAttribute("data-progress-value", "40");
  await expect(firstTab(page)).toContainText("40% done");
  await run(page, "progress paused");
  await expect(ring).toHaveAttribute("data-progress-state", "paused");
  await expect(ring).toHaveAttribute("data-progress-value", "40");
  await run(page, "progress error");
  await expect(ring).toHaveAttribute("data-progress-state", "error");
  await run(page, "progress indeterminate");
  await expect(ring).toHaveAttribute("data-progress-state", "indeterminate");
  await expect(firstTab(page)).toContainText("Working");
  await run(page, "progress clear");
  await expect(ring).toHaveCount(0);
  const sink = await page.evaluate(() => window.__tesseraProgressSink ?? []);
  expect(sink.map((entry) => entry?.state ?? null)).toEqual([null, "normal", "paused", "error", "indeterminate", null]);
});

test("OSC 52: ask, deny copies nothing; allow copies; always allow stops asking; reads are blocked", async ({
  page,
}) => {
  await openTerminal(page);
  await page.evaluate(() => navigator.clipboard.writeText("before"));
  await run(page, "osc52 secret text");
  const bar = page.getByRole("alertdialog", { name: /A program wants to copy 11 characters/ });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("button", { name: "Deny" })).toBeFocused();
  await bar.getByRole("button", { name: "Deny" }).click();
  await expect(bar).toHaveCount(0);
  expect(await clipboard(page)).toBe("before");

  await run(page, "osc52 allowed once");
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect.poll(() => clipboard(page)).toBe("allowed once");

  await run(page, "osc52 first");
  await page.getByRole("button", { name: "Always allow" }).click();
  await expect.poll(() => clipboard(page)).toBe("first");
  expect(await page.evaluate(() => window.__tesseraStore?.getState().settings.terminal.osc52Write)).toBe("allow");
  await run(page, "osc52 no question");
  await expect.poll(() => clipboard(page)).toBe("no question");
  await expect(page.locator("[data-osc52-confirm]")).toHaveCount(0);

  await run(page, "osc52 --read");
  await expect(
    page.getByText("A program asked to read the clipboard. Tessera never allows that.").first(),
  ).toBeVisible();
  await run(page, "osc52 --big");
  await expect(page.getByText("A program tried to copy more than 1 MB. Tessera blocked it.").first()).toBeVisible();
  expect(await clipboard(page)).toBe("no question");
});

test("OSC 52 deny policy drops writes without asking", async ({ page }) => {
  await openTerminal(page);
  await page.evaluate(() => {
    navigator.clipboard.writeText("kept");
    window.__tesseraStore?.dispatch({ type: "settings/setTerminal", payload: { osc52Write: "deny" } });
  });
  await run(page, "osc52 nope");
  await expect.poll(() => screen(page)).toContain("osc52 nope");
  await page.waitForTimeout(200);
  await expect(page.locator("[data-osc52-confirm]")).toHaveCount(0);
  expect(await clipboard(page)).toBe("kept");
});

test("Sixel and iTerm2 images draw on the image layer; the setting turns them off", async ({ page }) => {
  await openTerminal(page);
  await run(page, "image");
  await expect(page.locator("canvas.xterm-image-layer")).toHaveCount(1);
  const painted = () =>
    page.locator("canvas.xterm-image-layer").evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const context = canvas.getContext("2d");
      if (!context) return 0;
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let count = 0;
      for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 0) count += 1;
      return count;
    });
  // The 24 × 12 Sixel plus the 24 × 24 PNG (decoded asynchronously).
  await expect.poll(painted).toBeGreaterThanOrEqual(24 * 12 + 24 * 24);
  await page.evaluate(() =>
    window.__tesseraStore?.dispatch({ type: "settings/setTerminal", payload: { images: false } }),
  );
  await expect(page.locator("canvas.xterm-image-layer")).toHaveCount(0);
  expect(await page.evaluate(() => Array.from(window.__tesseraPanes?.values() ?? [])[0]?.engine.imagesActive)).toBe(
    false,
  );
});
