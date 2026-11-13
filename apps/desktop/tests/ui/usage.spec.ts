import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { fakeLog, openTerminal } from "./terminal-helpers";
import { pickAgent } from "./agent-select";

// Token/cost chip and hand-off to another agent (M9.6) against the in-memory fakes.
const SHOTS = process.env.TESSERA_SHOTS_DIR ?? join(tmpdir(), "tessera-shots", "46");
const headers = (page: Page) => page.locator("[data-agent-header]");
const tree = (page: Page) => page.getByRole("tree", { name: "Projects and tasks" });

test.beforeEach(async ({ page }) => {
  await mockTauri(page);
});

interface Figures {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
  models: string[];
  agents: string[];
}

async function taskWithAgent(page: Page, agent: string, name: string, usage: Figures | null = null): Promise<Locator> {
  await openTerminal(page, "demo&renderer=dom");
  await expect(tree(page).getByRole("treeitem", { name: /^Dark mode,/ })).toBeVisible();
  await page.evaluate((figures) => {
    if (!window.__tesseraUsage) throw new Error("no fake usage client");
    window.__tesseraUsage.defaultUsage = figures;
  }, usage);
  await page.keyboard.press("Control+Alt+Shift+N");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await pickAgent(page, dialog, agent);
  await dialog.getByRole("textbox", { name: "Task name" }).fill(name);
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(headers(page).first()).toHaveAttribute("data-agent-status", "working");
  return headers(page).first();
}

test("the header shows tokens and an estimated cost when the agent reports usage", async ({ page }) => {
  const header = await taskWithAgent(page, "claude", "Usage chip", {
    input_tokens: 12_400,
    output_tokens: 3_100,
    cache_read_tokens: 40_000,
    cache_write_tokens: 2_000,
    cost_usd: 0.4213,
    models: ["claude-sonnet-4-5"],
    agents: ["claude"],
  });
  const chip = header.locator("[data-usage-chip]");
  await expect(chip.locator("[data-usage-tokens]")).toHaveText("58k tokens");
  await expect(chip.locator("[data-usage-cost]")).toHaveText("~$0.42");
  await chip.focus();
  await expect(page.getByRole("tooltip")).toContainText("In 12k · out 3.1k · cached 42k");
  await expect(page.getByRole("tooltip")).toContainText("estimate");
  await page.screenshot({ path: join(SHOTS, "usage-chip.png") });
});

test("no chip when the agent reports nothing, and tokens alone when the model has no price", async ({ page }) => {
  const header = await taskWithAgent(page, "claude", "No usage");
  await expect(header.locator("[data-usage-chip]")).toHaveCount(0);
  await page.evaluate(() => {
    if (!window.__tesseraUsage) throw new Error("no fake usage client");
    window.__tesseraUsage.defaultUsage = {
      input_tokens: 5,
      output_tokens: 6,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: null,
      models: ["mystery"],
      agents: ["claude"],
    };
  });
  // A status change refreshes the chip: stop the agent.
  await header.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(header.locator("[data-usage-tokens]")).toHaveText("11 tokens");
  await expect(header.locator("[data-usage-cost]")).toHaveCount(0);
});

test("hand off starts the chosen agent in the same task with the edited summary", async ({ page }) => {
  const header = await taskWithAgent(page, "claude", "Hand me off");
  await header.locator("[data-agent-handoff]").click();
  const dialog = page.getByRole("dialog", { name: "Hand off to another agent" });
  await expect(dialog).toBeVisible();
  const summary = dialog.locator("[data-handoff-summary]");
  await expect(summary).toHaveValue(/taking over a task from Claude Code/);
  await summary.fill("Finish the CSS and run the tests.");
  await dialog.getByRole("combobox").click();
  // The current agent is not offered while another is installed.
  await expect(page.getByRole("option", { name: /^Claude Code/ })).toHaveCount(0);
  await page.getByRole("option", { name: /OpenAI Codex/ }).click();
  await page.screenshot({ path: join(SHOTS, "handoff-dialog.png") });
  const before = (await fakeLog(page)).spawns.length;
  await dialog.getByRole("button", { name: "Start agent" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(headers(page)).toHaveCount(2);
  await expect(headers(page).nth(1)).toHaveAttribute("data-agent-id", "codex");
  await expect(headers(page).nth(0)).toHaveAttribute("data-agent-status", "working");
  expect((await fakeLog(page)).spawns.length).toBe(before + 1);
  // Codex takes its prompt typed into the terminal once it is ready; the fake PTY records those writes.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const decoder = new TextDecoder();
          return (window.__tesseraFakePty?.log?.writes ?? []).map((w) => decoder.decode(w.bytes)).join("");
        }),
      { timeout: 20_000 },
    )
    .toContain("Finish the CSS and run the tests.");
});
