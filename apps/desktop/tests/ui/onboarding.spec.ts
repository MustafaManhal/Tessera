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

test("first run walks the four cards of the tour and finishes", async ({ page }) => {
  await prepare(page);
  await openOnboarding(page);
  const wizard = page.locator("[data-onboarding]");
  await expect(wizard).toContainText("Welcome to Tessera");
  await shot(page, "onboarding-welcome.png");
  await page.getByRole("button", { name: "Get started" }).click();
  await expect(wizard.locator("[data-onboarding-step]")).toHaveAttribute("data-onboarding-step", "tasks");
  await expect(wizard).toContainText("Projects and tasks");
  // Back returns, the arrow keys move too, and the main button keeps the focus so Enter walks on.
  await wizard.getByRole("button", { name: "Back", exact: true }).click();
  await expect(wizard).toContainText("Welcome to Tessera");
  await page.keyboard.press("ArrowRight");
  await expect(wizard).toContainText("Projects and tasks");
  await expect(page.getByRole("button", { name: "Next" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(wizard).toContainText("Agents side by side");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(wizard).toContainText("Review and ship");
  await expect(wizard).toContainText("4 of 4");
  // The last card says once that error reports are sent and where to turn them off.
  await expect(wizard.locator("[data-onboarding-reports]")).toContainText("Settings, Privacy");
  await page.getByRole("button", { name: "Finish" }).click();
  await expect(wizard).toHaveCount(0);
  const calls = await page.evaluate(
    () => (window as never as { __tesseraOnboarding: { calls: string[] } }).__tesseraOnboarding.calls,
  );
  expect(calls).toContain("onboardingComplete");
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

test("Settings imports another terminal's settings, and lists only the importers found", async ({ page }) => {
  await mockTauri(page, { settings_get: {} });
  await openTerminal(page, "demo&renderer=dom");
  await page.evaluate(() => {
    const client = (
      window as never as {
        __tesseraOnboarding: { sources: { id: string; available: boolean }[]; previews: Map<string, unknown> };
      }
    ).__tesseraOnboarding;
    client.sources = client.sources.map((s) => ({ ...s, available: s.id === "ghostty" }));
    client.previews.set("ghostty", {
      applied: [
        { key: "font.family", value: "JetBrainsMono Nerd Font", label: "Font family: JetBrainsMono Nerd Font" },
      ],
      failed: [{ item: "theme", reason: "Ghostty themes are not Tessera colour schemes" }],
    });
  });
  await page.keyboard.press("Control+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  const row = settings.locator("[data-setting='import.terminal']");
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: "Import from iTerm2" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Import from Windows Terminal" })).toHaveCount(0);
  await row.getByRole("button", { name: "Import from Ghostty" }).click();
  const preview = page.getByRole("dialog", { name: "Import from Ghostty" });
  await expect(preview).toContainText("Font family: JetBrainsMono Nerd Font");
  await expect(preview.locator("[data-import-failed]")).toContainText("theme");
  await preview.getByRole("button", { name: "Import", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(row).toContainText("Imported from Ghostty.");
  const applied = await page.evaluate(
    () => (window as never as { __tesseraOnboarding: { applied: string[] } }).__tesseraOnboarding.applied,
  );
  expect(applied).toContain("ghostty");
});

test("the tour fits a short window with its buttons in view", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 420 });
  await prepare(page);
  await openOnboarding(page);
  for (const name of ["Get started", "Next", "Next", "Finish"]) {
    const button = page.getByRole("button", { name, exact: true });
    await expect(button).toBeInViewport({ ratio: 1 });
    if (name !== "Finish") await button.click();
  }
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
