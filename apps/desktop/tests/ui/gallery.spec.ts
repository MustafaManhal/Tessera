import { join } from "node:path";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";

// The dev-only component gallery (`/?gallery`): every base component renders in both themes, works from the
// keyboard and shows a focus ring. Screenshots go to the test output folder, or to TESSERA_SHOTS_DIR when set.

async function shot(page: Page, testInfo: TestInfo, name: string, fullPage = true): Promise<void> {
  const dir = process.env.TESSERA_SHOTS_DIR;
  const path = dir ? join(dir, name) : testInfo.outputPath(name);
  await page.screenshot({ path, fullPage, animations: "disabled" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function openGallery(page: Page, theme: "light" | "dark") {
  await page.goto("/?gallery");
  await page.getByRole("button", { name: theme === "light" ? "Light" : "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

/** The element with focus, its outline style and width. */
function focusedOutline(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const style = getComputedStyle(el);
    return {
      name: el.getAttribute("aria-label") ?? el.textContent?.trim(),
      style: style.outlineStyle,
      width: style.outlineWidth,
    };
  });
}

test.beforeEach(async ({ page }) => {
  await mockTauri(page);
});

for (const theme of ["light", "dark"] as const) {
  for (const [width, height] of [
    [1280, 800],
    [900, 600],
  ] as const) {
    test(`gallery renders in ${theme} at ${width}×${height}`, async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize({ width, height });
      await openGallery(page, theme);

      for (const section of ["Button", "IconButton", "Tooltip", "Kbd", "Input", "Switch", "Select", "Dialog"]) {
        await expect(page.getByRole("region", { name: section, exact: true })).toBeVisible();
      }
      for (const label of ["Working", "Needs you", "Done", "Error", "Not running"]) {
        await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
      }
      const background = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
      expect(background).toBe(theme === "light" ? "rgb(250, 250, 250)" : "rgb(0, 0, 0)");

      // Nothing pushes the page sideways at this width.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);

      await shot(page, testInfo, `gallery-${theme}-${width}.png`);
      expect(errors).toEqual([]);
    });
  }
}

test("system theme follows prefers-color-scheme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/?gallery");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.*/);
  const background = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  expect(background).toBe("rgb(0, 0, 0)");
});

test("keyboard: Tab shows the focus ring, a tooltip shows label and shortcut", async ({ page }, testInfo) => {
  await openGallery(page, "light");
  const sidebar = page.getByRole("button", { name: "Toggle sidebar" });
  // Reach it with a real Tab from the control before it (the long-label button), as a keyboard user would. The
  // window is tall enough that focusing does not scroll: a scroll closes tooltips (Radix), which would race this.
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByRole("button", { name: /^Start the agent in a new worktree/ }).focus();
  await page.keyboard.press("Tab");
  await expect(sidebar).toBeFocused();
  const ring = await focusedOutline(page);
  expect(ring).toMatchObject({ name: "Toggle sidebar", style: "solid", width: "2px" });
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("Toggle sidebar");
  await expect(tooltip).toContainText(/⌘B|Ctrl\+B/);
  await shot(page, testInfo, "focus.png", false);

  // Disabled controls are skipped by Tab.
  await page.getByRole("button", { name: "Settings" }).first().focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "New tab" }).first()).toBeFocused();
});

test("keyboard: loading button keeps focus and ignores Enter", async ({ page }) => {
  await openGallery(page, "light");
  const loading = page.locator('button[aria-busy="true"]').first();
  await loading.focus();
  await expect(loading).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(loading).toBeFocused();
  await expect(loading).toHaveAttribute("aria-disabled", "true");
});

test("keyboard: dialog traps focus and closes with Esc", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await openGallery(page, "dark");
  const trigger = page.getByRole("button", { name: "Open dialog" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Task name" })).toBeFocused();
  await shot(page, testInfo, "dialog-dark-900.png", false);
  for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("keyboard: select opens, moves with arrows, skips disabled options", async ({ page }) => {
  await openGallery(page, "light");
  const select = page.getByRole("combobox", { name: "Agent" });
  await expect(select).toHaveText("codex");
  await select.focus();
  await page.keyboard.press("Enter");
  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  // The open list moves focus to the chosen option; keys go to the list from then on.
  await expect(page.getByRole("option", { name: "codex" })).toBeFocused();
  // codex → claude → gemini → (aider is disabled) → the long one.
  for (const next of ["claude", "gemini", "an agent with a very long name"]) {
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("option", { name: new RegExp(`^${next}`) })).toBeFocused();
  }
  await page.keyboard.press("Enter");
  await expect(listbox).toBeHidden();
  await expect(select).toContainText("an agent with a very long name");
  await expect(select).toBeFocused();
});

test("keyboard: switch toggles with Space", async ({ page }) => {
  await openGallery(page, "light");
  const toggle = page.getByRole("switch", { name: "Notifications" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "Telemetry (locked)" })).toBeDisabled();
});

test("toasts stack, copy details and undo", async ({ page, context }, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openGallery(page, "light");
  await page.getByRole("button", { name: "Three at once" }).click();
  const toasts = page.getByRole("region", { name: /Notifications/ }).getByRole("listitem");
  await expect(toasts).toHaveCount(3);
  await shot(page, testInfo, "toasts-light.png", false);

  // F8 jumps to the toast region, which shows the focus ring.
  await page.keyboard.press("F8");
  const region = await focusedOutline(page);
  expect(region).toMatchObject({ style: "solid", width: "2px" });
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("OL");

  await page.getByRole("button", { name: "Copy details" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("exit code 128");

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(toasts.filter({ hasText: "Restored fix-login" })).toBeVisible();
});
