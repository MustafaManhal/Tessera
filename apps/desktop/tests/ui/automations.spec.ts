import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openTerminal } from "./terminal-helpers";

// Automations (M9.5): the Settings page with the in-memory fake client.
const SHOTS = process.env.TESSERA_SHOTS_DIR ?? join(tmpdir(), "tessera-shots", "48");

async function openPage(page: Page) {
  await openTerminal(page, "demo&renderer=dom");
  await page.keyboard.press("Control+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Automations", exact: true }).click();
  await expect(settings.locator("[data-automations-page]")).toBeVisible();
  return settings;
}

async function createCron(settings: ReturnType<Page["getByRole"]>, page: Page, name: string, expr = "0 9 * * 1-5") {
  await settings.getByRole("button", { name: "New automation" }).click();
  const editor = page.locator("[data-automation-editor]");
  await editor.getByLabel("Name").fill(name);
  await editor.getByLabel("Prompt").fill("Run the tests and fix what fails.");
  await editor.getByLabel(/^Schedule/).fill(expr);
  await editor.getByRole("button", { name: "Save" }).click();
  return editor;
}

test("empty state, then a schedule automation shows trigger, next run and never run", async ({ page }) => {
  const settings = await openPage(page);
  await expect(settings).toContainText("No automations yet.");
  const editor = await createCron(settings, page, "Nightly tests");
  await expect(editor).toHaveCount(0);
  const row = settings.locator('[data-automation="Nightly tests"]');
  await expect(row.locator("[data-automation-trigger]")).toHaveText("Weekdays at 09:00");
  await expect(row.locator("[data-automation-next]")).toContainText("Next run");
  await expect(row.locator("[data-automation-last]")).toHaveText("Never run");
  await page.screenshot({ path: join(SHOTS, "automations-list.png") });
});

test("validation errors stay in the editor", async ({ page }) => {
  const settings = await openPage(page);
  await settings.getByRole("button", { name: "New automation" }).click();
  const editor = page.locator("[data-automation-editor]");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor.locator("[data-form-error]")).toContainText("Give the automation a name.");
  await editor.getByLabel("Name").fill("Bad schedule");
  await editor.getByLabel("Prompt").fill("Do it");
  await editor.getByLabel(/^Schedule/).fill("* *");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor.locator("[data-form-error]")).toContainText("five fields");
  await editor.getByRole("button", { name: "Every hour" }).click();
  await expect(editor.getByLabel(/^Schedule/)).toHaveValue("0 * * * *");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toHaveCount(0);
  await expect(settings.locator('[data-automation="Bad schedule"] [data-automation-trigger]')).toHaveText("Every hour");
});

test("a label automation validates the repository and shows what it watches", async ({ page }) => {
  const settings = await openPage(page);
  await settings.getByRole("button", { name: "New automation" }).click();
  const editor = page.locator("[data-automation-editor]");
  await editor.getByLabel("Name").fill("Label runner");
  await editor.getByLabel("Prompt").fill("Take this issue.");
  await editor.getByRole("combobox", { name: "Runs" }).click();
  await page.getByRole("option", { name: "When a GitHub issue gets a label" }).click();
  await editor.getByLabel("Repository").fill("norepo");
  await editor.getByLabel("Label").fill("tessera");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor.locator("[data-form-error]")).toContainText("owner/name");
  await editor.getByLabel("Repository").fill("acme/shop");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toHaveCount(0);
  const row = settings.locator('[data-automation="Label runner"]');
  await expect(row.locator("[data-automation-trigger]")).toHaveText("Issues labeled tessera in acme/shop");
  await expect(row.locator("[data-automation-next]")).toHaveText("Checking every 5 minutes");
});

test("switch off, run now, history with a missed run, edit and delete after confirming", async ({ page }) => {
  const settings = await openPage(page);
  await createCron(settings, page, "Weekly");
  const row = settings.locator('[data-automation="Weekly"]');
  await row.getByRole("switch", { name: "Enable Weekly" }).click();
  await expect(row.locator("[data-automation-next]")).toHaveText("Off");
  await row.getByRole("switch", { name: "Enable Weekly" }).click();
  await expect(row.locator("[data-automation-next]")).toContainText("Next run");

  await page.evaluate(() =>
    window.__tesseraAutomations?.addRun("au_1", "missed", "Tessera was not running at Nov 12 03:00."),
  );
  await row.locator("[data-automation-history]").click();
  await expect(row.locator('[data-automation-run="missed"]')).toContainText("Tessera was not running");
  await expect(row.locator("[data-automation-last]")).toContainText("Last: Missed");

  await row.getByRole("button", { name: "Run now" }).click();
  await expect(row.locator("[data-automation-last]")).toContainText("Last: Started");
  await expect(row.locator('[data-automation-run="ok"]')).toBeVisible();

  await row.getByRole("button", { name: "Edit" }).click();
  const editor = page.locator("[data-automation-editor]");
  await editor.getByLabel("Name").fill("Weekly review");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(settings.locator('[data-automation="Weekly review"]')).toBeVisible();

  await settings.locator('[data-automation="Weekly review"]').getByRole("button", { name: "Delete" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete Weekly review?" });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(settings.locator('[data-automation="Weekly review"]')).toBeVisible();
  await settings.locator('[data-automation="Weekly review"]').getByRole("button", { name: "Delete" }).click();
  await page
    .getByRole("alertdialog", { name: "Delete Weekly review?" })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(settings).toContainText("No automations yet.");
});

for (const theme of ["light", "dark"] as const) {
  for (const [width, height] of [
    [1280, 800],
    [900, 600],
  ] as const) {
    test(`screenshot ${theme} ${width}x${height}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height });
      const settings = await openPage(page);
      await createCron(settings, page, "Nightly tests");
      await page.evaluate(() =>
        window.__tesseraAutomations?.addRun("au_1", "missed", "Tessera was not running at Nov 12 03:00."),
      );
      await settings.locator('[data-automation="Nightly tests"] [data-automation-history]').click();
      await page.screenshot({ path: join(SHOTS, `automations-${theme}-${width}.png`) });
    });
  }
}
