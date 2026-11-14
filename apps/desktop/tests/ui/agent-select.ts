// The New task dialog's agent drop-down: opens the menu (it renders in a portal, outside the dialog), ticks one agent
// and closes it again with Escape (which closes only the menu).
import { expect, type Locator, type Page } from "@playwright/test";

export async function pickAgent(page: Page, dialog: Locator, agentId: string): Promise<void> {
  await dialog.locator("[data-agent-picker]").click();
  const option = page.locator(`[data-agent-option="${agentId}"]`);
  await expect(option).toBeVisible();
  await option.click();
  await page.keyboard.press("Escape");
  await expect(option).toHaveCount(0);
}
