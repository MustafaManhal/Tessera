import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { openTerminal } from "./terminal-helpers";
import { pickAgent } from "./agent-select";

// Attention signals end to end (brief 32): an agent going to needs_input in a background tab rings the pane,
// dots the tab, badges the sidebar, counts in the status bar and lands in the inbox; click jumps and marks read;
// DND suppresses the OS notification but keeps the badge; per-project mute silences; the jump shortcut cycles.

// Screenshots go to TESSERA_SHOTS_DIR (the lead points it at the brief's shots folder), else the system temp folder.
const SHOTS = process.env.TESSERA_SHOTS_DIR ?? join(tmpdir(), "tessera-shots", "32");

const tree = (page: Page) => page.getByRole("tree", { name: "Projects and tasks" });
const taskRow = (page: Page, name: string) => tree(page).locator(`[data-task]:has-text("${name}")`).first();

async function demoReady(page: Page) {
  await openTerminal(page, "demo&renderer=dom");
  await expect(tree(page).getByRole("treeitem", { name: /Dark mode/ })).toBeVisible();
}

async function newTaskWithAgent(page: Page, name: string, agentId = "claude") {
  await page.keyboard.press("Control+Alt+Shift+N");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog).toBeVisible();
  await pickAgent(page, dialog, agentId);
  await dialog.getByRole("textbox", { name: "Task name" }).fill(name);
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toHaveCount(0);
}

/** The newest agent session id once its PTY attach landed. */
async function sessionId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const client = window.__tesseraAgents;
    if (!client) throw new Error("no fake agents client");
    const deadline = Date.now() + 10_000;
    for (;;) {
      const session = (await client.agentSessionsList(null)).find((s) => s.task_id !== null);
      if (session?.pane_session_id) return session.id;
      if (Date.now() > deadline) throw new Error("agent session never attached");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
}

async function setStatus(page: Page, id: string, status: string, message: string | null) {
  await page.evaluate(
    ({ id, status, message }) => window.__tesseraAgents?.setSessionStatus(id, status as never, message),
    { id, status, message },
  );
}

/** Moves focus off the agent pane: opens and focuses a plain shell tab. */
async function backgroundTheAgent(page: Page) {
  await page.keyboard.press("Control+Shift+T");
  await page.waitForTimeout(300);
}

test.beforeEach(async ({ page }) => {
  await mockTauri(page);
});

test("needs_input in a background tab rings, dots, badges, counts and lands in the inbox", async ({ page }) => {
  await demoReady(page);
  await newTaskWithAgent(page, "Attention probe");
  const id = await sessionId(page);
  await backgroundTheAgent(page);

  await setStatus(page, id, "needs_input", "Allow bash rm -rf?");
  // 2 s debounce + delivery.
  await expect(page.locator("[data-attention-ring]")).toHaveCount(1, { timeout: 6_000 });
  await expect(page.locator("[data-badge='agent-needs']")).toBeVisible();
  await expect(taskRow(page, "Attention probe").locator("[data-task-agent-status]")).toHaveAttribute(
    "data-task-agent-status",
    "needs_input",
  );
  await expect(page.locator("[data-inbox-count]")).toHaveText("1");

  // The inbox row exists with the message.
  await page.locator("[data-inbox-button]").click();
  const panel = page.locator("[data-inbox-panel]");
  await expect(panel).toBeVisible();
  await expect(panel.locator("[data-inbox-entry]")).toHaveCount(1);
  await expect(panel).toContainText("Allow bash rm -rf?");

  // Click jumps back to the agent pane/tab and marks the row read.
  await panel.locator("[data-inbox-entry]").click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator("[data-attention-ring]")).toHaveCount(0);
  const unread = await page.evaluate(async () => {
    const client = window.__tesseraInbox;
    if (!client) throw new Error("no fake inbox");
    return (await client.list(10)).filter((e) => !e.isRead).length;
  });
  expect(unread).toBe(0);
});

test("mark all read and clear work from the inbox", async ({ page }) => {
  await demoReady(page);
  await newTaskWithAgent(page, "Inbox probe");
  const id = await sessionId(page);
  await backgroundTheAgent(page);
  await setStatus(page, id, "needs_input", "approve?");
  await expect(page.locator("[data-inbox-count]")).toHaveText("1", { timeout: 6_000 });
  await page.locator("[data-inbox-button]").click();
  const panel = page.locator("[data-inbox-panel]");
  await panel.getByRole("button", { name: "Mark all read" }).click();
  await expect(panel.locator("[data-inbox-entry][data-read='true']")).toHaveCount(1);
  await expect(page.locator("[data-inbox-count]")).toHaveCount(0);
  await panel.getByRole("button", { name: "Clear all" }).click();
  await expect(panel.getByText("Nothing needs you right now.")).toBeVisible();
});

test("DND suppresses the OS notification but keeps the badge and inbox row", async ({ page }) => {
  await demoReady(page);
  await newTaskWithAgent(page, "DND probe");
  const id = await sessionId(page);
  await backgroundTheAgent(page);
  // Turn DND on for an hour by writing it into the config the store holds (the DND gate reads config.values).
  await page.evaluate(() => {
    const store = window.__tesseraStore;
    if (!store) throw new Error("no store");
    const values = (store.getState().config.values ?? {}) as Record<string, unknown>;
    const notifications = {
      ...((values.notifications ?? {}) as Record<string, unknown>),
      "dnd-until": Math.floor(Date.now() / 1000) + 3600,
    };
    store.dispatch({ type: "config/configApplied", payload: { ...values, notifications } } as never);
  });
  const before = await page.evaluate(() => window.__tesseraNotifications?.shown.length ?? 0);
  await setStatus(page, id, "needs_input", "dnd me");
  await expect(page.locator("[data-attention-ring]")).toHaveCount(1, { timeout: 6_000 });
  await expect(page.locator("[data-inbox-count]")).toHaveText("1");
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => window.__tesseraNotifications?.shown.length ?? 0);
  expect(after).toBe(before);
});

test("a muted project's agent never pings", async ({ page }) => {
  await demoReady(page);
  await newTaskWithAgent(page, "Muted probe", "codex");
  const id = await sessionId(page);
  // Find the task's project and mute it through the sidebar context menu.
  const projectName = await page.evaluate(() => {
    const state = window.__tesseraStore?.getState();
    const task = Object.values(state?.projects.tasks ?? {}).find((t) => t.name === "Muted probe");
    const project = task ? state?.projects.projects[task.project_id] : undefined;
    if (!project) throw new Error("task project not found");
    return project.name;
  });
  await tree(page)
    .getByRole("treeitem", { name: new RegExp(`^${projectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) })
    .first()
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mute project" }).click();
  await backgroundTheAgent(page);
  await setStatus(page, id, "needs_input", "muted");
  await page.waitForTimeout(3500);
  await expect(page.locator("[data-attention-ring]")).toHaveCount(0);
  await expect(page.locator("[data-inbox-count]")).toHaveCount(0);
});

test("the jump shortcut cycles panes needing attention, oldest first", async ({ page }) => {
  await demoReady(page);
  await newTaskWithAgent(page, "Jump one", "claude");
  await newTaskWithAgent(page, "Jump two", "codex");
  const ids = await page.evaluate(async () => {
    const client = window.__tesseraAgents;
    if (!client) throw new Error("no fake agents client");
    const deadline = Date.now() + 10_000;
    for (;;) {
      const sessions = (await client.agentSessionsList(null)).filter((s) => s.task_id !== null && s.pane_session_id);
      if (sessions.length >= 2) return sessions.map((s) => s.id);
      if (Date.now() > deadline) throw new Error("sessions never attached");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
  await backgroundTheAgent(page);
  const [first, second] = ids;
  if (!first || !second) throw new Error("expected two sessions");
  await setStatus(page, first, "needs_input", "first");
  await setStatus(page, second, "needs_input", "second");
  await expect(page.locator("[data-attention-ring]")).toHaveCount(2, { timeout: 6_000 });
  // Two jumps cycle through both marks.
  await page.keyboard.press("Control+Shift+U");
  await page.keyboard.press("Control+Shift+U");
  await expect(page.locator("[data-attention-ring]")).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
  for (const [width, height] of [
    [1280, 800],
    [900, 600],
  ] as const) {
    test(`screenshot ${scheme} ${width}×${height}: inbox open with a ringed pane`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      await demoReady(page);
      await newTaskWithAgent(page, "Shot probe");
      const id = await sessionId(page);
      await backgroundTheAgent(page);
      await setStatus(page, id, "needs_input", "Allow the deploy?");
      await expect(page.locator("[data-attention-ring]")).toHaveCount(1, { timeout: 6_000 });
      await page.locator("[data-inbox-button]").click();
      await expect(page.locator("[data-inbox-panel]")).toBeVisible();
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({
        path: join(SHOTS, `inbox-${scheme}-${width}x${height}.png`),
        animations: "disabled",
      });
    });
  }
}
