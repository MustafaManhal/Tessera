import { expect, type Page, test } from "@playwright/test";
import { fakeLog, openTerminal } from "./terminal-helpers";

// The title bar's agent menu types the picked agent's command into the open task's terminal.

const tree = (page: Page) => page.getByRole("tree", { name: "Projects and tasks" });
const task = (page: Page, name: string) => tree(page).getByRole("treeitem", { name: new RegExp(`^${name},`) });

/** Everything typed into the fake shell, as text. */
async function typed(page: Page): Promise<string> {
  const log = await fakeLog(page);
  return log.writes.map((write) => String.fromCharCode(...write.bytes)).join("");
}

test("picking an installed agent starts it in the task's terminal", async ({ page }) => {
  await openTerminal(page, "demo&renderer=dom");
  await task(page, "Dark mode").click();
  const tabs = await page.evaluate(() => window.__tesseraStore?.getState().layout.tabs.length ?? 0);
  await page.locator("[data-agent-starter]").click();
  const menu = page.locator("[data-agent-starter-menu]");
  await expect(menu).toBeVisible();
  const claude = menu.locator("[data-agent-starter-item='claude']");
  await expect(claude).toBeVisible();
  await expect(menu.locator("[data-agent-starter-item]")).not.toHaveCount(0);
  await claude.click();
  await expect.poll(() => typed(page)).toMatch(/(^|\r)claude( [^\r]*)?\r/);
  // The task's own terminal took it: no new tab.
  expect(await page.evaluate(() => window.__tesseraStore?.getState().layout.tabs.length ?? 0)).toBe(tabs);
});

test("a terminal that is running something gets a new terminal for the agent", async ({ page }) => {
  await openTerminal(page, "demo&renderer=dom");
  await task(page, "Dark mode").click();
  const before = await page.evaluate(() => window.__tesseraStore?.getState().layout.tabs.length ?? 0);
  // Mark the focused pane busy, as shell integration does while a command runs.
  await page.evaluate(() => {
    const store = window.__tesseraStore;
    if (!store) throw new Error("no store");
    const layout = store.getState().layout;
    const tab = layout.tabs.find((candidate: { id: string }) => candidate.id === layout.activeTab);
    if (!tab) throw new Error("no tab");
    store.dispatch({
      type: "layout/apply",
      payload: { type: "pane/setProcess", paneId: tab.focusedPane, process: "vim" },
    } as never);
  });
  await page.locator("[data-agent-starter]").click();
  await page.locator("[data-agent-starter-menu] [data-agent-starter-item='claude']").click();
  await expect
    .poll(() => page.evaluate(() => window.__tesseraStore?.getState().layout.tabs.length ?? 0))
    .toBe(before + 1);
  await expect.poll(() => typed(page)).toMatch(/(^|\r)claude( [^\r]*)?\r/);
});
