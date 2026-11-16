import { expect, type Page, test } from "@playwright/test";
import { openTerminal } from "./terminal-helpers";

const tree = (page: Page) => page.getByRole("tree", { name: "Projects and tasks" });
const SHOTS = process.env.TESSERA_SHOTS_DIR ?? ".ai/agent-lead/briefs/shots/35";

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

test("creates a group of two agents, nests the tasks and fires ready-to-compare once", async ({ page }) => {
  await demoReady(page);
  await createGroup(page);
  // Two group tasks nest under one group row.
  const groupRow = tree(page).locator("[data-task-group]").first();
  await expect(groupRow).toBeVisible();
  await expect(groupRow).toContainText("checkout");
  // Both agents attach.
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const client = window.__tesseraAgents;
        if (!client) return 0;
        const sessions = await client.agentSessionsList(null);
        return sessions.filter((s) => s.task_id !== null && s.pane_session_id).length;
      }),
    )
    .toBeGreaterThanOrEqual(2);
  // Mark both sessions idle → the once-only inbox row appears.
  await page.evaluate(async () => {
    const client = (window as any).__tesseraAgents;
    if (!client) throw new Error("no fake agents client");
    for (const s of await client.agentSessionsList(null)) {
      if (s.task_id) client.setSessionStatus(s.id, "idle");
    }
  });
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const client = window.__tesseraInbox;
        if (!client) return 0;
        return (await client.list(50)).filter((e) => e.source === "agent").length;
      }),
    )
    .toBeGreaterThanOrEqual(1);
});

test("the group menu picks a task and offers to archive the others", async ({ page }) => {
  await demoReady(page);
  await createGroup(page);
  const groupRow = tree(page).locator("[data-task-group]").first();
  await expect(groupRow).toBeVisible();
  await groupRow.getByRole("button").last().click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu
    .getByRole("menuitem", { name: /Pick this one/ })
    .first()
    .click();
  await expect(groupRow).toContainText("Picked");
  await groupRow.getByRole("button").last().click();
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: /Archive the other/ })
    .click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText(/Archive the other \d+ tasks\?/);
  await expect(confirm).toContainText("stay on disk");
  await confirm.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  const group = await page.evaluate(() => {
    const store = window.__tesseraStore?.getState();
    const info = Object.values(store?.projects.groups ?? {})[0];
    const members = Object.values(store?.projects.tasks ?? {}).filter((task) => task.group_id === info?.id);
    return members.map((task) => ({ picked: task.id === info?.picked_task_id, archived: task.archived_at !== null }));
  });
  expect(group.length).toBeGreaterThanOrEqual(2);
  expect(group.filter((m) => !m.picked).every((m) => m.archived)).toBe(true);
  expect(group.find((m) => m.picked)?.archived).toBe(false);
});

for (const [scheme, size] of [
  ["light", { width: 1280, height: 800 }],
  ["dark", { width: 1280, height: 800 }],
  ["light", { width: 900, height: 600 }],
  ["dark", { width: 900, height: 600 }],
] as const) {
  test(`screenshot ${scheme} ${size.width}x${size.height}: task group`, async ({ page }) => {
    await page.setViewportSize(size);
    await openTerminal(page, `demo&renderer=dom&theme=${scheme}`);
    await expect(tree(page).getByRole("treeitem", { name: /Dark mode/ })).toBeVisible();
    await page.keyboard.press("Control+Shift+;");
    const dialog = page.locator("[data-task-group-dialog]");
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(300);
    const dir = SHOTS.startsWith("/") ? SHOTS : `${process.cwd()}/../../${SHOTS}`;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/group-dialog-${scheme}-${size.width}x${size.height}.png` });
    await dialog.getByLabel("Name").fill("checkout");
    await dialog.getByLabel("Prompt (sent to every agent)").fill("fix the checkout bug");
    await dialog.locator('[data-agent-chip="claude"]').click();
    await dialog.locator('[data-agent-chip="codex"]').click();
    await dialog.getByRole("button", { name: "Create group" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(tree(page).locator("[data-task-group]").first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${dir}/group-tree-${scheme}-${size.width}x${size.height}.png` });
  });
}
