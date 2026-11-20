import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { openTerminal } from "./terminal-helpers";

// Updates (M12.2): Settings page, status bar chip, What's new, against the in-memory fake client.
const SHOTS = process.env.TESSERA_SHOTS_DIR ?? join(tmpdir(), "tessera-shots", "48");
const NEWER = {
  version: "0.2.0",
  current_version: "0.1.0",
  notes: "Faster startup.\n- Fixes for restore\n- New board filters",
  date: "2026-12-01",
};

async function openUpdates(page: Page) {
  await openTerminal(page, "demo&renderer=dom");
  await page.keyboard.press("Control+Alt+Shift+F9");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings.locator("[data-updates-page]")).toBeVisible();
  return settings;
}

test("check now: up to date, then a newer version with notes, then install and restart", async ({ page }) => {
  const settings = await openUpdates(page);
  await expect(settings.locator("[data-update-last]")).toHaveText("Not checked yet");
  await settings.getByRole("button", { name: "Check now" }).click();
  await expect(settings.locator("[data-update-uptodate]")).toHaveText("You have the latest version.");
  await expect(settings.locator("[data-update-last]")).toContainText("Last checked");

  await page.evaluate((info) => {
    if (window.__tesseraUpdates) window.__tesseraUpdates.next = info;
  }, NEWER);
  await settings.getByRole("button", { name: "Check now" }).click();
  const card = settings.locator("[data-update-available]");
  await expect(card).toContainText("Version 0.2.0 is available");
  await expect(card.locator("[data-update-notes]")).toContainText("New board filters");
  await expect(page.locator("[data-update-chip]")).toContainText("Update 0.2.0");
  await page.screenshot({ path: join(SHOTS, "updates-available.png") });

  await card.getByRole("button", { name: "Install update" }).click();
  await expect(settings.locator("[data-update-installed]")).toContainText("Restart Tessera");
  await expect(page.locator("[data-update-chip]")).toContainText("Restart to update");
  await settings.getByRole("button", { name: "Restart now" }).click();
  expect(await page.evaluate(() => window.__tesseraUpdates?.relaunched)).toBe(true);
});

test("errors stay readable and the channel switch drops a pending update", async ({ page }) => {
  const settings = await openUpdates(page);
  await page.evaluate(() => {
    if (window.__tesseraUpdates) window.__tesseraUpdates.failCheck = "Could not check for updates: offline";
  });
  await settings.getByRole("button", { name: "Check now" }).click();
  await expect(settings.locator("[data-update-error]")).toContainText("offline");

  await page.evaluate((info) => {
    const fake = window.__tesseraUpdates;
    if (fake) {
      fake.failCheck = null;
      fake.next = info;
    }
  }, NEWER);
  await settings.getByRole("button", { name: "Check now" }).click();
  await expect(settings.locator("[data-update-available]")).toBeVisible();
  await settings.getByRole("combobox", { name: "Update channel" }).click();
  await page.getByRole("option", { name: /^Beta/ }).click();
  await expect(settings.locator("[data-update-available]")).toHaveCount(0);
  await expect(page.locator("[data-update-chip]")).toHaveCount(0);

  await page.evaluate(() => {
    if (window.__tesseraUpdates)
      window.__tesseraUpdates.failInstall = "The update could not be installed: signature mismatch";
  });
  await settings.getByRole("button", { name: "Check now" }).click();
  await settings.getByRole("button", { name: "Install update" }).click();
  await expect(settings.locator("[data-update-error]")).toContainText("signature mismatch");
  await expect(settings.locator("[data-update-installed]")).toHaveCount(0);
});

test("the background checker shows the chip and the chip opens Updates", async ({ page }) => {
  await openTerminal(page, "demo&renderer=dom");
  await expect(page.locator("[data-update-chip]")).toHaveCount(0);
  await page.evaluate((info) => window.__tesseraUpdates?.announce(info), NEWER);
  const chip = page.locator("[data-update-chip]");
  await expect(chip).toContainText("Update 0.2.0");
  await chip.click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings.locator("[data-update-available]")).toContainText("0.2.0");
});

test("What's new opens from its shortcut and shows only the newest release", async ({ page }) => {
  await openTerminal(page, "demo&renderer=dom");
  await page.keyboard.press("Control+Alt+Shift+F10");
  const dialog = page.getByRole("dialog", { name: "What's new in Tessera" });
  // The fake app is 0.1.0, which has no notes of its own: the dialog shows the newest entry, and nothing older.
  await expect(dialog.locator("[data-release]")).toHaveCount(1);
  await expect(dialog.locator("[data-release]")).toContainText("Version");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("an available update shows only what the new version brings", async ({ page }) => {
  const settings = await openUpdates(page);
  const section = (version: string, line: string) => `Tessera ${version} (2026-11-18)\n- ${line}`;
  const notes = [
    section("0.1.18", "Agents resume"),
    section("0.1.17", "Right-click menu"),
    section("0.1.16", "Git init on main"),
    section("0.1.15", "Ctrl+C copies"),
  ].join("\n\n");
  await page.evaluate((info) => window.__tesseraUpdates?.announce(info), {
    version: "0.1.18",
    current_version: "0.1.15",
    notes,
    date: "2026-11-18",
  });
  // A 0.1.18 manifest carries older sections too; only the new version's is shown.
  const releases = settings.locator("[data-update-available] [data-update-release]");
  await expect(releases).toHaveCount(1);
  await expect(releases.first()).toHaveAttribute("data-update-release", "0.1.18");
  await expect(releases.first()).toContainText("Agents resume");
  await expect(settings.locator("[data-update-notes]")).not.toContainText("Right-click menu");
});

test("after an update, What's new lists every version since the one used before", async ({ page }) => {
  await mockTauri(page, {
    app_info: { name: "Tessera", version: "0.1.18", data_dir: "", log_dir: "", dev_build: true, schema_version: 1 },
  });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("tessera.lastSeenVersion", "0.1.15");
    }
  });
  // The dialog opens by itself and takes the focus, so the terminal is not waited for.
  await page.goto("/?demo&renderer=dom");
  const dialog = page.getByRole("dialog", { name: "What's new in Tessera" });
  await expect(dialog.locator("[data-release]")).toHaveCount(3);
  await expect(dialog.locator("[data-release]").first()).toHaveAttribute("data-release", "0.1.18");
  await expect(dialog.locator("[data-release]").last()).toHaveAttribute("data-release", "0.1.16");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  // Opened again by hand, it shows the running version only.
  await page.keyboard.press("Control+Alt+Shift+F10");
  await expect(dialog.locator("[data-release]")).toHaveCount(1);
});

for (const theme of ["light", "dark"] as const) {
  for (const [width, height] of [
    [1280, 800],
    [900, 600],
  ] as const) {
    test(`screenshot ${theme} ${width}x${height}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height });
      const settings = await openUpdates(page);
      await page.evaluate((info) => window.__tesseraUpdates?.announce(info), NEWER);
      await expect(settings.locator("[data-update-available]")).toBeVisible();
      await page.screenshot({ path: join(SHOTS, `updates-${theme}-${width}.png`) });
    });
  }
}
