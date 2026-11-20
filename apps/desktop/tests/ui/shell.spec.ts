import { join } from "node:path";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";

// The app shell (M3.1, M3.2, M4.3 front end) with real pointer and keyboard input. Playwright's "Desktop Chrome"
// reports Windows, so these use the Windows and Linux chords (Ctrl+Shift+…); one block at the end checks macOS.
// Screenshots go to the test output folder, or to TESSERA_SHOTS_DIR when set.

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const dir = process.env.TESSERA_SHOTS_DIR;
  const path = dir ? join(dir, name) : testInfo.outputPath(name);
  await page.screenshot({ path, animations: "disabled" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

const tabs = (page: Page) => page.getByRole("tab");
const panel = (page: Page) => page.locator('[role="tabpanel"]:not([hidden])');
const panes = (page: Page) => panel(page).locator("section[data-pane-id]:not([hidden])");
const dividers = (page: Page) => panel(page).locator('[role="separator"]');
const focusedPaneId = (page: Page) =>
  page.evaluate(() => document.activeElement?.closest<HTMLElement>("section[data-pane-id]")?.dataset.paneId ?? null);
const markedFocused = (page: Page) => panel(page).locator('section[data-focused="true"]').getAttribute("data-pane-id");

async function ready(page: Page) {
  // The shell flows run on the placeholder; terminal.spec.ts covers the real terminal.
  await page.goto("/?placeholder");
  await expect(panes(page)).toHaveCount(1);
  // The first pane takes keyboard focus on start.
  await expect.poll(() => focusedPaneId(page)).not.toBeNull();
}

/** Splits into a 2×2 grid: top-left, top-right, bottom-left, bottom-right (by their position on screen). */
async function grid(page: Page) {
  await page.keyboard.press("Control+Shift+D"); // split right
  await page.keyboard.press("Control+Shift+E"); // right column: split down
  await page.keyboard.press("Control+Alt+ArrowLeft");
  await page.keyboard.press("Control+Shift+E"); // left column: split down
  await expect(panes(page)).toHaveCount(4);
}

async function paneAt(page: Page, where: "top-left" | "top-right" | "bottom-left" | "bottom-right") {
  const boxes = await panes(page).evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { id: (element as HTMLElement).dataset.paneId ?? "", x: rect.x, y: rect.y };
    }),
  );
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const left = where.endsWith("left");
  const top = where.startsWith("top");
  return boxes.find((b) => (b.x === minX) === left && (b.y === minY) === top)?.id;
}

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

test.describe("tabs", () => {
  test("create with the button and the shortcut; the new tab is selected and its pane has focus", async ({ page }) => {
    await ready(page);
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await page.keyboard.press("Control+Shift+T");
    await expect(tabs(page)).toHaveCount(3);
    await expect(tabs(page).nth(2)).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => focusedPaneId(page)).toBe(await markedFocused(page));
  });

  test("the title bar exposes window actions and Windows caption controls", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/133.0.0.0 Safari/537.36",
      });
    });
    await ready(page);
    await expect(page.getByRole("button", { name: "Window", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Minimize window" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Maximize window" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close window" })).toBeVisible();

    await page.getByRole("button", { name: "Window", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: /^New window/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Move tab to new window" })).toBeEnabled();
    await expect(page.getByRole("menuitem", { name: "Move tab to window…" }).first()).toBeVisible();
  });

  test("rename: Enter commits, Esc cancels, F2 starts it", async ({ page }, testInfo) => {
    await ready(page);
    await tabs(page).first().dblclick();
    const input = page.getByRole("textbox", { name: "Tab name" });
    await expect(input).toBeFocused();
    await input.fill("api server");
    await shot(page, testInfo, "rename-light-1280.png");
    await input.press("Enter");
    await expect(tabs(page).first()).toHaveText("api server");
    await expect(tabs(page).first()).toBeFocused();

    await page.keyboard.press("F2");
    await input.fill("something else");
    await input.press("Escape");
    await expect(input).toBeHidden();
    await expect(tabs(page).first()).toHaveText("api server");
  });

  test("pin from the context menu: the tab moves left and loses its close button", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("Control+Shift+T");
    await page.keyboard.press("Control+Shift+T");
    const third = tabs(page).nth(2);
    const id = await third.getAttribute("data-tab-id");
    await third.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Pin tab" }).click();
    await expect(tabs(page).first()).toHaveAttribute("data-tab-id", id ?? "");
    await expect(tabs(page).first().getByRole("button", { name: "Close tab" })).toHaveCount(0);
    await tabs(page).first().click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Unpin tab" })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("close without a running process closes at once; middle click closes too", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("Control+Shift+T");
    await page.keyboard.press("Control+Shift+T");
    await tabs(page).nth(2).hover();
    await tabs(page).nth(2).getByRole("button", { name: "Close tab" }).click();
    await expect(tabs(page)).toHaveCount(2);
    await tabs(page).nth(1).click({ button: "middle" });
    await expect(tabs(page)).toHaveCount(1);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });

  test("close with a running process asks first; Cancel keeps it, Close closes it", async ({ page }, testInfo) => {
    await ready(page);
    await page.keyboard.press("Control+Shift+T");
    await panel(page).getByRole("button", { name: "Developer options" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Simulate a running process" }).click();
    await page.keyboard.press("Control+F4");
    const dialog = page.getByRole("alertdialog", { name: "Close tab?" });
    await expect(dialog).toContainText("npm run dev is still running.");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await shot(page, testInfo, "confirm-light-1280.png");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(tabs(page)).toHaveCount(2);

    await page.keyboard.press("Control+F4");
    await page.getByRole("alertdialog").getByRole("button", { name: "Close" }).click();
    await expect(tabs(page)).toHaveCount(1);
    await expect.poll(() => focusedPaneId(page)).not.toBeNull();
  });

  test("reorder by dragging", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("Control+Shift+T");
    await page.keyboard.press("Control+Shift+T");
    const ids = await tabs(page).evaluateAll((elements) => elements.map((e) => (e as HTMLElement).dataset.tabId));
    const from = await tabs(page).first().boundingBox();
    const to = await tabs(page).nth(2).boundingBox();
    if (!from || !to) throw new Error("no tab boxes");
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width - 10, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
    const after = await tabs(page).evaluateAll((elements) => elements.map((e) => (e as HTMLElement).dataset.tabId));
    expect(after).toEqual([ids[1], ids[2], ids[0]]);
    await expect(tabs(page).nth(2)).toHaveAttribute("aria-selected", "true");
  });

  test("reorder with Alt+Shift+arrows, announced, focus stays on the tab", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("Control+Shift+T");
    await page.keyboard.press("Control+Shift+T");
    await tabs(page).first().click();
    await tabs(page).first().focus();
    const id = await tabs(page).first().getAttribute("data-tab-id");
    await page.keyboard.press("Alt+Shift+ArrowRight");
    await expect(tabs(page).nth(1)).toHaveAttribute("data-tab-id", id ?? "");
    await expect(page.getByTestId("announcer")).toHaveText("~ moved to position 2 of 3");
    await expect(tabs(page).nth(1)).toBeFocused();
    // Arrow keys move between tabs (roving tabindex, selection follows focus), Home and End jump.
    await page.keyboard.press("ArrowRight");
    await expect(tabs(page).nth(2)).toBeFocused();
    await expect(tabs(page).nth(2)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await expect(tabs(page).first()).toBeFocused();
    await expect(tabs(page).first()).toHaveAttribute("tabindex", "0");
    await expect(tabs(page).nth(1)).toHaveAttribute("tabindex", "-1");
  });

  test("30 tabs at 900×600 overflow into scroll buttons and an all-tabs menu", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await ready(page);
    for (let i = 0; i < 29; i++) await page.keyboard.press("Control+Shift+T");
    await expect(tabs(page)).toHaveCount(30);
    await expect(page.getByRole("button", { name: "Scroll tabs left" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Scroll tabs right" })).toBeVisible();
    await expect(tabs(page).last()).toBeInViewport();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, testInfo, "overflow-light-900.png");
    await page.getByRole("button", { name: "Scroll tabs left" }).click();
    await page.getByRole("button", { name: "All tabs" }).click();
    await expect(page.getByRole("menuitemradio")).toHaveCount(30);
    await page.getByRole("menuitemradio").first().click();
    await expect(tabs(page).first()).toHaveAttribute("aria-selected", "true");
    await expect(tabs(page).first()).toBeInViewport();
  });
});

test.describe("splits", () => {
  test("split right and down, then close a pane", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("Control+Shift+D");
    await expect(panes(page)).toHaveCount(2);
    await page.keyboard.press("Control+Shift+E");
    await expect(panes(page)).toHaveCount(3);
    await expect(dividers(page)).toHaveCount(2);
    await expect.poll(() => focusedPaneId(page)).toBe(await markedFocused(page));
    await page.keyboard.press("Control+Shift+W");
    await expect(panes(page)).toHaveCount(2);
    await expect.poll(() => focusedPaneId(page)).toBe(await markedFocused(page));
  });

  test("dragging a divider changes the ratio; a double click equalizes", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("Control+Shift+D");
    const divider = dividers(page).first();
    await expect(divider).toHaveAttribute("aria-valuenow", "50");
    const box = await divider.boundingBox();
    if (!box) throw new Error("no divider box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    const value = Number(await divider.getAttribute("aria-valuenow"));
    expect(value).toBeGreaterThan(60);
    await divider.dblclick();
    await expect(divider).toHaveAttribute("aria-valuenow", "50");
  });

  test("a focused divider moves with the arrow keys; Shift moves further; the minimum holds", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("Control+Shift+D");
    const divider = dividers(page).first();
    await divider.focus();
    await page.keyboard.press("ArrowLeft");
    const small = Number(await divider.getAttribute("aria-valuenow"));
    expect(small).toBeLessThan(50);
    await page.keyboard.press("Shift+ArrowLeft");
    const big = Number(await divider.getAttribute("aria-valuenow"));
    expect(small - big).toBeGreaterThan(50 - small);
    await page.keyboard.press("Home");
    const min = Number(await divider.getAttribute("aria-valuenow"));
    expect(min).toBeGreaterThan(0);
    await page.keyboard.press("ArrowLeft");
    await expect(divider).toHaveAttribute("aria-valuenow", String(min));
    await expect(divider).toHaveAttribute("aria-orientation", "vertical");
  });

  test("focus moves by direction on a 2×2 grid", async ({ page }) => {
    await ready(page);
    await grid(page);
    const at = {
      tl: await paneAt(page, "top-left"),
      tr: await paneAt(page, "top-right"),
      bl: await paneAt(page, "bottom-left"),
      br: await paneAt(page, "bottom-right"),
    };
    const move = async (key: string, expected: string | undefined) => {
      await page.keyboard.press(key);
      await expect.poll(() => focusedPaneId(page)).toBe(expected);
    };
    await move("Control+Alt+ArrowUp", at.tl);
    await move("Control+Alt+ArrowRight", at.tr);
    await move("Control+Alt+ArrowDown", at.br);
    await move("Control+Alt+ArrowLeft", at.bl);
    await move("Control+Alt+ArrowLeft", at.bl);
  });

  test("zoom fills the tab with a chip and a way back; resize keys and equalize work", async ({ page }, testInfo) => {
    await ready(page);
    await grid(page);
    await page.keyboard.press("Control+Shift+Enter");
    await expect(panes(page)).toHaveCount(1);
    await expect(page.getByText("Zoomed", { exact: true })).toBeVisible();
    await expect(dividers(page)).toHaveCount(0);
    await shot(page, testInfo, "zoomed-light-1280.png");
    await page.getByRole("button", { name: "Show all panes" }).click();
    await expect(panes(page)).toHaveCount(4);
    await expect.poll(() => focusedPaneId(page)).not.toBeNull();

    const before = Number(await dividers(page).first().getAttribute("aria-valuenow"));
    await page.keyboard.press("Control+Alt+Shift+ArrowRight");
    await page.keyboard.press("Control+Alt+Shift+ArrowUp");
    const values = await dividers(page).evaluateAll((elements) => elements.map((e) => e.getAttribute("aria-valuenow")));
    expect(values.some((v) => v !== "50")).toBe(true);
    expect(before).toBe(50);
    await page.keyboard.press("Control+Alt+Shift+Equal");
    await expect
      .poll(() => dividers(page).evaluateAll((elements) => elements.map((e) => e.getAttribute("aria-valuenow"))))
      .toEqual(["50", "50", "50"]);
  });
});

test.describe("command palette and shortcut sheet", () => {
  test("opens with Ctrl+K and Ctrl+Shift+P, filters, runs with Enter, keeps recent actions", async ({ page }) => {
    await ready(page);
    const paletteInput = page.getByRole("combobox");
    await page.keyboard.press("Control+K");
    await expect(paletteInput).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(paletteInput).toBeHidden();
    await page.keyboard.press("Control+Shift+P");
    await expect(paletteInput).toBeFocused();
    await paletteInput.fill("splt rig");
    const first = page.getByRole("option").first();
    await expect(first).toContainText("Split right");
    await expect(first.locator("mark").first()).toHaveText("Spl");
    await page.keyboard.press("Enter");
    await expect(paletteInput).toBeHidden();
    await expect(panes(page)).toHaveCount(2);
    await expect.poll(() => focusedPaneId(page)).toBe(await markedFocused(page));

    await page.keyboard.press("Control+K");
    await expect(page.getByRole("group", { name: "Recent" })).toBeVisible();
    await expect(page.getByRole("option").first()).toContainText("Split right");
    // A disabled action stays listed, dimmed, with the reason.
    await paletteInput.fill("reopen");
    await expect(page.getByRole("option", { name: /Reopen closed tab/ })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("option", { name: /Reopen closed tab/ })).toContainText("No tab was closed");
    await paletteInput.fill("zzzzqq");
    await expect(page.getByText("No commands match.")).toBeVisible();
  });

  test("Esc closes the palette and focus returns where it was", async ({ page }, testInfo) => {
    await ready(page);
    await tabs(page).first().focus();
    await page.keyboard.press("Control+K");
    await expect(page.getByRole("combobox")).toBeFocused();
    await shot(page, testInfo, "palette-light-1280.png");
    await page.keyboard.press("Escape");
    await expect(tabs(page).first()).toBeFocused();
  });

  test("the shortcut sheet opens with Ctrl+/ and filters", async ({ page }, testInfo) => {
    await ready(page);
    await page.keyboard.press("Control+/");
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Shortcuts on Windows.");
    await expect(sheet.getByRole("row", { name: /New tab/ })).toContainText("Ctrl+Shift+T");
    await shot(page, testInfo, "sheet-light-1280.png");
    await sheet.getByRole("searchbox", { name: "Filter shortcuts" }).fill("split");
    await expect(sheet.getByRole("row")).toHaveCount(3);
    await sheet.getByRole("searchbox", { name: "Filter shortcuts" }).fill("nothing like this");
    await expect(sheet.getByText("No shortcuts match.")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });
});

test.describe("layout and screenshots", () => {
  for (const scheme of ["light", "dark"] as const) {
    for (const [width, height] of [
      [1280, 800],
      [900, 600],
    ] as const) {
      test(`3 tabs and a 2×2 split, ${scheme}, ${width}×${height}`, async ({ page }, testInfo) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height });
        await ready(page);
        await page.keyboard.press("Control+Shift+T");
        await page.keyboard.press("Control+Shift+T");
        await page.keyboard.press("Control+1");
        await grid(page);
        await expect(tabs(page)).toHaveCount(3);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        await shot(page, testInfo, `shell-${scheme}-${width}.png`);
        if (scheme === "dark" && width === 1280) {
          await page.keyboard.press("Control+K");
          await page.getByRole("combobox").fill("pane");
          await shot(page, testInfo, "palette-dark-1280.png");
          await page.keyboard.press("Escape");
          await page.keyboard.press("Control+/");
          await shot(page, testInfo, "sheet-dark-1280.png");
        }
      });
    }
  }

  test("below 760 px the sidebar collapses and opens over the panes", async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 600 });
    await ready(page);
    await expect(page.getByRole("complementary", { name: "Sidebar" })).toHaveCount(0);
    await page.keyboard.press("Control+Shift+B");
    const sidebar = page.getByRole("complementary", { name: "Sidebar" });
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toContainText("No projects yet. Add a git folder to start working in tasks.");
    await page.mouse.click(650, 300);
    await expect(sidebar).toHaveCount(0);
  });

  test("the sidebar toggles, and its width moves with the keyboard within 200–420 px", async ({ page }) => {
    await ready(page);
    const sidebar = page.getByRole("complementary", { name: "Sidebar" });
    await expect(sidebar).toBeVisible();
    const resizer = page.getByRole("separator", { name: "Resize sidebar" });
    await resizer.focus();
    await page.keyboard.press("End");
    await expect(resizer).toHaveAttribute("aria-valuenow", "420");
    await page.keyboard.press("Shift+ArrowLeft");
    await expect(resizer).toHaveAttribute("aria-valuenow", "380");
    await page.getByRole("button", { name: "Toggle sidebar" }).click();
    await expect(sidebar).toHaveCount(0);
    await page.keyboard.press("Control+Shift+B");
    await expect(sidebar).toBeVisible();
  });
});

test.describe("macOS chords", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  });

  test("Cmd shortcuts split, move focus, open tabs and the palette", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("Meta+d");
    await page.keyboard.press("Meta+Shift+d");
    await expect(panes(page)).toHaveCount(3);
    await page.keyboard.press("Meta+Alt+ArrowLeft");
    await expect.poll(() => focusedPaneId(page)).toBe(await markedFocused(page));
    await page.keyboard.press("Meta+t");
    await expect(tabs(page)).toHaveCount(2);
    await page.keyboard.press("Meta+1");
    await expect(tabs(page).first()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Meta+k");
    await expect(page.getByRole("option", { name: /New tab/ })).toContainText("⌘T");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Meta+w");
    await expect(panes(page)).toHaveCount(2);
  });
});
