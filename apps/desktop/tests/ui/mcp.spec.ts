import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { openTerminal } from "./terminal-helpers";
const SHOTS = process.env.TESSERA_SHOTS_DIR ?? join(tmpdir(), "tessera-shots", "42");
async function open(page: Page, failCopy = false) {
  await page.addInitScript((fail) => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          if (fail) throw Error("fixture denied");
          (window as unknown as Record<string, unknown>).__mcpCopied = value;
        },
      },
    });
  }, failCopy);
  await openTerminal(page, "demo&renderer=dom");
  await page.keyboard.press("Control+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("button", { name: "Advanced", exact: true }).click();
  return dialog;
}
test("MCP is off by default, persists through Settings, and copies the exact command", async ({ page }) => {
  const dialog = await open(page);
  const control = dialog.getByRole("switch", { name: "Let agents drive Tessera through MCP", exact: true });
  await expect(control).not.toBeChecked();
  await expect(dialog.getByRole("heading", { name: "API", exact: true })).toBeVisible();
  await expect(dialog.locator("[data-mcp-command] code")).toHaveText("tessera mcp");
  await control.focus();
  await page.keyboard.press("Space");
  await expect(control).toBeChecked();
  await expect
    .poll(() => page.evaluate(async () => (await window.__tesseraSettings?.get())?.api))
    .toMatchObject({ "mcp-server": true });
  await dialog.getByRole("button", { name: "Copy command", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Record<string, unknown>).__mcpCopied))
    .toBe("tessera mcp");
  await expect(dialog.getByRole("status")).toContainText("Command copied");
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const [width, height] of [
      [1280, 800],
      [900, 600],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: join(SHOTS, `mcp-${theme}-${width}.png`) });
    }
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+,");
  await expect(control).toBeChecked();
  await control.click();
  await expect(control).not.toBeChecked();
  expect(await page.evaluate(() => window.__tesseraSettings?.patches)).toEqual(
    expect.arrayContaining([{ api: { "mcp-server": true } }, { api: { "mcp-server": false } }]),
  );
});
test("clipboard failure leaves a selectable command and a clear inline error", async ({ page }) => {
  const dialog = await open(page, true);
  await dialog.getByRole("button", { name: "Copy command", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Could not copy. Select and copy the command above.");
  await expect(dialog.locator("[data-mcp-command] code")).toHaveText("tessera mcp");
});
