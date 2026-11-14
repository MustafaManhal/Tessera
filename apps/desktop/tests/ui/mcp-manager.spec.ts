import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { openTerminal } from "./terminal-helpers";
const SHOTS = process.env.TESSERA_SHOTS_DIR ?? join(tmpdir(), "tessera-shots", "44");
async function open(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as unknown as Record<string, unknown>).__managerCopied = text;
        },
      },
    });
  });
  await openTerminal(page, "demo&renderer=dom");
  await page.keyboard.press("Control+,");
  await page
    .getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("button", { name: "Integrations", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "MCP and skills", exact: true })).toBeVisible();
}
async function select(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function addServer(page: Page, name = "fixture") {
  await page.getByRole("button", { name: "Add MCP server", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add MCP server", exact: true });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dialog.getByRole("textbox", { name: "Command", exact: true }).fill("fixture-mcp");
  await dialog.getByRole("textbox", { name: "Environment variable names", exact: true }).fill("TOKEN");
  await dialog.getByLabel("Value for TOKEN (keychain)", { exact: true }).fill("private-fixture-value");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  return page.getByRole("article", { name, exact: true });
}
async function preview(page: Page, action: "Install" | "Uninstall") {
  const dialog = page.getByRole("dialog", { name: action, exact: true });
  await dialog.getByRole("button", { name: "Preview change", exact: true }).click();
  return page.getByRole("dialog", { name: "Review config change", exact: true });
}
async function apply(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Review config change", exact: true });
  await dialog.getByRole("button", { name: "Apply change", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
test("server and skill CRUD, test, previews, install and uninstall", async ({ page }) => {
  await open(page);
  await expect(page.getByText("No MCP servers yet.", { exact: true })).toBeVisible();
  await expect(page.getByText("No skills or rules yet.", { exact: true })).toBeVisible();
  let card = await addServer(page);
  expect(await page.evaluate(() => JSON.stringify(window.__tesseraManager?.data))).not.toContain(
    "private-fixture-value",
  );
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  let editor = page.getByRole("dialog", { name: "Edit MCP server", exact: true });
  await editor.getByRole("textbox", { name: "Name", exact: true }).fill("edited-fixture");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  card = page.getByRole("article", { name: "edited-fixture", exact: true });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Test", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("search_fixture, read_fixture");
  await card.getByRole("button", { name: "Install", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "Write values into the agent’s config", exact: true }),
  ).not.toBeChecked();
  const plan = await preview(page, "Install");
  await expect(plan).not.toContainText("private-fixture-value");
  expect(await page.evaluate(() => window.__tesseraManager?.data.installs.length)).toBe(0);
  await plan.getByRole("button", { name: "Cancel", exact: true }).click();
  await card.getByRole("button", { name: "Install", exact: true }).click();
  await page.getByRole("switch", { name: "Write values into the agent’s config", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Write values into the agent’s config", exact: true })).toBeChecked();
  await preview(page, "Install");
  await expect(page.getByRole("dialog", { name: "Review config change", exact: true })).toContainText("<redacted>");
  await apply(page);
  await expect(card).toContainText("Claude Code: installed");
  await expect(card.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Add skill or rules", exact: true }).click();
  editor = page.getByRole("dialog", { name: "Add skill or rules", exact: true });
  await editor.getByRole("textbox", { name: "Name", exact: true }).fill("review");
  await editor
    .getByRole("textbox", { name: "Markdown body", exact: true })
    .fill("# Review carefully\n- Check edge cases");
  await expect(
    editor
      .getByRole("region", { name: "Markdown preview", exact: true })
      .getByRole("heading", { name: "Review carefully", exact: true }),
  ).toBeVisible();
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, "skill-editor.png") });
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  const skill = page.getByRole("article", { name: "review", exact: true });
  await skill.getByRole("button", { name: "Install", exact: true }).click();
  await preview(page, "Install");
  await apply(page);
  await expect(skill).toContainText("1 install targets");
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const [width, height] of [
      [1280, 800],
      [900, 600],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.locator("[data-integrations-manager]").evaluate((e) => {
        e.scrollTop = 0;
      });
      await page.screenshot({ path: join(SHOTS, `manager-${theme}-${width}.png`) });
    }
  }
  await skill.getByRole("button", { name: "Uninstall", exact: true }).click();
  await preview(page, "Uninstall");
  await apply(page);
  await skill.getByRole("button", { name: "Edit", exact: true }).click();
  editor = page.getByRole("dialog", { name: "Edit skill or rules", exact: true });
  await editor.getByRole("textbox", { name: "Markdown body", exact: true }).fill("# Updated review");
  await select(page, "Kind", "Claude rules file");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(skill).toContainText("Claude rules file");
  await skill.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Delete definition?", exact: true })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(skill).toHaveCount(0);
  await card.getByRole("button", { name: "Uninstall", exact: true }).click();
  await preview(page, "Uninstall");
  await apply(page);
  await card.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Delete definition?", exact: true })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(card).toHaveCount(0);
});
test("preset, validation, HTTP, test errors, manual and remote states", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Add Tessera’s own MCP server", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Add MCP server", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Command", exact: true })).toHaveValue("tessera");
  await expect(dialog.getByRole("textbox", { name: "Arguments (JSON array)", exact: true })).toHaveValue('["mcp"]');
  await dialog.getByRole("textbox", { name: "Arguments (JSON array)", exact: true }).fill("{}");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("JSON array of strings");
  await dialog.getByRole("textbox", { name: "Arguments (JSON array)", exact: true }).fill("[]");
  await select(page, "Transport", "HTTP");
  await dialog.getByRole("textbox", { name: "URL", exact: true }).fill("https://example.invalid/mcp");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  const card = page.getByRole("article", { name: "tessera", exact: true });
  await expect(card).toContainText("https://example.invalid/mcp");
  await page.evaluate(() => {
    if (window.__tesseraManager) window.__tesseraManager.failTest = true;
  });
  await card.getByRole("button", { name: "Test", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("timed out");
  await card.getByRole("button", { name: "Install", exact: true }).click();
  await select(page, "Agent", "Cursor Agent (manual)");
  dialog = page.getByRole("dialog", { name: "Install", exact: true });
  await dialog.getByRole("button", { name: "Preview change", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Manual configuration", exact: true });
  await expect(dialog).toContainText("mcpServers");
  await expect(dialog.getByRole("button", { name: "Apply change", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Copy snippet", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Record<string, unknown>).__managerCopied))
    .toContain("mcpServers");
  await expect(dialog).toHaveCount(0);
  await card.getByRole("button", { name: "Install", exact: true }).click();
  await select(page, "Install target", "Remote fixture");
  dialog = page.getByRole("dialog", { name: "Install", exact: true });
  await dialog.getByRole("button", { name: "Preview change", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Remote worktree installs are not supported yet.");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await card.getByRole("button", { name: "Install", exact: true }).click();
  await preview(page, "Install");
  await page.evaluate(() => {
    if (window.__tesseraManager) window.__tesseraManager.failApply = true;
  });
  await page.getByRole("button", { name: "Apply change", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Review config change", exact: true }).getByRole("alert"),
  ).toContainText("changed after preview");
});
test("loading and list failure can retry", async ({ page }) => {
  await openTerminal(page, "demo&renderer=dom");
  await page.keyboard.press("Control+,");
  // The settings screen loads on first use; its fixtures exist once it is on screen.
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  await page.evaluate(() => {
    if (window.__tesseraManager) {
      window.__tesseraManager.delay = 300;
      window.__tesseraManager.failList = true;
    }
  });
  await page
    .getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("button", { name: "Integrations", exact: true })
    .click();
  await expect(page.getByText("Loading integrations…", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Fixture manager unavailable.");
  await page.evaluate(() => {
    if (window.__tesseraManager) window.__tesseraManager.failList = false;
  });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("No MCP servers yet.", { exact: true })).toBeVisible();
});
