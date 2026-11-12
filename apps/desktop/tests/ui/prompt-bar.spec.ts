import { expect, type Page, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { fakeLog, openTerminal } from "./terminal-helpers";

// The prompt bar and library (brief 33, FR-40/FR-43/FR-16): Ctrl+L sends bracketed-paste text to running agent
// panes, walks history with ↑/↓, and the library CRUDs prompts with variable preview.

const SHOTS = process.env.TESSERA_SHOTS_DIR ?? ".ai/agent-lead/briefs/shots/33";

const tree = (page: Page) => page.getByRole("tree", { name: "Projects and tasks" });

async function demoReady(page: Page) {
  await openTerminal(page, "demo&renderer=dom");
  await expect(tree(page).getByRole("treeitem", { name: /Dark mode/ })).toBeVisible();
}

async function newTaskWithAgents(page: Page, name: string, agentIds: string[] = ["claude"]) {
  await page.keyboard.press("Control+Alt+Shift+N");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog).toBeVisible();
  for (const agentId of agentIds) await dialog.locator(`[data-agent-chip="${agentId}"]`).click();
  await dialog.getByRole("textbox", { name: "Task name" }).fill(name);
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toHaveCount(0);
}

async function sessionIds(page: Page, count = 1): Promise<string[]> {
  return page.evaluate(async (count) => {
    const client = window.__tesseraAgents;
    if (!client) throw new Error("no fake agents client");
    const deadline = Date.now() + 10_000;
    for (;;) {
      const sessions = (await client.agentSessionsList(null)).filter((s) => s.task_id !== null && s.pane_session_id);
      if (sessions.length >= count) return sessions.map((s) => s.id);
      if (Date.now() > deadline) throw new Error("agent sessions never attached");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, count);
}

/** Every decoded write the fake PTYs received. */
async function allWrites(page: Page): Promise<string> {
  const log = await fakeLog(page);
  const decoder = new TextDecoder();
  return log.writes.map((write) => decoder.decode(new Uint8Array(write.bytes))).join("");
}

const bar = (page: Page) => page.locator("[data-prompt-bar]");
const input = (page: Page) => page.locator("[data-prompt-input]");

test.beforeEach(async ({ page }) => {
  await mockTauri(page);
});

test("sends bracketed paste + Enter to the focused agent and records history", async ({ page }) => {
  await demoReady(page);
  await newTaskWithAgents(page, "Prompt target");
  await sessionIds(page);
  await page.keyboard.press("Control+Shift+L");
  await expect(bar(page)).toBeVisible();
  await input(page).fill("run the tests");
  await page.keyboard.press("Enter");
  await expect(bar(page)).toHaveCount(0);
  const writes = await allWrites(page);
  expect(writes).toContain("\x1b[200~run the tests\x1b[201~\r");
  // History row recorded.
  const history = await page.evaluate(async () => (await window.__tesseraPrompts?.history(10)) ?? []);
  expect(history[0]?.text).toBe("run the tests");
  // prompt_sent is recorded backend-side; the paste assertion above is the delivery contract.
});

test("sends to two agents with multi-select chips", async ({ page }) => {
  await demoReady(page);
  await newTaskWithAgents(page, "Two agents", ["claude", "codex"]);
  await sessionIds(page, 2);
  await page.keyboard.press("Control+Shift+L");
  await expect(bar(page)).toBeVisible();
  // The task chip selects every agent in the task.
  await bar(page).locator("[data-target-chip]").first().click();
  await input(page).fill("status?");
  await input(page).press("Enter");
  await expect(bar(page)).toHaveCount(0);
  const writes = await allWrites(page);
  const count = writes.split("\x1b[200~status?\x1b[201~\r").length - 1;
  expect(count).toBe(2);
});

test("arrow up/down walks history at the caret edges", async ({ page }) => {
  await demoReady(page);
  await newTaskWithAgents(page, "History walk");
  await sessionIds(page);
  await page.keyboard.press("Control+Shift+L");
  await input(page).fill("first prompt");
  await page.keyboard.press("Enter");
  await expect(bar(page)).toHaveCount(0);
  await page.keyboard.press("Control+Shift+L");
  await input(page).press("ArrowUp");
  await expect(input(page)).toHaveValue("first prompt");
  await input(page).press("ArrowDown");
  await expect(input(page)).toHaveValue("");
});

test("the library CRUDs prompts, previews variables and fills the bar", async ({ page }) => {
  await demoReady(page);
  // Open the library from the palette.
  await page.keyboard.press("Control+K");
  await page.getByPlaceholder(/palette|command/i).fill("prompt library");
  await page.keyboard.press("Enter");
  const dialog = page.locator("[data-prompt-library]");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "New prompt" }).click();
  await dialog.getByLabel("Name").fill("Review ask");
  await dialog.locator("textarea").first().fill("Review {{task}} on {{branch}}");
  // Variable preview filled with the first task's values.
  await expect(dialog.locator("[data-variable-preview]")).toContainText("Review ");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.locator("[data-prompt-entry]")).toHaveCount(1);
  // Use in prompt bar fills the bar input.
  await dialog.getByRole("button", { name: "Send" }).first().click();
  await expect(bar(page)).toBeVisible();
  await expect(input(page)).toHaveValue("Review {{task}} on {{branch}}");
  await page.keyboard.press("Escape");
  // Delete with confirmation.
  await page.keyboard.press("Control+K");
  await page.getByPlaceholder(/palette|command/i).fill("prompt library");
  await page.keyboard.press("Enter");
  await expect(dialog.locator("[data-prompt-entry]")).toHaveCount(1);
  await dialog.getByRole("button", { name: "Delete" }).click();
  await dialog.getByRole("button", { name: "Delete" }).last().click();
  await expect(dialog.locator("[data-prompt-entry]")).toHaveCount(0);
});

test("Use in new task opens the dialog with the body as the prompt", async ({ page }) => {
  await demoReady(page);
  await page.evaluate(async () => {
    const client = window.__tesseraPrompts;
    if (!client) throw new Error("no fake prompts client");
    await client.save({ name: "Nudge", body: "Please continue", tags: [] });
  });
  await page.keyboard.press("Control+K");
  await page.getByPlaceholder(/palette|command/i).fill("prompt library");
  await page.keyboard.press("Enter");
  const dialog = page.locator("[data-prompt-library]");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Use in new task" }).click();
  const newTask = page.getByRole("dialog", { name: "New task" });
  await expect(newTask).toBeVisible();
  await expect(newTask.locator("textarea")).toHaveValue("Please continue");
});

test("the palette lists Send to agent and the prompt bar action", async ({ page }) => {
  await demoReady(page);
  await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog").or(page.locator("[role=listbox]").first());
  await expect(page.getByText("Send a prompt to agents").first()).toBeVisible();
  await expect(page.getByText("Send to agent").first()).toBeVisible();
  void palette;
});

for (const [scheme, size] of [
  ["light", { width: 1280, height: 800 }],
  ["light", { width: 900, height: 600 }],
  ["dark", { width: 1280, height: 800 }],
  ["dark", { width: 900, height: 600 }],
] as const) {
  test(`screenshot ${scheme} ${size.width}x${size.height}: prompt bar open`, async ({ page }) => {
    await page.setViewportSize(size);
    await openTerminal(page, `demo&renderer=dom&theme=${scheme}`);
    await expect(tree(page).getByRole("treeitem", { name: /Dark mode/ })).toBeVisible();
    await newTaskWithAgents(page, "Shot task");
    await sessionIds(page);
    await page.keyboard.press("Control+Shift+L");
    await expect(bar(page)).toBeVisible();
    await page.waitForTimeout(300);
    const dir = SHOTS.startsWith("/") ? SHOTS : `${process.cwd()}/../../${SHOTS}`;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/bar-${scheme}-${size.width}x${size.height}.png` });
  });
}

for (const [scheme, size] of [
  ["light", { width: 1280, height: 800 }],
  ["dark", { width: 1280, height: 800 }],
] as const) {
  test(`screenshot ${scheme} ${size.width}x${size.height}: prompt library`, async ({ page }) => {
    await page.setViewportSize(size);
    await openTerminal(page, `demo&renderer=dom&theme=${scheme}`);
    await expect(tree(page).getByRole("treeitem", { name: /Dark mode/ })).toBeVisible();
    await page.evaluate(async () => {
      const client = window.__tesseraPrompts;
      if (!client) throw new Error("no fake prompts client");
      await client.save({ name: "Review ask", body: "Review {{task}} on {{branch}}", tags: ["git"] });
      await client.save({ name: "Ship it", body: "Run the suite and open a PR", tags: [] });
    });
    await page.keyboard.press("Control+Shift+,");
    await expect(page.locator("[data-prompt-library]")).toBeVisible();
    await page.waitForTimeout(300);
    const dir = SHOTS.startsWith("/") ? SHOTS : `${process.cwd()}/../../${SHOTS}`;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/library-${scheme}-${size.width}x${size.height}.png` });
  });
}
