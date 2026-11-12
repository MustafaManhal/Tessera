import { expect, test } from "@playwright/test";
import { openTerminal } from "./terminal-helpers";

const SHOTS = process.env.TESSERA_SHOTS_DIR ?? ".ai/agent-lead/briefs/shots/37";

async function openSettings(page: import("@playwright/test").Page) {
  await openTerminal(page, "demo&renderer=dom");
  await page.keyboard.press("Control+,");
  await expect(page.getByRole("dialog")).toBeVisible();
}

test("GitHub section: not connected → device flow → connected → disconnect", async ({ page }) => {
  await openSettings(page);
  const row = page.locator("[data-github-row]");
  await expect(row).toContainText("GitHub");
  await row.getByRole("button", { name: "Connect with GitHub" }).click();
  await expect(row.locator("[data-user-code]")).toHaveText("WDJB-MJHT");
  await expect(row.getByRole("button", { name: "Waiting for GitHub…" })).toBeVisible();
  // Fake finishes the flow on the next poll (interval 1s).
  await page.evaluate(() => window.__tesseraGithub?.finishDeviceFlow());
  await expect(row).toContainText("hubot", { timeout: 10_000 });
  await row.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("dialog", { name: "Disconnect GitHub?" })).toBeVisible();
  await page.getByRole("button", { name: "Disconnect" }).last().click();
  await expect(row.getByRole("button", { name: "Connect with GitHub" })).toBeVisible();
});

test("gh import connects and a failure shows the error", async ({ page }) => {
  await openSettings(page);
  const row = page.locator("[data-github-row]");
  await page.evaluate(() => {
    window.__tesseraGithub!.failImport = "github.gh_missing: gh is not installed";
  });
  await row.getByRole("button", { name: "Use my gh login" }).click();
  await expect(row.locator("[data-github-error]")).toBeVisible();
  await page.evaluate(() => {
    window.__tesseraGithub!.failImport = null;
  });
  await row.getByRole("button", { name: "Use my gh login" }).click();
  await expect(row).toContainText("octocat");
});

for (const [scheme, size] of [
  ["light", { width: 1280, height: 800 }],
  ["dark", { width: 1280, height: 800 }],
  ["light", { width: 900, height: 600 }],
  ["dark", { width: 900, height: 600 }],
] as const) {
  test(`screenshot ${scheme} ${size.width}x${size.height}: github section`, async ({ page }) => {
    await page.setViewportSize(size);
    await openSettings(page);
    const row = page.locator("[data-github-row]");
    await row.getByRole("button", { name: "Connect with GitHub" }).click();
    await expect(row.locator("[data-user-code]")).toBeVisible();
    await page.waitForTimeout(300);
    const dir = SHOTS.startsWith("/") ? SHOTS : `${process.cwd()}/../../${SHOTS}`;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/github-${scheme}-${size.width}x${size.height}.png` });
  });
}
