import { join } from "node:path";
import { expect, type Locator, type Page, type TestInfo, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { openTerminal } from "./terminal-helpers";

// Custom agent definitions (FR-34): add, inline validation, Test detection, edit, delete blocked then allowed,
// and the new agent appearing in the picker. Runs against the in-memory fake client.

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const dir = process.env.TESSERA_SHOTS_DIR;
  const path = dir ? join(dir, name) : testInfo.outputPath(name);
  await page.screenshot({ path, animations: "disabled" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.open = () => null;
  });
});

async function openAgents(page: Page): Promise<Locator> {
  await openTerminal(page);
  await page.keyboard.press("Control+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(dialog.locator("[data-agents-page]")).toBeVisible();
  await expect(dialog.locator("[data-agent-id]").first()).toBeVisible();
  return dialog;
}

async function openCustomDialog(page: Page, dialog: Locator): Promise<Locator> {
  await dialog.locator("[data-add-custom-agent]").click();
  const custom = page.locator("[data-custom-agent-dialog]");
  await expect(custom).toBeVisible();
  return custom;
}

async function fillValid(custom: Locator): Promise<void> {
  await custom.getByLabel("Name").fill("My Agent");
  await custom.getByLabel("Commands to look for").fill("myagent, myagent-cli");
  await custom.getByLabel("Version command").fill("myagent --version");
}

test("adds a custom agent end to end and it shows in the picker", async ({ page }, testInfo) => {
  await mockTauri(page, { settings_get: {} });
  const dialog = await openAgents(page);
  const custom = await openCustomDialog(page, dialog);

  // The id derives from the name until edited.
  await custom.getByLabel("Name").fill("My Agent");
  await expect(custom.getByLabel("ID", { exact: true })).toHaveValue("my-agent");
  await fillValid(custom);

  // Test reports not found, then found once the fake knows the binary.
  await custom.getByRole("button", { name: "Test", exact: true }).click();
  await expect(custom.locator("[data-test-result='missing']")).toContainText("Not found");
  await page.evaluate(() => window.__tesseraAgents?.installedBinaries.add("myagent"));
  await custom.getByRole("button", { name: "Test", exact: true }).click();
  await expect(custom.locator("[data-test-result='found']")).toContainText("Found");
  await expect(custom.locator("[data-test-result='found']")).toContainText("1.0.0");

  await custom.getByRole("button", { name: "Save agent" }).click();
  await expect(custom).toHaveCount(0);

  // The catalog row appears with the Custom badge and its detection result.
  const row = dialog.locator('[data-agent-id="my-agent"]');
  await expect(row).toContainText("My Agent");
  await expect(row).toContainText("Custom");
  await expect(row).toContainText("1.0.0");
  await row.click();
  const detail = dialog.locator("[data-agent-detail]");
  await expect(detail).toContainText("Custom");
  await expect(detail.locator("[data-edit-agent]")).toBeVisible();
  await expect(detail.locator("[data-delete-agent]")).toBeVisible();
  await shot(page, testInfo, "custom-agent-added.png");

  // It is launchable: the picker lists its auto-created default profile.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press("Control+Alt+Shift+D");
  const picker = page.locator("[data-agent-picker]");
  await expect(picker).toBeVisible();
  await picker.getByRole("combobox").click();
  await expect(page.getByRole("option", { name: "My Agent · Default" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("shows inline validation errors and refuses a bundled id without override", async ({ page }) => {
  await mockTauri(page, { settings_get: {} });
  const dialog = await openAgents(page);
  const custom = await openCustomDialog(page, dialog);

  await custom.getByRole("button", { name: "Save agent" }).click();
  await expect(custom.locator("[data-form-error]")).toContainText("Fix the highlighted fields");
  await expect(custom.getByLabel("Name")).toHaveAttribute("aria-invalid", "true");

  // A bundled id flags the id field until the override switch is ticked. The name must not derive to
  // "claude" itself, or filling the same id fires no change event.
  await custom.getByLabel("Name").fill("My Claude");
  await custom.getByLabel("ID", { exact: true }).fill("claude");
  await expect(custom.getByLabel("ID", { exact: true })).toHaveValue("claude");
  await fillValid(custom);
  await expect(custom.getByLabel("ID", { exact: true })).toHaveValue("claude");
  await custom.getByRole("button", { name: "Save agent" }).click();
  await expect(custom.locator("[data-bundled-id]")).toBeVisible();
  await custom.getByRole("switch").click();
  await custom.getByRole("button", { name: "Save agent" }).click();
  await expect(custom).toHaveCount(0);
  await expect(dialog.locator('[data-agent-id="claude"]')).toContainText("Override");
});

test("edits a custom agent and deletes it once profiles are gone", async ({ page }, testInfo) => {
  await mockTauri(page, { settings_get: {} });
  const dialog = await openAgents(page);
  const custom = await openCustomDialog(page, dialog);
  await fillValid(custom);
  await page.evaluate(() => window.__tesseraAgents?.installedBinaries.add("myagent"));
  await custom.getByRole("button", { name: "Save agent" }).click();
  await expect(custom).toHaveCount(0);

  // Delete is blocked while the auto-created default profile exists.
  const row = dialog.locator('[data-agent-id="my-agent"]');
  await row.click();
  await dialog.locator("[data-agent-detail] [data-delete-agent]").click();
  const confirm = page.locator("[data-delete-agent-dialog]");
  await expect(confirm.locator("[data-delete-blocked]")).toContainText("Default");
  await expect(confirm.locator("[data-delete-agent-confirm]")).toBeDisabled();
  await shot(page, testInfo, "custom-agent-delete-blocked.png");
  await confirm.getByRole("button", { name: "Keep agent" }).click();

  // Remove the profile, then delete succeeds.
  const detail = dialog.locator("[data-agent-detail]");
  await detail.getByRole("button", { name: /Delete profile: Default/ }).click();
  await detail.getByRole("button", { name: "Delete", exact: true }).last().click();
  await detail.locator("[data-delete-agent]").click();
  const confirm2 = page.locator("[data-delete-agent-dialog]");
  await expect(confirm2.locator("[data-delete-blocked]")).toHaveCount(0);
  await confirm2.locator("[data-delete-agent-confirm]").click();
  await expect(dialog.locator('[data-agent-id="my-agent"]')).toHaveCount(0);
  await expect(dialog.locator("[data-agent-count]")).toContainText("3 of 10 installed");
});

test("edit reloads the stored definition", async ({ page }) => {
  await mockTauri(page, { settings_get: {} });
  const dialog = await openAgents(page);
  const custom = await openCustomDialog(page, dialog);
  await fillValid(custom);
  await custom.getByLabel("Model flag").fill("--model");
  await custom.getByRole("button", { name: "Save agent" }).click();
  await expect(custom).toHaveCount(0);

  await dialog.locator('[data-agent-id="my-agent"]').click();
  await dialog.locator("[data-agent-detail] [data-edit-agent]").click();
  const edit = page.locator("[data-custom-agent-dialog]");
  await expect(edit.getByLabel("Name")).toHaveValue("My Agent");
  await expect(edit.getByLabel("ID")).toHaveValue("my-agent");
  await expect(edit.getByLabel("Commands to look for")).toHaveValue("myagent, myagent-cli");
  await expect(edit.getByLabel("Model flag")).toHaveValue("--model");
  await edit.getByLabel("Name").fill("My Agent Two");
  await edit.getByRole("button", { name: "Save agent" }).click();
  await expect(edit).toHaveCount(0);
  await expect(dialog.locator('[data-agent-id="my-agent"]')).toContainText("My Agent Two");
});

for (const scheme of ["light", "dark"] as const) {
  for (const [width, height] of [
    [1280, 800],
    [900, 600],
  ] as const) {
    test(`screenshot ${scheme} ${width}×${height}`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      await mockTauri(page, { settings_get: {} });
      const dialog = await openAgents(page);
      const custom = await openCustomDialog(page, dialog);
      await fillValid(custom);
      await shot(page, testInfo, `custom-agent-${scheme}-${width}x${height}.png`);
    });
  }
}
