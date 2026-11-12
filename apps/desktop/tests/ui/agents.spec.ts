import { join } from "node:path";
import { expect, type Locator, type Page, type TestInfo, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { openTerminal } from "./terminal-helpers";

// The agent catalog and profiles screen (S-05) against the in-memory fake client: list order and states, rescan,
// profile CRUD, the skip-permissions warning, the command preview (no env values), a keyboard-only pass and the
// palette action. Screenshots go to TESSERA_SHOTS_DIR or the test output folder.

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const dir = process.env.TESSERA_SHOTS_DIR;
  const path = dir ? join(dir, name) : testInfo.outputPath(name);
  await page.screenshot({ path, animations: "disabled" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test.beforeEach(async ({ page }) => {
  // Links open in the system browser; keep Playwright from opening pages for them.
  await page.addInitScript(() => {
    window.open = () => null;
  });
});

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

const profiles = (page: Page) => page.evaluate(() => window.__tesseraAgents?.allProfiles() ?? []);

test("lists installed agents first with versions, paths, links and the broken override", async ({ page }) => {
  await mockTauri(page, { settings_get: {} });
  const dialog = await openAgents(page);
  const rows = dialog.locator("[data-agent-list] [data-agent-id]");
  await expect(rows).toHaveCount(10);
  await expect(dialog.locator('[data-agent-list] [data-agent-id][data-installed="true"]')).toHaveCount(3);

  // Every row has a logo: a brand mark where Tessera has one, a lettered badge otherwise.
  await expect(dialog.locator("[data-agent-list] [data-agent-logo]")).toHaveCount(10);
  await expect(rows.nth(0).locator('svg[data-agent-logo="claude"]')).toBeVisible();
  await expect(dialog.locator('[data-agent-list] span[data-agent-logo="aider"]')).toHaveText("AI");

  // Installed first: Claude Code, Codex, Gemini, then the rest.
  await expect(rows.nth(0)).toContainText("Claude Code");
  await expect(rows.nth(0)).toContainText("2.1.4");
  await expect(rows.nth(0)).toHaveAttribute("data-installed", "true");
  await expect(rows.nth(2)).toHaveAttribute("data-installed", "true");
  await expect(rows.nth(3)).toHaveAttribute("data-installed", "false");
  await expect(rows.nth(3)).toContainText("Not found");
  await expect(dialog.locator("[data-agent-count]")).toHaveText("3 of 10 installed");

  // The default selection shows Claude Code's version, path and hook state.
  const detail = dialog.locator("[data-agent-detail]");
  await expect(detail).toContainText("/opt/homebrew/bin/claude");
  await expect(detail).toContainText("Installed");

  // Install and docs links open the official URLs (recorded by the opener).
  await dialog.getByRole("button", { name: "Install OpenCode" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__tesseraOpened?.at(-1)))
    .toEqual({ kind: "url", url: "https://opencode.ai/docs/" });
  await dialog.getByRole("button", { name: "Docs Aider" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__tesseraOpened?.at(-1)))
    .toEqual({ kind: "url", url: "https://aider.chat/docs" });

  // The user override keeps its badge and shows the parse error.
  await dialog.locator('[data-agent-id="aider"]').click();
  await expect(detail).toContainText("Override");
  await expect(dialog.locator("[data-definition-error]")).toContainText("unknown key");
});

test("with nothing installed, keeps all ten rows and says what installing does", async ({ page }) => {
  await mockTauri(page, { settings_get: {} });
  const dialog = await openAgents(page);
  await page.evaluate(() => {
    for (const id of ["claude", "codex", "gemini"]) window.__tesseraAgents?.setInstalled(id, false);
  });

  const rows = dialog.locator("[data-agent-list] [data-agent-id]");
  await expect(rows).toHaveCount(10);
  await expect(dialog.locator('[data-agent-list] [data-agent-id][data-installed="true"]')).toHaveCount(0);
  await expect(dialog.locator("[data-agent-count]")).toHaveText("0 of 10 installed");
  await expect(dialog.locator("[data-agents-empty]")).toContainText("Install one from the list");
  await expect(
    dialog.getByRole("navigation", { name: "Agents" }).getByRole("button", { name: "Install Claude Code" }),
  ).toBeVisible();

  // The detail panel still explains the selected agent and its install hint.
  await expect(dialog.locator("[data-agent-detail]")).toContainText("Install");
});

test("opens from the palette action", async ({ page }) => {
  await mockTauri(page, { settings_get: {} });
  await openTerminal(page);
  await page.keyboard.press("Control+K");
  const palette = page.getByRole("combobox");
  await palette.fill("agents and profiles");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-agents-page]")).toBeVisible();
  await expect(dialog.locator("[data-agent-count]")).toHaveText("3 of 10 installed");
});

test("rescan shows a busy state and comes back", async ({ page }) => {
  await mockTauri(page, { settings_get: {} });
  const dialog = await openAgents(page);
  await page.evaluate(() => window.__tesseraAgents?.setRescanMs(500));
  const rescan = dialog.getByRole("button", { name: "Rescan" });
  await rescan.click();
  await expect(rescan).toHaveAttribute("aria-busy", "true");
  await expect(rescan).not.toHaveAttribute("aria-busy", "true", { timeout: 10_000 });
  await expect(dialog.locator("[data-agent-count]")).toHaveText("3 of 10 installed");
});

test("creates, edits, makes default, duplicates and deletes a profile", async ({ page }) => {
  await mockTauri(page, { settings_get: {} });
  const dialog = await openAgents(page);
  await expect(dialog.locator("[data-profile-id]")).toHaveCount(1);

  await dialog.getByRole("button", { name: "Add profile" }).click();
  const form = dialog.locator("[data-profile-form]");
  await expect(form).toBeVisible();
  const name = form.getByRole("textbox", { name: "Profile name" });
  await expect(name).toBeFocused();
  await name.fill("Review");
  await form.getByRole("textbox", { name: "Model" }).fill("opus");
  await form.getByRole("textbox", { name: "Extra arguments" }).fill("--verbose 'two words'");
  await expect(form.locator("[data-args-chips]")).toContainText("two words");

  // Environment rows: the preview shows the name, never the value.
  await form.getByRole("button", { name: "Add variable" }).click();
  await form.getByRole("textbox", { name: "Name 1" }).fill("REVIEW_TOKEN");
  await form.getByRole("textbox", { name: "Value 1" }).fill("secret-value-xyz");
  const preview = form.locator("[data-command-preview]");
  await expect(preview).toContainText("REVIEW_TOKEN");
  await expect(preview).not.toContainText("secret-value-xyz");

  await expect
    .poll(() =>
      page.evaluate(
        () => window.__tesseraAgents?.allProfiles().find((profile) => profile.name === "Review")?.env.REVIEW_TOKEN,
      ),
    )
    .toBe("secret-value-xyz");
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__tesseraAgents?.allProfiles().find((profile) => profile.name === "Review")?.extra_args,
      ),
    )
    .toEqual(["--verbose", "two words"]);
  await expect(preview).toContainText("--model opus");

  // Make default.
  await dialog.getByRole("button", { name: "Make default: Review" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__tesseraAgents?.allProfiles().find((profile) => profile.name === "Review")?.is_default,
      ),
    )
    .toBe(true);
  await expect(dialog.locator("[data-profile-id]").filter({ hasText: "Review" }).first()).toHaveAttribute(
    "data-default",
    "true",
  );

  // Duplicate: a copy opens in the editor, ready to rename.
  await dialog.getByRole("button", { name: "Duplicate profile: Review" }).click();
  const copyForm = dialog.locator("[data-profile-form]");
  await expect(copyForm.getByRole("textbox", { name: "Profile name" })).toHaveValue("Review copy");
  await copyForm.getByRole("textbox", { name: "Profile name" }).fill("Copy two");
  await expect
    .poll(() =>
      page.evaluate(() => window.__tesseraAgents?.allProfiles().some((profile) => profile.name === "Copy two")),
    )
    .toBe(true);

  // Delete asks first.
  await dialog.getByRole("button", { name: "Delete profile: Copy two" }).click();
  await expect(dialog.locator("[data-delete-confirm]")).toContainText('Delete the profile "Copy two"?');
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog.locator("[data-profile-id]").filter({ hasText: "Copy two" })).toHaveCount(0);
  const left = await profiles(page);
  expect(left.some((profile) => profile.name === "Copy two")).toBe(false);
  expect(left.filter((profile) => profile.agent_id === "claude")).toHaveLength(2);
});

test("the skip-permissions warning and flag appear only when on, and only where supported", async ({ page }) => {
  await mockTauri(page, { settings_get: {} });
  const dialog = await openAgents(page);
  await dialog.getByRole("button", { name: "Edit profile: Claude Code" }).click();
  const form = dialog.locator("[data-profile-form]");
  const skip = form.getByRole("switch", { name: "Skip permission prompts" });
  await expect(skip).not.toBeChecked();
  await expect(form.locator("[data-skip-warning]")).toHaveCount(0);

  await skip.click();
  await expect(form.locator("[data-skip-warning]")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__tesseraAgents?.allProfiles().find((profile) => profile.agent_id === "claude")?.skip_permissions,
      ),
    )
    .toBe(true);
  await expect(form.locator("[data-command-preview]")).toContainText("--dangerously-skip-permissions");
  await expect(dialog.locator("[data-profile-id]").filter({ hasText: "Skips permissions" })).toBeVisible();

  await skip.click();
  await expect(form.locator("[data-skip-warning]")).toHaveCount(0);

  // OpenCode's definition has no permission-skipping flag, so its editor has no switch at all.
  await dialog.locator('[data-agent-id="opencode"]').click();
  await dialog.getByRole("button", { name: "Add profile" }).click();
  await expect(dialog.locator("[data-profile-form]").getByRole("switch")).toHaveCount(0);
});

test("works from the keyboard alone", async ({ page }) => {
  await mockTauri(page, { settings_get: {} });
  await openTerminal(page);
  await page.keyboard.press("Control+K");
  await page.getByRole("combobox").fill("agents and profiles");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.locator("[data-agents-page]")).toBeVisible();

  // Tab from the search box to the agent list; arrow keys move the selection and the focus.
  let focused: string | null = null;
  for (let i = 0; i < 12 && !focused; i++) {
    await page.keyboard.press("Tab");
    focused = await page.evaluate(() => document.activeElement?.getAttribute("data-agent-id") ?? null);
  }
  expect(focused).toBe("claude");
  await page.keyboard.press("ArrowDown");
  await expect(dialog.locator('[data-agent-id="codex"]')).toHaveAttribute("data-selected", "true");

  // Tab to "Add profile" and open the editor with Enter; the name field takes focus.
  const seen: string[] = [];
  for (let i = 0; i < 12 && !seen.includes("Add profile"); i++) {
    await page.keyboard.press("Tab");
    seen.push(
      await page.evaluate(
        () =>
          (document.activeElement as HTMLElement | null)?.getAttribute("aria-label") ??
          document.activeElement?.textContent?.trim() ??
          "",
      ),
    );
  }
  expect(seen).toContain("Add profile");
  await page.keyboard.press("Enter");
  const form = dialog.locator("[data-profile-form]");
  await expect(form).toBeVisible();
  await expect(form.getByRole("textbox", { name: "Profile name" })).toBeFocused();
  await page.keyboard.type("Keyboard profile");
  await expect
    .poll(() =>
      page.evaluate(() => window.__tesseraAgents?.allProfiles().some((profile) => profile.name === "Keyboard profile")),
    )
    .toBe(true);
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
      await dialog.getByRole("button", { name: "Edit profile: Claude Code" }).click();
      await expect(dialog.locator("[data-profile-form]")).toBeVisible();
      await shot(page, testInfo, `agents-${scheme}-${width}x${height}.png`);
    });
  }
}
