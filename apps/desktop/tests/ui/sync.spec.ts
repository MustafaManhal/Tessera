import { join } from "node:path";
import { expect, type Locator, type Page, type TestInfo, test } from "@playwright/test";
import { openTerminal } from "./terminal-helpers";

// S-21 Account and sync (M11.2) against the fake sync client: sign-in by device code, the recovery key shown once,
// entering a saved key, what syncs, Sync now, sign out, delete all. Screenshots go to TESSERA_SHOTS_DIR or the test
// output folder.

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

async function openAccount(page: Page): Promise<Locator> {
  await openTerminal(page);
  await page.keyboard.press("Control+Alt+Shift+1");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.locator("[data-sync-page]")).toBeVisible();
  return dialog;
}

test("signed out explains sync and that everything works without it", async ({ page }) => {
  const dialog = await openAccount(page);
  await expect(dialog.locator("[data-sync-signed-out]")).toContainText("Everything works without signing in");
  await expect(dialog.getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();
});

test("a new account: device code, recovery key shown once, then the signed-in controls", async ({ page }) => {
  const dialog = await openAccount(page);
  await dialog.getByRole("button", { name: "Sign in with GitHub" }).click();
  await expect(dialog.locator("[data-recovery-key]")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Create recovery key" }).click();
  const key = dialog.locator("[data-recovery-key]");
  await expect(key).toHaveText("ABCD-EFGH-JKMN-PQRS-TVWX-YZ01");
  const proceed = dialog.getByRole("button", { name: "Continue" });
  await expect(proceed).toBeDisabled();
  await dialog.getByLabel("I saved my recovery key").click();
  await proceed.click();
  await expect(key).toHaveCount(0);
  const signedIn = dialog.locator("[data-sync-signed-in]");
  await expect(signedIn).toContainText("Not synced yet.");
  await signedIn.getByRole("button", { name: "Sync now" }).click();
  await expect(signedIn).toContainText("Last synced");
  await dialog.getByLabel("Project list (names and remote addresses)").click();
  expect(await page.evaluate(() => window.__tesseraSync?.docs)).toEqual(["settings", "agent-profiles"]);
});

test("another computer enters the saved key; a wrong key is refused", async ({ page }) => {
  const dialog = await openAccount(page);
  await page.evaluate(() => {
    if (window.__tesseraSync) window.__tesseraSync.remoteData = true;
  });
  await dialog.getByRole("button", { name: "Sign in with GitHub" }).click();
  const form = dialog.locator("[data-sync-recovery-enter]");
  await expect(form).toBeVisible();
  await form.getByLabel("Recovery key").fill("WRON-GKEY-0000-0000-0000-0000");
  await form.getByRole("button", { name: "Unlock" }).click();
  await expect(dialog.getByRole("alert")).toContainText("could not be decrypted");
  await form.getByLabel("Recovery key").fill("abcd efgh jkmn pqrs tvwx yz01");
  await form.getByRole("button", { name: "Unlock" }).click();
  await expect(dialog.locator("[data-sync-signed-in]")).toBeVisible();
});

test("delete all asks first, then signs out", async ({ page }) => {
  const dialog = await openAccount(page);
  await dialog.getByRole("button", { name: "Sign in with GitHub" }).click();
  await dialog.getByRole("button", { name: "Create recovery key" }).click();
  await dialog.getByLabel("I saved my recovery key").click();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByRole("button", { name: "Delete all synced data" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Data on your computers stays");
  await confirm.getByRole("button", { name: "Delete all synced data" }).click();
  await expect(dialog.locator("[data-sync-signed-out]")).toBeVisible();
  expect(await page.evaluate(() => window.__tesseraSync?.deleted)).toBe(true);
});

for (const scheme of ["light", "dark"] as const) {
  for (const [width, height] of [
    [1280, 800],
    [900, 600],
  ] as const) {
    test(`screenshot: account and sync (${scheme}, ${width}×${height})`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      const dialog = await openAccount(page);
      await dialog.getByRole("button", { name: "Sign in with GitHub" }).click();
      await dialog.getByRole("button", { name: "Create recovery key" }).click();
      await shot(page, testInfo, `sync-recovery-${scheme}-${width}x${height}.png`);
    });
  }
}
