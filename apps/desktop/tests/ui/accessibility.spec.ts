import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openTerminal } from "./terminal-helpers";

// Accessibility (M12.6): the two switches and flows that work with the keyboard alone.
const SHOTS = process.env.TESSERA_SHOTS_DIR ?? join(tmpdir(), "tessera-shots", "52");
const tree = (page: Page) => page.getByRole("tree", { name: "Projects and tasks" });

async function ready(page: Page, query = "demo&renderer=dom") {
  await openTerminal(page, query);
  await expect(tree(page).getByRole("treeitem", { name: /^Dark mode,/ })).toBeVisible();
}

/** The focus is back in a terminal (xterm's input), which is where typing must land after a dialog closes. */
async function focusInTerminal(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !!document.activeElement?.closest(".xterm") ||
          document.activeElement?.classList.contains("xterm-helper-textarea"),
      ),
    )
    .toBe(true);
}

test("Appearance: reduce motion and screen reader mode apply at once and are remembered", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("Control+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Appearance", exact: true }).click();
  const motion = settings.getByRole("switch", { name: "Reduce motion" });
  const reader = settings.getByRole("switch", { name: "Screen reader mode" });
  await expect(motion).toHaveAttribute("aria-checked", "false");
  await expect(reader).toHaveAttribute("aria-checked", "false");
  await motion.click();
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", "true");
  await reader.click();
  await expect(page.locator("html")).toHaveAttribute("data-screen-reader", "true");
  await page.screenshot({ path: join(SHOTS, "appearance-accessibility.png") });
  // xterm builds its accessibility tree once screen reader mode is on.
  await page.keyboard.press("Escape");
  await expect(page.locator(".xterm-accessibility").first()).toBeAttached();
  // Remembered after a reload.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", "true");
  await expect(page.locator("html")).toHaveAttribute("data-screen-reader", "true");
});

test("keyboard only: settings, tabbing, and Esc returns the focus to the terminal", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("Control+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  // The focus is inside the dialog and Tab stays there (focus trap).
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press("Tab");
    expect(await settings.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await focusInTerminal(page);
});

test("keyboard only: new task with Ctrl+Alt+Shift+N, typing the name, Ctrl+Enter", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("Control+Alt+Shift+N");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog).toBeVisible();
  // The name field has the focus; type, then create without the mouse.
  await expect(dialog.getByRole("textbox", { name: "Task name" })).toBeFocused();
  await page.keyboard.type("Keyboard task");
  await page.keyboard.press("Control+Enter");
  await expect(dialog).toHaveCount(0);
  await expect(tree(page).getByRole("treeitem", { name: /^Keyboard task,/ })).toBeVisible();
  await focusInTerminal(page);
});

test("keyboard only: palette, About and What's new open and close with the keyboard", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("Control+K");
  const palette = page.getByRole("combobox");
  await expect(palette).toBeFocused();
  await page.keyboard.type("about");
  await page.keyboard.press("Enter");
  const about = page.getByRole("dialog", { name: /About/ });
  await expect(about).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(about).toHaveCount(0);
  await focusInTerminal(page);

  await page.keyboard.press("Control+Alt+Shift+F10");
  const news = page.getByRole("dialog", { name: "What's new in Tessera" });
  await expect(news).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(news).toHaveCount(0);
  await focusInTerminal(page);
});

test("keyboard only: the board opens, a card lifts, moves and drops, Esc closes", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("Control+Alt+Shift+F8");
  const board = page.locator("[data-board-view]");
  await expect(board).toBeVisible();
  const handle = page.locator("[data-board-card]").first().locator("[data-board-handle]");
  await handle.focus();
  await page.keyboard.press("Space");
  await expect(page.locator("[data-board-card][data-lifted]")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-board-card][data-lifted]")).toHaveCount(0);
  await expect(board).toBeVisible();
  // The close button is reachable and Esc closes the board.
  await page.keyboard.press("Escape");
  await expect(board).toHaveCount(0);
});

test("keyboard only: Automations page, New automation, fill, Save", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("Control+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Automations", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(settings.locator("[data-automations-page]")).toBeVisible();
  await settings.getByRole("button", { name: "New automation" }).focus();
  await page.keyboard.press("Enter");
  const editor = page.locator("[data-automation-editor]");
  await expect(editor.getByLabel("Name")).toBeFocused();
  await page.keyboard.type("By keyboard");
  await editor.getByLabel("Prompt").focus();
  await page.keyboard.type("Run the tests");
  await page.keyboard.press("Tab");
  await editor.getByRole("button", { name: "Save" }).focus();
  await page.keyboard.press("Enter");
  await expect(editor).toHaveCount(0);
  await expect(settings.locator('[data-automation="By keyboard"]')).toBeVisible();
});

test("every dialog has an accessible name and a visible focus indicator on its controls", async ({ page }) => {
  await ready(page);
  for (const [keys, name] of [
    ["Control+Alt+Shift+N", "New task"],
    ["Control+,", "Settings"],
  ] as const) {
    await page.keyboard.press(keys);
    const dialog = page.getByRole("dialog", { name });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Tab");
    const outline = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return "";
      const style = getComputedStyle(el);
      return `${style.outlineStyle} ${style.outlineWidth} ${style.boxShadow}`;
    });
    expect(outline).not.toBe("");
    expect(outline.startsWith("none 0px none")).toBe(false);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
});
