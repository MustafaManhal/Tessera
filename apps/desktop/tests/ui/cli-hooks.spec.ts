import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { openTerminal } from "./terminal-helpers";

// The `tessera` CLI install row (M6.3) and the status-hook review dialog (M6.4), against the in-memory fakes.

// Screenshots go to TESSERA_SHOTS_DIR (the lead points it at the brief's shots folder), else the system temp folder.
const SHOTS = process.env.TESSERA_SHOTS_DIR ?? join(tmpdir(), "tessera-shots", "30");

async function openSettings(page: Page): Promise<Locator> {
  await openTerminal(page);
  await page.keyboard.press("Control+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openAgents(page: Page): Promise<Locator> {
  const dialog = await openSettings(page);
  await dialog.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(dialog.locator("[data-agents-page]")).toBeVisible();
  return dialog;
}

const cliRow = (page: Page) => page.locator('[data-setting="cli.install"]');
const hookRow = (page: Page) => page.locator("[data-agent-detail] [data-hooks-state]");
const review = (page: Page) => page.locator("[data-hook-review]");

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, name), animations: "disabled" });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await mockTauri(page, { settings_get: {} });
});

test("the CLI row installs and removes the tool only on click", async ({ page }) => {
  const dialog = await openSettings(page);
  await dialog.getByRole("button", { name: "General", exact: true }).click();
  const row = cliRow(page);
  await expect(row).toContainText("Command-line tool");
  await expect(row).toContainText("Not installed");
  await expect(row.getByRole("button", { name: "Install", exact: true })).toBeEnabled();

  await row.getByRole("button", { name: "Install", exact: true }).click();
  await expect(row).toContainText("Installed at");
  await expect(row).toContainText("~/.local/bin/tessera");
  await expect(row.getByRole("button", { name: "Remove", exact: true })).toBeVisible();

  await row.getByRole("button", { name: "Remove", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Remove the command-line tool?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(row).toContainText("Not installed");
});

test("an installed tool off PATH shows the shell line with a Copy button", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => {
    // The dev server runs as Windows; pretend macOS so the zsh line is what the row offers.
    Object.defineProperty(window.navigator, "userAgent", {
      get: () => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    });
  });
  await openTerminal(page);
  await page.evaluate(() => {
    window.__tesseraCli?.setState({ installed: true, path: "~/.local/bin/tessera", on_path: false });
  });
  // macOS platform now: Settings is ⌘, there.
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "General", exact: true }).click();
  const row = cliRow(page);
  await expect(row).toContainText("not on your PATH");
  await expect(row).toContainText('export PATH="$HOME/.local/bin:$PATH"');
  await row.getByRole("button", { name: "Copy PATH line" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('export PATH="$HOME/.local/bin:$PATH"');
});

test("the palette and its shortcut open Settings on the CLI row", async ({ page }) => {
  await openTerminal(page);
  await page.keyboard.press("Control+K");
  await page.getByRole("combobox").fill("command-line tool");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await expect(cliRow(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.keyboard.press("Control+Alt+Shift+,");
  await expect(dialog).toBeVisible();
  await expect(cliRow(page)).toContainText("Not installed");
});

test("install hooks previews the diff, then applies it", async ({ page }) => {
  const dialog = await openAgents(page);
  await dialog.locator('[data-agent-id="gemini"]').click();
  const row = hookRow(page);
  await expect(row).toHaveAttribute("data-hooks-state", "none");
  await row.getByRole("button", { name: "Install hooks" }).click();

  await expect(review(page)).toBeVisible();
  await expect(review(page)).toContainText("~/.gemini/settings.json");
  await expect(review(page).locator("[data-hook-diff]")).toContainText("tessera hooks gemini");
  await expect(review(page)).toContainText(".tessera.bak");
  await review(page).getByRole("button", { name: "Install", exact: true }).click();
  await expect(review(page)).toHaveCount(0);
  await expect(row).toHaveAttribute("data-hooks-state", "installed");
  await expect(row.getByRole("button", { name: "Remove hooks" })).toBeVisible();
});

test("update hooks and remove hooks go through the same review", async ({ page }) => {
  const dialog = await openAgents(page);
  // Outdated → Update.
  await dialog.locator('[data-agent-id="codex"]').click();
  let row = hookRow(page);
  await expect(row).toHaveAttribute("data-hooks-state", "outdated");
  await row.getByRole("button", { name: "Update hooks" }).click();
  await expect(review(page)).toBeVisible();
  await review(page).getByRole("button", { name: "Update", exact: true }).click();
  await expect(row).toHaveAttribute("data-hooks-state", "installed");

  // Installed → Remove, with the removal diff.
  await dialog.locator('[data-agent-id="claude"]').click();
  row = hookRow(page);
  await expect(row).toHaveAttribute("data-hooks-state", "installed");
  await row.getByRole("button", { name: "Remove hooks" }).click();
  await expect(review(page).locator("[data-hook-diff]")).toContainText("tessera hooks claude");
  await review(page).getByRole("button", { name: "Remove", exact: true }).click();
  await expect(row).toHaveAttribute("data-hooks-state", "none");
});

test("a conflict and an unparseable file explain themselves instead of diffing", async ({ page }) => {
  const dialog = await openAgents(page);
  await page.evaluate(() => {
    const client = window.__tesseraAgents;
    client?.setHookPreview("gemini", {
      config_path: "~/.gemini/settings.json",
      state: "conflict",
      diff: "",
    });
    client?.setHookPreview("codex", {
      config_path: "~/.codex/config.toml",
      state: "unparseable",
      diff: "",
    });
  });
  await dialog.locator('[data-agent-id="gemini"]').click();
  await hookRow(page).getByRole("button", { name: "Install hooks" }).click();
  await expect(review(page)).toContainText("already runs another program");
  await expect(review(page).locator("[data-hook-diff]")).toHaveCount(0);
  await expect(review(page).getByRole("button", { name: "Install", exact: true })).toHaveCount(0);
  await review(page).getByRole("button", { name: "Cancel" }).click();

  await dialog.locator('[data-agent-id="codex"]').click();
  await hookRow(page).getByRole("button", { name: "Update hooks" }).click();
  await expect(review(page)).toContainText("cannot read ~/.codex/config.toml");
  await expect(review(page).getByRole("button", { name: "Cancel" })).toBeVisible();
});

test("an agent without hooks explains that Tessera uses its output", async ({ page }) => {
  const dialog = await openAgents(page);
  await dialog.locator('[data-agent-id="amp"]').click();
  const row = hookRow(page);
  await expect(row).toHaveAttribute("data-hooks-state", "unsupported");
  await row.getByRole("button", { name: "Install hooks" }).click();
  await expect(review(page)).toContainText("Amp has no hooks; Tessera uses its output instead.");
});

test("the review dialog is keyboard reachable: Escape closes it", async ({ page }) => {
  const dialog = await openAgents(page);
  await dialog.locator('[data-agent-id="gemini"]').click();
  await hookRow(page).getByRole("button", { name: "Install hooks" }).click();
  await expect(review(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(review(page)).toHaveCount(0);
  await expect(hookRow(page)).toHaveAttribute("data-hooks-state", "none");
});

for (const scheme of ["light", "dark"] as const) {
  for (const [width, height] of [
    [1280, 800],
    [900, 600],
  ] as const) {
    test(`screenshot ${scheme} ${width}×${height}: hook review dialog`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      const dialog = await openAgents(page);
      await dialog.locator('[data-agent-id="gemini"]').click();
      await hookRow(page).getByRole("button", { name: "Install hooks" }).click();
      await expect(review(page)).toBeVisible();
      await shot(page, `hook-review-${scheme}-${width}x${height}.png`);
    });

    test(`screenshot ${scheme} ${width}×${height}: CLI row`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      const dialog = await openSettings(page);
      await dialog.getByRole("button", { name: "General", exact: true }).click();
      await expect(cliRow(page)).toContainText("Not installed");
      await shot(page, `cli-row-${scheme}-${width}x${height}.png`);
    });
  }
}
