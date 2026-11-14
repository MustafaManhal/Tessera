import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { fakeLog, openTerminal } from "./terminal-helpers";

// Board view (M7.7): automatic columns, dragging, keyboard moves, the start and archive confirmations, filters and
// pull request chips, against the in-memory fakes.
const SHOTS = process.env.TESSERA_SHOTS_DIR ?? join(tmpdir(), "tessera-shots", "45");
const board = (page: Page) => page.locator("[data-board-view]");
const column = (page: Page, name: string) => page.locator(`[data-board-column="${name}"]`);
const card = (page: Page, name: string) => page.locator("[data-board-card]").filter({ hasText: name });

test.beforeEach(async ({ page }) => {
  await mockTauri(page);
});

async function openBoard(page: Page) {
  await openTerminal(page, "demo&renderer=dom");
  await expect(
    page.getByRole("tree", { name: "Projects and tasks" }).getByRole("treeitem", { name: /^Dark mode,/ }),
  ).toBeVisible();
  await page.keyboard.press("Control+Alt+Shift+F8");
  await expect(board(page)).toBeVisible();
}

test("tasks sit in their automatic columns and empty columns explain themselves", async ({ page }) => {
  await openBoard(page);
  // The demo tasks with changed files are waiting for review; the rest were never started.
  await expect(column(page, "review").locator("[data-board-card]")).not.toHaveCount(0);
  await expect(column(page, "backlog").locator("[data-board-card]")).not.toHaveCount(0);
  await expect(column(page, "running")).toContainText("No agent is working right now.");
  await expect(column(page, "needs_you")).toContainText("Nothing is waiting for you.");
  const counts = await page.locator("[data-board-count]").allTextContents();
  expect(counts).toHaveLength(5);
});

test("dragging a card sets a manual column and Automatic puts it back", async ({ page }) => {
  await openBoard(page);
  const target = card(page, "Fix checkout rounding");
  await expect(column(page, "review").locator(target)).toHaveCount(1);
  await target.locator("[data-board-handle]").dragTo(column(page, "needs_you"));
  await expect(column(page, "needs_you").locator(target)).toHaveCount(1);
  await target.locator("[data-board-reset]").click();
  await expect(column(page, "review").locator(target)).toHaveCount(1);
});

test("keyboard: Space lifts, arrows choose the column, Space drops, Esc cancels", async ({ page }) => {
  await openBoard(page);
  const target = card(page, "Fix checkout rounding");
  const handle = target.locator("[data-board-handle]");
  await handle.focus();
  await page.keyboard.press("Space");
  await expect(target).toHaveAttribute("data-lifted", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(column(page, "needs_you")).toHaveAttribute("data-drop-target", "true");
  await page.keyboard.press("Escape");
  await expect(target).not.toHaveAttribute("data-lifted", "true");
  await expect(board(page)).toBeVisible();
  await expect(column(page, "review").locator(target)).toHaveCount(1);

  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Space");
  await expect(column(page, "needs_you").locator(target)).toHaveCount(1);
});

test("Backlog to Running asks, then starts the agent in the task", async ({ page }) => {
  await openBoard(page);
  const target = column(page, "backlog").locator("[data-board-card]").first();
  const name = (await target.locator("[data-board-handle] span").first().textContent()) ?? "";
  const before = (await fakeLog(page)).spawns.length;
  await target.locator("[data-board-handle]").dragTo(column(page, "running"));
  const dialog = page.getByRole("dialog", { name: `Start ${name}?` });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "start-dialog.png") });
  await dialog.getByRole("button", { name: "Start agent" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await fakeLog(page)).spawns.length).toBeGreaterThan(before);
  await expect(column(page, "running").locator("[data-board-card]").filter({ hasText: name })).toHaveCount(1);
});

test("cancelling the start confirmation leaves the card where it was", async ({ page }) => {
  await openBoard(page);
  const target = column(page, "backlog").locator("[data-board-card]").first();
  await target.locator("[data-board-handle]").dragTo(column(page, "running"));
  const dialog = page.getByRole("dialog", { name: /^Start / });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(column(page, "backlog").locator("[data-board-card]")).not.toHaveCount(0);
  await expect(column(page, "running")).toContainText("No agent is working right now.");
});

test("moving to Done offers to archive, or only moves", async ({ page }) => {
  await openBoard(page);
  const target = card(page, "Fix checkout rounding");
  await target.locator("[data-board-handle]").dragTo(column(page, "done"));
  const dialog = page.getByRole("dialog", { name: /^Archive / });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Only move" }).click();
  await expect(column(page, "done").locator(target)).toHaveCount(1);
  // Archive for real from another card.
  const other = card(page, "Add order export");
  await other.locator("[data-board-handle]").dragTo(column(page, "done"));
  await page
    .getByRole("dialog", { name: /^Archive / })
    .getByRole("button", { name: "Archive task" })
    .click();
  await expect(column(page, "done").locator(other)).toHaveCount(1);
});

test("pull request and CI chips show on the card", async ({ page }) => {
  await openBoard(page);
  await page.evaluate(async () => {
    const tasks = Object.values(
      (
        window as unknown as {
          __tesseraStore?: { getState(): { projects: { tasks: Record<string, { id: string; name: string }> } } };
        }
      ).__tesseraStore?.getState().projects.tasks ?? {},
    );
    const target = tasks.find((task) => task.name === "Fix checkout rounding");
    if (!target || !window.__tesseraBoard) throw new Error("no task or board fake");
    window.__tesseraBoard.setPr(target.id, { number: 42, state: "open", ci: "failing" });
  });
  // The board refreshes on its poll; reopen to refetch right away.
  await page.keyboard.press("Control+Alt+Shift+F8");
  await page.keyboard.press("Control+Alt+Shift+F8");
  const target = card(page, "Fix checkout rounding");
  await expect(target.locator("[data-board-pr]")).toHaveText("#42 open");
  await expect(target.locator("[data-board-ci]")).toHaveText("CI failing");
});

test("filters narrow the board by project and Esc closes it", async ({ page }) => {
  await openBoard(page);
  const all = await page.locator("[data-board-card]").count();
  await page.getByRole("combobox", { name: "Project" }).click();
  await page.getByRole("option", { name: "web" }).click();
  await expect.poll(() => page.locator("[data-board-card]").count()).toBeLessThan(all);
  await expect(page.locator("[data-board-card]").first()).toContainText("web");
  // The drop-down hands focus back to its trigger when it has closed; Esc then closes the board.
  await expect(page.getByRole("combobox", { name: "Project" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(board(page)).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) {
  for (const [width, height] of [
    [1280, 800],
    [900, 600],
  ] as const) {
    test(`screenshot ${theme} ${width}x${height}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height });
      await openBoard(page);
      await page.screenshot({ path: join(SHOTS, `board-${theme}-${width}.png`) });
    });
  }
}
