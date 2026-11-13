import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openTerminal } from "./terminal-helpers";

// The Linear key row in Settings (M9.1). Settings needs the plain browser fakes, not the native mock.
const SHOTS = process.env.TESSERA_SHOTS_DIR ?? join(tmpdir(), "tessera-shots", "47");

test("Settings: add a Linear key, see the account, disconnect after confirming", async ({ page }) => {
  await openTerminal(page, "demo&renderer=dom");
  await page.keyboard.press("Control+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "General", exact: true }).click();
  const row = settings.locator("[data-linear-row]");
  await expect(row).toBeVisible();
  const key = row.getByLabel("Linear API key");
  await key.fill("wrong");
  await row.getByRole("button", { name: "Connect" }).click();
  await expect(row.locator("[data-linear-error]")).toContainText("did not accept");
  await key.fill("lin_api_valid");
  await row.getByRole("button", { name: "Connect" }).click();
  await expect(row.locator("[data-linear-account]")).toHaveText("Ada");
  await expect(row.getByLabel("Linear API key")).toHaveCount(0);
  await page.screenshot({ path: join(SHOTS, "linear-settings.png") });
  await row.getByRole("button", { name: "Disconnect" }).click();
  await page.getByRole("dialog", { name: "Disconnect Linear?" }).getByRole("button", { name: "Disconnect" }).click();
  await expect(row.getByLabel("Linear API key")).toBeVisible();
});
