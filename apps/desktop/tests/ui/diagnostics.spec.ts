import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openTerminal } from "./terminal-helpers";

// Privacy and diagnostics (M12.4): the usage-stats switch is off by default, error toasts can be copied as a report.
const SHOTS = process.env.TESSERA_SHOTS_DIR ?? join(tmpdir(), "tessera-shots", "50");

test("Advanced: usage statistics are off by default and the choice sticks within the session", async ({ page }) => {
  await openTerminal(page, "demo&renderer=dom");
  await page.keyboard.press("Control+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Advanced", exact: true }).click();
  const row = settings.locator('[data-setting="privacy.usageStats"]');
  const toggle = row.getByRole("switch", { name: "Send anonymous usage statistics" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(row).toContainText("does not collect or send any statistics");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: join(SHOTS, "advanced-privacy.png") });
});

test("Copy error report puts a report on the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openTerminal(page, "demo&renderer=dom");
  await page.keyboard.press("Control+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Advanced", exact: true }).click();
  await settings.locator("[data-copy-report]").click();
  await expect(page.getByText("Error report copied").first()).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Tessera error report");
});

test("every error toast offers its details as a report", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openTerminal(page, "demo&renderer=dom");
  await page.evaluate(() =>
    window.__tesseraToast?.({ kind: "error", title: "Push failed", description: "remote said no" }),
  );
  const copy = page.getByRole("button", { name: "Copy details" });
  await expect(copy).toBeVisible();
  await copy.click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain("Error: Push failed");
  expect(text).toContain("Details: remote said no");
  // A toast that is not an error has no such button.
  await page.evaluate(() => window.__tesseraToast?.({ kind: "success", title: "Saved" }));
  await expect(
    page.getByRole("status").filter({ hasText: "Saved" }).getByRole("button", { name: "Copy details" }),
  ).toHaveCount(0);
});
