import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { fakeLog, openTerminal } from "./terminal-helpers";

// Agent launch end to end (M6.2): the New task chips, agent panes with their headers, Stop and Restart, Test
// launch, the "Start agent in this task" picker and its shortcut, and type-mode prompt delivery — all against the
// in-memory fake agents client and the fake PTY.

// Screenshots go to TESSERA_SHOTS_DIR (the lead points it at the brief's shots folder), else the system temp folder.
const SHOTS = process.env.TESSERA_SHOTS_DIR ?? join(tmpdir(), "tessera-shots", "27");

const tree = (page: Page) => page.getByRole("tree", { name: "Projects and tasks" });
const task = (page: Page, name: string) => tree(page).getByRole("treeitem", { name: new RegExp(`^${name},`) });
const headers = (page: Page) => page.locator("[data-agent-header]");
const panes = (page: Page) => page.locator('[role="tabpanel"]:not([hidden]) section[data-pane-id]:not([hidden])');

async function demoReady(page: Page) {
  await openTerminal(page, "demo&renderer=dom");
  // The new-task action needs a project; wait for the demo seed before reaching for shortcuts.
  await expect(task(page, "Dark mode")).toBeVisible();
}

async function newTaskDialog(page: Page): Promise<Locator> {
  await page.keyboard.press("Control+Alt+Shift+N");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Picks agent chips by agent id (the skip marker changes the accessible name). */
async function pickAgents(dialog: Locator, agentIds: string[]) {
  for (const id of agentIds) {
    await dialog.locator(`[data-agent-chip="${id}"]`).click();
  }
}

async function createTask(dialog: Locator, name: string) {
  await dialog.getByRole("textbox", { name: "Task name" }).fill(name);
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toHaveCount(0);
}

/** Turns a profile's skip-permissions switch on or off through the fake client. */
async function setSkip(page: Page, agentId: string, on: boolean) {
  await page.evaluate(
    async ({ agentId, on }) => {
      const client = window.__tesseraAgents;
      if (!client) throw new Error("no fake agents client");
      const profile = (await client.agentProfilesList(agentId))[0];
      if (!profile) throw new Error(`no profile for ${agentId}`);
      await client.agentProfileSave({
        id: profile.id,
        agent_id: profile.agent_id,
        name: profile.name,
        model: profile.model,
        extra_args: profile.extra_args,
        env: profile.env,
        skip_permissions: on,
        is_default: profile.is_default,
      });
    },
    { agentId, on },
  );
}

interface FakeSpawn {
  program?: string;
  args?: string[];
  env?: Record<string, string>;
  paneId?: string;
}

/** Every spawn spec the fake PTY saw (fakeLog's helper drops the launch fields). */
async function spawns(page: Page): Promise<FakeSpawn[]> {
  return page.evaluate(() => {
    const log = window.__tesseraFakePty?.log;
    if (!log) throw new Error("no fake pty");
    return log.spawns as unknown as FakeSpawn[];
  });
}

/** All input the fake PTYs received, decoded (pane ids are not PTY session ids). */
async function allWrites(page: Page): Promise<string> {
  return page.evaluate(() => {
    const log = window.__tesseraFakePty?.log;
    if (!log) throw new Error("no fake pty");
    const decoder = new TextDecoder();
    return log.writes.map((write) => decoder.decode(write.bytes)).join("");
  });
}

test.beforeEach(async ({ page }) => {
  await mockTauri(page);
});

test("a task with two agent chips gets two agent panes with headers", async ({ page }) => {
  await demoReady(page);
  const dialog = await newTaskDialog(page);
  // Real chips for the installed agents' default profiles; the skip marker only shows when the profile asks.
  await expect(dialog.locator('[data-agent-chip="claude"]')).toBeEnabled();
  await expect(dialog.locator('[data-agent-chip="codex"]')).toBeEnabled();
  await pickAgents(dialog, ["claude", "codex"]);
  await dialog.getByRole("textbox", { name: "Prompt" }).fill("Fix the flaky test");
  await createTask(dialog, "Two agents");

  await expect(task(page, "Two agents")).toBeVisible();
  // Shell pane plus one agent pane per chip.
  await expect(panes(page)).toHaveCount(3);
  await expect(headers(page)).toHaveCount(2);
  await expect(headers(page).nth(0)).toHaveAttribute("data-agent-id", "claude");
  await expect(headers(page).nth(1)).toHaveAttribute("data-agent-id", "codex");
  await expect(headers(page).nth(0)).toContainText("Claude Code");
  // No skip-permissions badge: neither seeded profile asks for it.
  await expect(page.locator("[data-agent-skip]")).toHaveCount(0);
  // The sessions attach and report working.
  await expect(headers(page).nth(0)).toHaveAttribute("data-agent-status", "working");

  // The PTYs spawned the plan's program, not a login shell.
  const programs = (await spawns(page)).map((spawn) => spawn.program).filter(Boolean);
  expect(programs).toContain("claude");
  expect(programs).toContain("codex");
});

test("the skip-permissions badge shows only on the profile that asks for it", async ({ page }) => {
  await demoReady(page);
  await setSkip(page, "claude", true);
  const dialog = await newTaskDialog(page);
  await pickAgents(dialog, ["claude", "gemini"]);
  await createTask(dialog, "Skip badge");

  await expect(headers(page)).toHaveCount(2);
  const badges = page.locator("[data-agent-skip]");
  await expect(badges).toHaveCount(1);
  await expect(headers(page).filter({ has: badges })).toContainText("Claude Code");
  await expect(headers(page).filter({ hasNot: badges })).toContainText("Gemini CLI");
});

test("Stop kills the agent's PTY and Restart relaunches it in the same pane", async ({ page }) => {
  await demoReady(page);
  const dialog = await newTaskDialog(page);
  await pickAgents(dialog, ["claude"]);
  await createTask(dialog, "Restartable");
  const header = headers(page).first();
  await expect(header).toHaveAttribute("data-agent-status", "working");
  const spawnsBefore = (await fakeLog(page)).spawns.length;

  await header.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(async () => (await fakeLog(page)).kills.length).toBeGreaterThan(0);
  await expect(header).toHaveAttribute("data-agent-status", "exited");

  await header.getByRole("button", { name: "Restart", exact: true }).click();
  await expect.poll(async () => (await fakeLog(page)).spawns.length, { timeout: 10_000 }).toBe(spawnsBefore + 1);
  await expect(header).toHaveAttribute("data-agent-status", "working");
});

test("Test launch opens an agent pane in a new tab and closes Settings", async ({ page }) => {
  await demoReady(page);
  await page.keyboard.press("Control+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Agents", exact: true }).click();
  await page.locator("[data-test-launch]").click();
  await expect(settings).toHaveCount(0);
  await expect(headers(page)).toHaveCount(1);
  await expect(headers(page).first()).toContainText("Claude Code");
  await expect(headers(page).first()).toHaveAttribute("data-agent-status", "working");
});

test("the picker opens from the palette and its shortcut, and starts the chosen profile", async ({ page }) => {
  await demoReady(page);
  // Palette entry.
  await page.keyboard.press("Control+K");
  await page.getByRole("combobox").fill("start agent in this task");
  await page.keyboard.press("Enter");
  const picker = page.locator("[data-agent-picker]");
  await expect(picker).toBeVisible();
  await picker.getByRole("button", { name: "Start", exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(headers(page)).toHaveCount(1);
  await expect(headers(page).first()).toContainText("Claude Code");

  // Shortcut: Mod+Alt+Shift+D (Ctrl on this platform) opens it again; Escape closes.
  await page.keyboard.press("Control+Alt+Shift+D");
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
});

test("a type-mode agent gets the prompt as a bracketed paste after its ready line", async ({ page }) => {
  await demoReady(page);
  const dialog = await newTaskDialog(page);
  await pickAgents(dialog, ["gemini"]);
  await dialog.getByRole("textbox", { name: "Prompt" }).fill("summarize the diff");
  await createTask(dialog, "Typed agent");

  const header = headers(page).first();
  await expect(header).toHaveAttribute("data-agent-id", "gemini");
  await expect(header).toHaveAttribute("data-agent-status", "working");
  // Gemini spawned through the plan (not a login shell).
  expect((await spawns(page)).map((spawn) => spawn.program)).toContain("gemini");
  // The fake shell prints "Tessera fake shell. Type help." at spawn; the paste follows it.
  await expect.poll(() => allWrites(page), { timeout: 10_000 }).toContain("\x1b[200~summarize the diff\x1b[201~\r");
});

for (const scheme of ["light", "dark"] as const) {
  for (const [width, height] of [
    [1280, 800],
    [900, 600],
  ] as const) {
    test(`screenshot ${scheme} ${width}×${height}: a task with two agent panes`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      await demoReady(page);
      const dialog = await newTaskDialog(page);
      await pickAgents(dialog, ["claude", "codex"]);
      await createTask(dialog, "Shot task");
      await expect(headers(page)).toHaveCount(2);
      await expect(headers(page).first()).toHaveAttribute("data-agent-status", "working");
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `agent-panes-${scheme}-${width}x${height}.png`) });
    });
  }
}
