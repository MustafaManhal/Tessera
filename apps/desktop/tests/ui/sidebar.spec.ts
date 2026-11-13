import { expect, type Page, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { openTerminal } from "./terminal-helpers";

// The sidebar (S-02) over the fake projects client (`?demo`): groups, task rows, opening task tabs, keyboard, rename,
// archive and restore, delete with the unmerged-commits confirmation, filter, drag reorder.
// "Desktop Chrome" reports Windows, so chords are the Windows ones.

const errors: string[] = [];

test.beforeEach(async ({ page, context }) => {
  errors.length = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockTauri(page);
});

test.afterEach(() => {
  expect(errors, "console errors").toEqual([]);
});

const tree = (page: Page) => page.getByRole("tree", { name: "Projects and tasks" });
const task = (page: Page, name: string) => tree(page).getByRole("treeitem", { name: new RegExp(`^${name},`) });
const project = (page: Page, name: string) =>
  tree(page).getByRole("treeitem", { name: new RegExp(`^${name}`), level: 1 });
const tabs = (page: Page) => page.getByRole("tab");

async function openDemo(page: Page) {
  await openTerminal(page, "demo&renderer=dom");
  await expect(tree(page)).toBeVisible();
  await expect(task(page, "Fix checkout rounding")).toBeVisible();
}

test("shows projects with their tasks, branch chips, counts and the muted state", async ({ page }) => {
  await openDemo(page);
  await expect(tree(page).locator('[role="treeitem"][aria-level="1"]')).toHaveCount(3);
  await expect(project(page, "dotfiles")).toHaveAttribute("aria-label", "dotfiles, muted");
  const fix = task(page, "Fix checkout rounding");
  await expect(fix).toContainText("tessera/fix-checkout-rounding");
  await expect(fix).toHaveAccessibleName(/2 commits ahead of main.*3 changed files.*Ports 4000/);
  await expect(task(page, "Main checkout")).toContainText("Main checkout");
  await expect(task(page, "Add order export")).toHaveAccessibleName(/1 commits ahead.*4 commits behind/);
  // Archived tasks are collapsed until opened.
  await expect(task(page, "Old spike")).toHaveCount(0);
  const archived = tree(page).getByRole("treeitem", { name: "Archived (1)" });
  await expect(archived).toHaveAttribute("aria-expanded", "false");
  await archived.click();
  await expect(task(page, "Old spike")).toBeVisible();
});

test("a click opens the task's tab in its worktree; a second click focuses the same tab", async ({ page }) => {
  await openDemo(page);
  await task(page, "Add order export").click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(tabs(page).nth(1)).toContainText("Add order export");
  await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-segment="cwd"]')).toHaveText("/Users/you/code/shop-api-worktrees/add-order-export");
  await expect(task(page, "Add order export")).toHaveAttribute("aria-current", "true");
  await tabs(page).first().click();
  await expect(task(page, "Add order export")).not.toHaveAttribute("aria-current", "true");
  await task(page, "Add order export").click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
  // The main-checkout task works in the project folder.
  await task(page, "Main checkout").click();
  await expect(page.locator('[data-segment="cwd"]')).toHaveText("/Users/you/code/shop-api");
  // A split of a task tab stays in the task.
  await page.keyboard.press("Control+Shift+D");
  await expect(page.locator('[data-segment="cwd"]')).toHaveText("/Users/you/code/shop-api");
});

test("keyboard: arrows, Enter, Left/Right, Home/End, F2 rename, filter with /", async ({ page }) => {
  await openDemo(page);
  await project(page, "shop-api").focus();
  await page.keyboard.press("ArrowDown");
  await expect(task(page, "Main checkout")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(tabs(page).nth(1)).toContainText("Add order export");
  // Opening a task moves the focus into its terminal; come back to the row for F2.
  await task(page, "Add order export").focus();
  await page.keyboard.press("F2");
  const input = tree(page).getByRole("textbox", { name: "Task name" });
  await input.fill("Export orders");
  await page.keyboard.press("Enter");
  await expect(task(page, "Export orders")).toBeFocused();
  await expect(tabs(page).nth(1)).toContainText("Export orders");
  // Escape cancels a rename.
  await page.keyboard.press("F2");
  await tree(page).getByRole("textbox", { name: "Task name" }).fill("nope");
  await page.keyboard.press("Escape");
  await expect(task(page, "Export orders")).toBeVisible();
  // Left collapses the group, Right opens it, Left on a task goes to its group.
  await page.keyboard.press("ArrowLeft");
  await expect(project(page, "shop-api")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(project(page, "shop-api")).toHaveAttribute("aria-expanded", "false");
  await expect(task(page, "Export orders")).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(project(page, "shop-api")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("End");
  await expect(project(page, "dotfiles")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(project(page, "shop-api")).toBeFocused();
  await page.keyboard.press("/");
  await expect(page.getByRole("searchbox", { name: "Filter tasks and projects" })).toBeFocused();
});

test("the filter narrows tasks by name, branch and project; Escape clears it", async ({ page }) => {
  await openDemo(page);
  await page.locator("[data-sidebar-filter-button]").click();
  const filter = page.getByRole("searchbox", { name: "Filter tasks and projects" });
  await filter.fill("dark");
  await expect(project(page, "web")).toBeVisible();
  await expect(project(page, "shop-api")).toHaveCount(0);
  await filter.fill("tessera/add-order");
  await expect(task(page, "Add order export")).toBeVisible();
  await expect(task(page, "Fix checkout rounding")).toHaveCount(0);
  await filter.fill("spike");
  await expect(task(page, "Old spike")).toBeVisible();
  await filter.fill("zzzz");
  await expect(page.getByText('Nothing matches "zzzz".')).toBeVisible();
  await filter.press("Escape");
  await expect(filter).toHaveValue("");
  await expect(project(page, "shop-api")).toBeVisible();
  await expect(page.locator("[data-filter-dot]")).toHaveCount(0);
  await page.keyboard.press("Control+Shift+F");
  await expect(filter).toBeFocused();
});

test("archive from the context menu with Undo, then restore from the Archived section", async ({ page }) => {
  await openDemo(page);
  await task(page, "Add order export").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Archive task" }).click();
  await expect(task(page, "Add order export")).toHaveCount(0);
  await expect(page.getByTestId("announcer")).toContainText("Add order export archived");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(task(page, "Add order export")).toBeVisible();

  await task(page, "Add order export").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Archive task" }).click();
  const archived = tree(page).getByRole("treeitem", { name: "Archived (2)" });
  await archived.click();
  await task(page, "Add order export").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Restore task" }).click();
  await expect(tree(page).getByRole("treeitem", { name: "Archived (1)" })).toBeVisible();
  await expect(task(page, "Add order export")).toBeVisible();
});

test("delete asks once; with unmerged commits it lists them and asks again", async ({ page }) => {
  await openDemo(page);
  await task(page, "Add order export").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete task" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete Add order export?" });
  await expect(dialog).toContainText("removes its worktree and its branch");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Delete task" }).click();
  await expect(task(page, "Add order export")).toHaveCount(0);

  await task(page, "Fix checkout rounding").focus();
  await page.keyboard.press("Delete");
  const first = page.getByRole("alertdialog", { name: "Delete Fix checkout rounding?" });
  await first.getByRole("button", { name: "Delete task" }).click();
  const second = page.getByRole("alertdialog", { name: "Fix checkout rounding has commits that are not merged" });
  await expect(second).toContainText("These 2 commits exist only on this branch");
  await expect(second).toContainText("Round to cents");
  await expect(second).toContainText("Add test");
  await second.getByRole("button", { name: "Cancel" }).click();
  await expect(task(page, "Fix checkout rounding")).toBeVisible();

  await task(page, "Fix checkout rounding").focus();
  await page.keyboard.press("Delete");
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete task" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete and lose 2 commits" }).click();
  await expect(task(page, "Fix checkout rounding")).toHaveCount(0);
});

test("deleting a task closes its tab", async ({ page }) => {
  await openDemo(page);
  await task(page, "Dark mode").click();
  await expect(tabs(page)).toHaveCount(2);
  await task(page, "Dark mode").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete task" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete task" }).click();
  await expect(tabs(page)).toHaveCount(1);
});

test("copy branch name and the ⋯ menu", async ({ page }) => {
  await openDemo(page);
  await task(page, "Dark mode").hover();
  await task(page, "Dark mode").getByRole("button", { name: "More actions for Dark mode" }).click();
  await page.getByRole("menuitem", { name: "Copy branch name" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("tessera/dark-mode");
});

test("drag a project to reorder; Alt+Shift+Down does it from the keyboard", async ({ page }) => {
  await openDemo(page);
  const names = () =>
    tree(page)
      .locator('[role="treeitem"][aria-level="1"]')
      .evaluateAll((items) => items.map((item) => item.getAttribute("data-project")));
  const before = await names();
  await project(page, "dotfiles").dragTo(project(page, "shop-api"));
  expect(await names()).toEqual([before[2], before[0], before[1]]);
  await project(page, "dotfiles").focus();
  await page.keyboard.press("Alt+Shift+ArrowDown");
  expect(await names()).toEqual([before[0], before[2], before[1]]);
  await expect(page.getByTestId("announcer")).toContainText("dotfiles moved to position 2 of 3");
});

test("task actions are in the palette with reasons when unavailable", async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press("Control+K");
  await page.keyboard.type("archive task");
  const option = page.getByRole("option", { name: /Archive task/ });
  await expect(option).toBeVisible();
  await expect(option).toContainText("This tab is not a task");
  await page.keyboard.press("Escape");
  await task(page, "Dark mode").click();
  await page.keyboard.press("Control+Alt+Shift+X");
  await expect(task(page, "Dark mode")).toHaveCount(0);
  // The open task is archived now, so "next" starts from the top of the sidebar.
  await page.keyboard.press("Control+Alt+PageDown");
  await expect(tabs(page).nth(2)).toContainText("Main checkout");
  await expect(tabs(page).nth(2)).toHaveAttribute("aria-selected", "true");
});

test("run scripts: the task menu runs a script in a named pane, once, and Open in editor is offered", async ({
  page,
}) => {
  await openDemo(page);
  const projectId = await page.evaluate(() => {
    const state = (window as unknown as { __tesseraStore: { getState(): any } }).__tesseraStore.getState();
    const task = Object.values(state.projects.tasks).find((t: any) => t.name === "Fix checkout rounding") as any;
    return task.project_id as string;
  });
  await page.evaluate((id) => {
    (window as unknown as { __tesseraStore: { dispatch(a: unknown): void } }).__tesseraStore.dispatch({
      type: "projects/scriptsSet",
      payload: {
        projectId: id,
        scripts: [
          { id: "s1", project_id: id, name: "dev server", command: "echo script-ran-ok", auto_start: false, sort: 0 },
        ],
      },
    });
  }, projectId);

  await task(page, "Fix checkout rounding").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Open in editor" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Run dev server" }).click();

  // A second pane in the task's tab, named after the script, with the command typed into its shell.
  await expect(page.getByRole("region", { name: /dev server/ })).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".xterm-rows")
        .allTextContents()
        .then((t) => t.join(" ")),
    )
    .toContain("script-ran-ok");

  // Running it again focuses the same pane instead of opening a second one.
  await task(page, "Fix checkout rounding").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Run dev server" }).click();
  await expect(page.getByRole("region", { name: /dev server/ })).toHaveCount(1);
});

test("the filter icon filters by activity: open or running, not active, archived", async ({ page }) => {
  await openDemo(page);
  await page.locator("[data-sidebar-filter-button]").click();
  const panel = page.locator("[data-sidebar-filter-panel]");
  await panel.locator('[data-status-filter="archived"]').click();
  await expect(page.locator("[data-filter-dot]")).toBeVisible();
  await expect(task(page, "Old spike")).toBeVisible();
  await expect(task(page, "Add order export")).toHaveCount(0);
  await panel.locator('[data-status-filter="inactive"]').click();
  await expect(task(page, "Add order export")).toBeVisible();
  await expect(task(page, "Old spike")).toHaveCount(0);
  await panel.locator('[data-status-filter="active"]').click();
  await expect(task(page, "Add order export")).toHaveCount(0);
  await page.locator("[data-filter-summary]").getByRole("button", { name: "Clear" }).click();
  await expect(page.locator("[data-filter-dot]")).toHaveCount(0);
  await expect(task(page, "Add order export")).toBeVisible();
});

test("active projects and tasks come first, and tasks can be moved with the keyboard; My order keeps the order", async ({
  page,
}) => {
  await openDemo(page);
  // Open a task so it is "in use", then it leads its project.
  await task(page, "Fix checkout rounding").click();
  const names = async () =>
    page.locator("[data-task]").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")?.split(",")[0]));
  expect((await names())[0]).toBe("Fix checkout rounding");
  // Alt+Shift+Down moves the focused task one place down in the user's order.
  await task(page, "Fix checkout rounding").focus();
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await page.locator("[data-sidebar-filter-button]").click();
  await page.locator('[data-sort-mode="manual"]').click();
  const manual = await names();
  expect(manual.indexOf("Fix checkout rounding")).toBeGreaterThan(0);
});
