import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { openTerminal } from "./terminal-helpers";
import { pickAgent } from "./agent-select";

// The status engine end to end (brief 31): sidebar pills and the latest message from agent sessions, driven
// through the fake client's session changes (the observer's own throttling is unit-tested).

// Screenshots go to TESSERA_SHOTS_DIR (the lead points it at the brief's shots folder), else the system temp folder.
const SHOTS = process.env.TESSERA_SHOTS_DIR ?? join(tmpdir(), "tessera-shots", "31");

const tree = (page: Page) => page.getByRole("tree", { name: "Projects and tasks" });
const row = (page: Page, name: string) => tree(page).locator(`[data-task]:has-text("${name}")`).first();

async function demoReady(page: Page) {
  await openTerminal(page, "demo&renderer=dom");
  await expect(tree(page).getByRole("treeitem", { name: /Dark mode/ })).toBeVisible();
}

async function newTaskWithAgent(page: Page, name: string, agentId: string) {
  await page.keyboard.press("Control+Alt+Shift+N");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog).toBeVisible();
  await pickAgent(page, dialog, agentId);
  await dialog.getByRole("textbox", { name: "Task name" }).fill(name);
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toHaveCount(0);
}

/** The task's agent session id, once its PTY attach landed (attach resets the status to working). */
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
    ({ id, status, message }) => {
      window.__tesseraAgents?.setSessionStatus(id, status as never, message);
    },
    { id, status, message },
  );
}

test.beforeEach(async ({ page }) => {
  await mockTauri(page);
});

test("the sidebar row shows the agent status pill and latest message", async ({ page }) => {
  await demoReady(page);
  await newTaskWithAgent(page, "Status probe", "claude");
  const id = await sessionId(page);
  const taskRow = row(page, "Status probe");

  await setStatus(page, id, "needs_input", "Allow bash rm -rf?");
  await expect(taskRow.locator("[data-task-agent-status]")).toHaveAttribute("data-task-agent-status", "needs_input");
  await expect(taskRow).toContainText("Needs you");
  await expect(taskRow).toContainText("Allow bash rm -rf?");

  await setStatus(page, id, "working", null);
  await expect(taskRow.locator("[data-task-agent-status]")).toHaveAttribute("data-task-agent-status", "working");
  await expect(taskRow).toContainText("Working");

  await setStatus(page, id, "idle", "Turn finished");
  await expect(taskRow.locator("[data-task-agent-status]")).toHaveAttribute("data-task-agent-status", "idle");
  await expect(taskRow).toContainText("Turn finished");

  await setStatus(page, id, "error", "exit code 1");
  await expect(taskRow.locator("[data-task-agent-status]")).toHaveAttribute("data-task-agent-status", "error");
  await expect(taskRow).toContainText("Error");
});

test("the agent pane header tracks the same status", async ({ page }) => {
  await demoReady(page);
  await newTaskWithAgent(page, "Header probe", "codex");
  const id = await sessionId(page);
  await setStatus(page, id, "needs_input", "Approve the plan?");
  const header = page.locator("[data-agent-header]");
  await expect(header.locator("[data-agent-status-pill]")).toBeVisible();
  await expect(header).toContainText("Needs you");
});

for (const scheme of ["light", "dark"] as const) {
  for (const [width, height] of [
    [1280, 800],
    [900, 600],
  ] as const) {
    test(`screenshot ${scheme} ${width}×${height}: task rows in each agent status`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      await demoReady(page);
      // One task per status, all visible in the sidebar at once.
      const cases: [string, string, string | null][] = [
        ["Needs you", "needs_input", "Allow bash?"],
        ["Working row", "working", null],
        ["Idle row", "idle", "Turn finished"],
        ["Error row", "error", "exit code 1"],
      ];
      for (const [name, agent] of [
        ["Needs you", "claude"],
        ["Working row", "codex"],
        ["Idle row", "gemini"],
        ["Error row", "claude"],
      ] as const) {
        await newTaskWithAgent(page, name, agent);
      }
      // Sessions are newest-first; assign statuses in creation order.
      const ids = await page.evaluate(async () => {
        const client = window.__tesseraAgents;
        if (!client) throw new Error("no fake agents client");
        return (await client.agentSessionsList(null)).filter((s) => s.task_id !== null).map((s) => s.id);
      });
      // ids are newest-first → reverse to match creation order.
      const ordered = [...ids].reverse();
      for (const [index, [, status, message]] of cases.entries()) {
        const id = ordered[index];
        if (!id) throw new Error("missing session id");
        await setStatus(page, id, status, message);
      }
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({
        path: join(SHOTS, `sidebar-status-${scheme}-${width}x${height}.png`),
        animations: "disabled",
      });
    });
  }
}
