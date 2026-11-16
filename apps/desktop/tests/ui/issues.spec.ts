import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { openTerminal } from "./terminal-helpers";

// Issues to tasks (M9.1): the issue picker in New task (button and `#`), GitHub and Linear lists, error hints, the
// issue chip and the Fix issue prompt, and the Linear key in Settings, against the in-memory fakes.
const SHOTS = process.env.TESSERA_SHOTS_DIR ?? join(tmpdir(), "tessera-shots", "47");
const tree = (page: Page) => page.getByRole("tree", { name: "Projects and tasks" });

test.beforeEach(async ({ page }) => {
  await mockTauri(page);
});

async function newTask(page: Page): Promise<Locator> {
  await openTerminal(page, "demo&renderer=dom");
  await expect(tree(page).getByRole("treeitem", { name: /^Dark mode,/ })).toBeVisible();
  await page.keyboard.press("Control+Alt+Shift+N");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("picking a GitHub issue fills the name and the Fix issue prompt and remembers the issue", async ({ page }) => {
  const dialog = await newTask(page);
  await dialog.locator("[data-issue-pick]").click();
  const picker = dialog.locator("[data-issue-picker]");
  await expect(picker.locator('[data-issue-option="#12"]')).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "picker.png") });
  await picker.locator('[data-issue-option="#12"]').click();
  await expect(picker).toHaveCount(0);
  await expect(dialog.locator('[data-issue-chip="#12"]')).toContainText("Login page crashes on empty password");
  const prompt = dialog.getByRole("textbox", { name: "Prompt" });
  await expect(prompt).toHaveValue(/^Fix issue #12: Login page crashes on empty password\n\nSteps:/);
  await expect(prompt).toHaveValue(/Labels: bug, auth/);
  await expect(prompt).toHaveValue(/Issue: https:\/\/github\.com\/acme\/shop\/issues\/12$/);
  // The branch carries the number.
  await expect(dialog.locator("[data-branch-preview]")).toContainText("12-login-page-crashes");
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(tree(page).getByRole("treeitem", { name: /^#12 Login page crashes/ })).toBeVisible();
  const saved = await page.evaluate(() => [...(window.__tesseraIssues?.setIssue.values() ?? [])]);
  expect(saved).toHaveLength(1);
  expect(saved[0]?.key).toBe("#12");
});

test("typing # in the prompt opens the picker, search narrows, arrows and Enter pick", async ({ page }) => {
  const dialog = await newTask(page);
  const prompt = dialog.getByRole("textbox", { name: "Prompt" });
  await prompt.fill("Please look at ");
  await prompt.pressSequentially("#");
  const picker = dialog.locator("[data-issue-picker]");
  await expect(picker).toBeVisible();
  const search = picker.getByRole("combobox", { name: "Search issues" });
  await expect(search).toBeFocused();
  await search.fill("csv");
  await expect(picker.locator("[data-issue-option]")).toHaveCount(1);
  await expect(picker.locator('[data-issue-option="#18"]')).toBeVisible();
  await search.fill("");
  await expect(picker.locator("[data-issue-option]")).toHaveCount(2);
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(picker).toHaveCount(0);
  // Enter picked the issue and did not create the task.
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-issue-chip="#18"]')).toBeVisible();
  // The typed "#" is gone and the text written before it stays.
  await expect(prompt).toHaveValue(/^Please look at\n\nFix issue #18: Export orders as CSV/);
  await dialog.getByRole("button", { name: "Remove the issue" }).click();
  await expect(dialog.locator("[data-issue-chip]")).toHaveCount(0);
});

test("Linear issues need a key and the picker says where to add it", async ({ page }) => {
  const dialog = await newTask(page);
  await dialog.locator("[data-issue-pick]").click();
  const picker = dialog.locator("[data-issue-picker]");
  await picker.locator('[data-issue-provider="linear"]').click();
  await expect(picker.locator('[data-issue-error="linear.not_connected"]')).toContainText("Add an API key");
  await page.evaluate(async () => {
    await window.__tesseraIssues?.linearConnect("lin_api_valid");
  });
  await picker.locator('[data-issue-provider="github"]').click();
  await picker.locator('[data-issue-provider="linear"]').click();
  await expect(picker.locator('[data-issue-option="ENG-42"]')).toBeVisible();
  await picker.locator('[data-issue-option="ENG-42"]').click();
  await expect(dialog.getByRole("textbox", { name: "Prompt" })).toHaveValue(/^Fix issue ENG-42: Rounding error/);
  await expect(dialog.locator("[data-branch-preview]")).toContainText("eng-42-rounding-error");
});

test("GitHub not connected and a non-GitHub project show plain explanations", async ({ page }) => {
  const dialog = await newTask(page);
  await page.evaluate(() => {
    if (window.__tesseraIssues) window.__tesseraIssues.githubConnected = false;
  });
  await dialog.locator("[data-issue-pick]").click();
  const picker = dialog.locator("[data-issue-picker]");
  await expect(picker.locator('[data-issue-error="github.not_connected"]')).toContainText("Connect it in Settings");
  await page.evaluate(() => {
    if (window.__tesseraIssues) {
      window.__tesseraIssues.githubConnected = true;
      window.__tesseraIssues.noGithubRemote = true;
    }
  });
  await picker.getByRole("combobox", { name: "Search issues" }).fill("x");
  await expect(picker.locator('[data-issue-error="issues.no_github_remote"]')).toContainText("not a GitHub repository");
});

test("Esc closes the picker without closing the dialog", async ({ page }) => {
  const dialog = await newTask(page);
  await dialog.locator("[data-issue-pick]").click();
  await expect(dialog.locator("[data-issue-picker]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog.locator("[data-issue-picker]")).toHaveCount(0);
  await expect(dialog).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  test(`picker screenshot ${theme} 900x600`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 900, height: 600 });
    const dialog = await newTask(page);
    await dialog.locator("[data-issue-pick]").click();
    await expect(dialog.locator('[data-issue-option="#12"]')).toBeVisible();
    await page.screenshot({ path: join(SHOTS, `picker-${theme}-900.png`) });
  });
}
