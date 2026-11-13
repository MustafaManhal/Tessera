import { expect, test, type Page } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { openTerminal } from "./terminal-helpers";

const SHOTS = process.env.TESSERA_SHOTS_DIR ?? ".ai/agent-lead/briefs/shots/47";

async function shot(page: Page, name: string) {
  const dir = SHOTS.startsWith("/") ? SHOTS : `${process.cwd()}/../../${SHOTS}`;
  await page.screenshot({ path: `${dir}/${name}`, fullPage: false });
}

/** The fake starts done; flip it and fire the same event Settings → "Run setup again" uses. */
async function openOnboarding(page: Page) {
  await page.evaluate(() => {
    const client = (window as never as { __tesseraOnboarding: { done: boolean } }).__tesseraOnboarding;
    client.done = false;
    window.dispatchEvent(new Event("tessera:onboarding-reset"));
  });
  await expect(page.locator("[data-onboarding]")).toBeVisible();
}

async function prepare(page: Page) {
  await mockTauri(page);
  await openTerminal(page, "demo&renderer=dom");
  await expect(page.getByRole("treeitem", { name: /^Dark mode,/ })).toBeVisible();
}

test("first run walks all four steps and finishes", async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => {
    const client = (window as never as { __tesseraOnboarding: { previews: Map<string, unknown> } }).__tesseraOnboarding;
    client.previews.set("ghostty", {
      applied: [
        { key: "font.family", value: "JetBrainsMono Nerd Font", label: "Font family: JetBrainsMono Nerd Font" },
        { key: "font.size", value: 14, label: "Font size: 14" },
      ],
      failed: [
        { item: "theme", reason: "Ghostty themes are not Tessera colour schemes" },
        { item: "keybinds", reason: "Ghostty keybinds do not map onto Tessera actions" },
      ],
    });
  });
  await openOnboarding(page);
  // Step 1 welcome.
  await expect(page.locator("[data-onboarding]")).toContainText("Welcome to Tessera");
  await shot(page, "onboarding-welcome.png");
  await page.getByRole("button", { name: "Get started" }).click();
  // Step 2 look: theme + font + import.
  await expect(page.locator("[data-onboarding]")).toContainText("Make it yours");
  await page.getByRole("button", { name: "Import from Ghostty" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Font family: JetBrainsMono Nerd Font");
  await expect(dialog.locator("[data-import-failed]")).toContainText("theme");
  await shot(page, "onboarding-import.png");
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Next" }).click();
  // Step 3 agents.
  await expect(page.locator("[data-onboarding]")).toContainText("Your agents");
  await expect(page.locator("[data-agent-row]").first()).toBeVisible();
  await shot(page, "onboarding-agents.png");
  // Toggle the first agent's hooks switch.
  const firstHooks = page.locator("[data-agent-row] input[type=checkbox]").first();
  await firstHooks.click();
  await page.getByRole("button", { name: "Next" }).click();
  // Step 4 project: skip via Finish.
  await expect(page.locator("[data-onboarding]")).toContainText("First project");
  await page.getByRole("button", { name: "Finish" }).click();
  await expect(page.locator("[data-onboarding]")).toHaveCount(0);
  const calls = await page.evaluate(
    () => (window as never as { __tesseraOnboarding: { calls: string[]; applied: string[] } }).__tesseraOnboarding,
  );
  expect(calls.applied).toContain("ghostty");
  expect(calls.calls).toContain("onboardingComplete");
});

test("skip at any step marks onboarding done", async ({ page }) => {
  await prepare(page);
  await openOnboarding(page);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.locator("[data-onboarding]")).toHaveCount(0);
  const done = await page.evaluate(
    () => (window as never as { __tesseraOnboarding: { done: boolean } }).__tesseraOnboarding.done,
  );
  expect(done).toBe(true);
});

test("Settings → Run setup again reopens the wizard", async ({ page }) => {
  await mockTauri(page, { settings_get: {} });
  await openTerminal(page, "demo&renderer=dom");
  await expect(page.getByRole("treeitem", { name: /^Dark mode,/ })).toBeVisible();
  // Open settings and find the row.
  await page.keyboard.press("Control+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  const row = settings.locator("[data-setting='onboarding.runAgain']");
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Run setup again" }).click();
  await expect(page.locator("[data-onboarding]")).toBeVisible();
});

test("unavailable importers are hidden", async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => {
    const client = (window as never as { __tesseraOnboarding: { sources: { id: string; available: boolean }[] } })
      .__tesseraOnboarding;
    client.sources = client.sources.map((s) => ({ ...s, available: s.id === "ghostty" }));
  });
  await openOnboarding(page);
  await page.getByRole("button", { name: "Get started" }).click();
  await expect(page.getByRole("button", { name: "Import from Ghostty" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import from iTerm2" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Import from Windows Terminal" })).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
  for (const [width, height] of [
    [1280, 800],
    [900, 600],
  ] as const) {
    test(`screenshot ${scheme} ${width}×${height}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      await prepare(page);
      await page.evaluate(() => {
        const client = (window as never as { __tesseraOnboarding: { done: boolean; previews: Map<string, unknown> } })
          .__tesseraOnboarding;
        client.done = false;
        client.previews.set("ghostty", {
          applied: [{ key: "font.family", value: "Mono", label: "Font family: Mono" }],
          failed: [{ item: "theme", reason: "not a Tessera theme" }],
        });
        window.dispatchEvent(new Event("tessera:onboarding-reset"));
      });
      await expect(page.locator("[data-onboarding]")).toBeVisible();
      await shot(page, `onboarding-${scheme}-${width}x${height}.png`);
    });
  }
}
