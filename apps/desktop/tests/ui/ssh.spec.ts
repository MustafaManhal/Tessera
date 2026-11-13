import { join } from "node:path";
import { expect, type Locator, type Page, type TestInfo, test } from "@playwright/test";
import { openTerminal } from "./terminal-helpers";

// S-19 SSH hosts (M10.1) against the in-memory fake client: the list (config hosts first), add, edit, the keychain
// password dialog, remove, and Connect opening an `ssh` pane that spawns the plan. Screenshots go to
// TESSERA_SHOTS_DIR or the test output folder.

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const dir = process.env.TESSERA_SHOTS_DIR;
  const path = dir ? join(dir, name) : testInfo.outputPath(name);
  await page.screenshot({ path, animations: "disabled" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function openSsh(page: Page): Promise<Locator> {
  await openTerminal(page);
  await page.keyboard.press("Control+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "SSH hosts", exact: true }).click();
  await expect(dialog.locator("[data-ssh-page]")).toBeVisible();
  return dialog;
}

const programs = (page: Page) =>
  page.evaluate(() =>
    (window.__tesseraFakePty?.log.spawns ?? []).map((spec) => ({
      program: spec.program ?? null,
      args: spec.args ?? [],
    })),
  );

test("lists config hosts first, then manual ones, with their sign-in method", async ({ page }) => {
  const dialog = await openSsh(page);
  const rows = dialog.locator("[data-ssh-host]");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute("data-ssh-host", "build");
  await expect(rows.nth(1)).toContainText("via build");
  await expect(rows.nth(2)).toContainText("Added in Tessera");
  await expect(rows.nth(2)).toContainText("Password in keychain");
});

test("adds a host, refuses a bad port and a duplicate name, edits and removes it", async ({ page }) => {
  const dialog = await openSsh(page);
  await dialog.getByRole("button", { name: "Add host" }).click();
  const form = page.locator("[data-ssh-host-dialog]");
  await form.getByLabel("Name", { exact: true }).fill("staging");
  await form.getByLabel("Host name or address").fill("staging.example.com");
  await form.getByLabel("Port").fill("99999");
  await expect(form.getByText("Use a port from 1 to 65535.")).toBeVisible();
  await expect(form.getByRole("button", { name: "Save host" })).toBeDisabled();
  await form.getByLabel("Port").fill("2200");
  await form.getByLabel("User").fill("ops");
  await form.getByRole("button", { name: "Save host" }).click();
  await expect(form).toHaveCount(0);
  const row = dialog.locator('[data-ssh-host="staging"]');
  await expect(row).toContainText("ops@staging.example.com:2200");

  await dialog.getByRole("button", { name: "Add host" }).click();
  await form.getByLabel("Name", { exact: true }).fill("staging");
  await form.getByLabel("Host name or address").fill("x");
  await form.getByRole("button", { name: "Save host" }).click();
  await expect(form.getByRole("alert")).toContainText("already exists");
  await form.getByRole("button", { name: "Cancel" }).click();

  await row.getByRole("button", { name: "Edit" }).click();
  await form.getByLabel("User").fill("root");
  await form.getByRole("button", { name: "Save host" }).click();
  await expect(row).toContainText("root@staging.example.com:2200");

  await row.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(row).toHaveCount(0);
});

test("a config host keeps its address read-only; the password goes to the keychain and can be forgotten", async ({
  page,
}) => {
  const dialog = await openSsh(page);
  const build = dialog.locator('[data-ssh-host="build"]');
  await build.getByRole("button", { name: "Edit" }).click();
  const form = page.locator("[data-ssh-host-dialog]");
  await expect(form.getByLabel("Host name or address")).toBeDisabled();
  await form.getByRole("button", { name: "Cancel" }).click();

  await build.getByRole("button", { name: "Save password" }).click();
  const password = page.locator("[data-ssh-password-dialog]");
  await expect(password).toContainText("keychain");
  await expect(password.getByRole("button", { name: "Save password" })).toBeDisabled();
  await password.getByLabel("Password").fill("s3cret");
  await password.getByRole("button", { name: "Save password" }).click();
  await expect(build).toContainText("Password in keychain");
  expect(await page.evaluate(() => window.__tesseraSsh?.passwords.get("build"))).toBe("s3cret");
  // The password never shows up in the page.
  await expect(page.locator("body")).not.toContainText("s3cret");

  await build.getByRole("button", { name: "Password" }).click();
  await password.getByRole("button", { name: "Forget password" }).click();
  await expect(build).not.toContainText("Password in keychain");
});

test("Connect opens an ssh pane that spawns the plan, from the page and from the palette picker", async ({ page }) => {
  const dialog = await openSsh(page);
  await dialog.locator('[data-ssh-host="db"]').getByRole("button", { name: "Connect" }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => (await programs(page)).some((p) => p.program === "ssh" && p.args[0] === "db"))
    .toBe(true);
  await expect(page.getByRole("tab", { name: /db/ })).toHaveCount(1);

  await page.keyboard.press("Control+Alt+Shift+K");
  const picker = page.locator("[data-ssh-picker]");
  await expect(picker).toBeVisible();
  await picker.getByRole("button", { name: "Connect" }).click();
  await expect
    .poll(async () => (await programs(page)).filter((p) => p.program === "ssh" && p.args[0] === "build").length)
    .toBe(1);
});

for (const scheme of ["light", "dark"] as const) {
  for (const [width, height] of [
    [1280, 800],
    [900, 600],
  ] as const) {
    test(`screenshot: SSH hosts (${scheme}, ${width}×${height})`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      await openSsh(page);
      await shot(page, testInfo, `ssh-hosts-${scheme}-${width}x${height}.png`);
    });
  }
}
