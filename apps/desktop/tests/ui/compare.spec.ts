import { expect, type Page, test } from "@playwright/test";
import { openTerminal } from "./terminal-helpers";

const tree = (page: Page) => page.getByRole("tree", { name: "Projects and tasks" });
const SHOTS = process.env.TESSERA_SHOTS_DIR ?? ".ai/agent-lead/briefs/shots/38";

async function demoReady(page: Page) {
  await openTerminal(page, "demo&renderer=dom");
  await expect(tree(page).getByRole("treeitem", { name: /Dark mode/ })).toBeVisible();
}

async function createGroup(page: Page) {
  await page.keyboard.press("Control+Shift+;");
  const dialog = page.locator("[data-task-group-dialog]");
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-agent-chip="claude"]').click();
  await dialog.locator('[data-agent-chip="codex"]').click();
  await dialog.getByLabel("Name").fill("checkout");
  await dialog.getByLabel("Prompt (sent to every agent)").fill("fix the checkout bug");
  await dialog.getByRole("button", { name: "Create group" }).click();
  await expect(dialog).toHaveCount(0);
}

async function openCompare(page: Page) {
  const groupRow = tree(page).locator("[data-task-group]").first();
  await groupRow.hover();
  await groupRow.getByRole("button", { name: /more/i }).click();
  await page.getByRole("menuitem", { name: "Compare…" }).click();
  await expect(page.locator("[data-compare-view]")).toBeVisible();
}

test("opens from the group menu, switches files, picks and offers archive", async ({ page }) => {
  await demoReady(page);
  await createGroup(page);
  await openCompare(page);
  const view = page.locator("[data-compare-view]");
  // One column per sibling task (count from the store, not a literal).
  const memberCount = await page.evaluate(() => {
    const state = (window as any).__tesseraStore.getState();
    const group = Object.values(state.projects.groups)[0] as any;
    return Object.values(state.projects.tasks).filter((t: any) => t.group_id === group.id && t.state !== "archived")
      .length;
  });
  await expect(view.locator("[data-compare-column]")).toHaveCount(memberCount);
  // File selector lists the union; every fake file is in both tasks → "2/2".
  const files = view.locator("[data-compare-file]");
  await expect(files.first()).toBeVisible();
  await expect(files.first()).toContainText(`${memberCount}/${memberCount}`);
  // Diffs render in both columns for the selected file.
  await expect(view.locator("[data-compare-column]").first()).toContainText("+new line");
  // Switch files synchronizes the selection.
  const second = files.nth(1);
  await second.click();
  await expect(second).toHaveAttribute("aria-selected", "true");
  // A task-specific file shows "Not changed here" in the other column.
  const specific = files.filter({ hasText: "src/tsk_" });
  if ((await specific.count()) > 0) {
    await specific.first().click();
    await expect(view).toContainText("Not changed here");
  }
  // Pick this one → marks the pick and opens the archive-others dialog.
  await view.locator("[data-compare-column]").first().getByRole("button", { name: "Pick this one" }).click();
  await expect(view).toHaveCount(0);
  await expect(page.locator("[data-archive-group-others]")).toBeVisible();
});

test("palette action opens the newest group", async ({ page }) => {
  await demoReady(page);
  await createGroup(page);
  await page.keyboard.press("Control+Shift+P");
  await page.getByRole("combobox").fill("Compare group");
  await page.getByRole("option", { name: /Compare group/ }).click();
  await expect(page.locator("[data-compare-view]")).toBeVisible();
  await page.locator("[data-compare-view]").getByRole("button", { name: "Close" }).click();
  await expect(page.locator("[data-compare-view]")).toHaveCount(0);
});

for (const [scheme, size] of [
  ["light", { width: 1280, height: 800 }],
  ["dark", { width: 1280, height: 800 }],
  ["light", { width: 900, height: 600 }],
  ["dark", { width: 900, height: 600 }],
] as const) {
  test(`screenshot ${scheme} ${size.width}x${size.height}: compare view`, async ({ page }) => {
    await page.setViewportSize(size);
    await demoReady(page);
    await createGroup(page);
    await openCompare(page);
    await page.waitForTimeout(300);
    const dir = SHOTS.startsWith("/") ? SHOTS : `${process.cwd()}/../../${SHOTS}`;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/compare-${scheme}-${size.width}x${size.height}.png` });
  });
}
