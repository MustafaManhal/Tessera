import { expect, type Page, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { openTerminal } from "./terminal-helpers";

// The project and task dialogs over the fake projects client: add project (folder, drop, init offer, clone), project
// settings (validation, run scripts, approval), new task (live slug, errors, main checkout, setup approval pane).

const errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await mockTauri(page);
});

test.afterEach(() => {
  expect(errors, "console errors").toEqual([]);
});

const tree = (page: Page) => page.getByRole("tree", { name: "Projects and tasks" });
const project = (page: Page, name: string) =>
  tree(page).getByRole("treeitem", { name: new RegExp(`^${name}`), level: 1 });
const task = (page: Page, name: string) => tree(page).getByRole("treeitem", { name: new RegExp(`^${name},`) });

test("add a project from the empty state with the keyboard only", async ({ page }) => {
  await openTerminal(page, "renderer=dom");
  await expect(page.getByText("No projects yet. Add a git folder to start working in tasks.")).toBeVisible();
  await page.keyboard.press("Control+Shift+O");
  const dialog = page.getByRole("dialog", { name: "Add project" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Folder path" })).toBeFocused();
  await page.keyboard.type("/code/shop");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(project(page, "shop")).toBeVisible();
  await expect(page.getByTestId("announcer")).toContainText("shop added");
  // The new project shows its empty state and offers a task.
  await expect(tree(page).getByText("No tasks yet")).toBeVisible();
});

test("add project errors: duplicate, empty, Browse fills the path, relative path", async ({ page }) => {
  await openTerminal(page, "demo&renderer=dom");
  await page.evaluate(() => {
    const picker = window.__tesseraFolderPicker;
    if (picker) picker.next = "/tmp/browsed-project";
  });
  await page.getByRole("button", { name: "Add project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add project" });
  await dialog.getByRole("button", { name: "Add project" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("This field is required.");
  await dialog.getByRole("button", { name: "Browse" }).click();
  await expect(dialog.getByRole("textbox", { name: "Folder path" })).toHaveValue("/tmp/browsed-project");
  await page.evaluate(() => {
    if (window.__tesseraFolderPicker) {
      window.__tesseraFolderPicker.next = "C:\\Users\\runneradmin\\code\\browsed-project";
    }
  });
  await dialog.getByRole("button", { name: "Browse" }).click();
  await expect(dialog.getByRole("textbox", { name: "Folder path" })).toHaveValue(
    "C:\\Users\\runneradmin\\code\\browsed-project",
  );
  await dialog.getByRole("textbox", { name: "Folder path" }).fill("/Users/you/code/web");
  await dialog.getByRole("button", { name: "Add project" }).click();
  await expect(dialog.getByRole("alert")).toContainText("web is already added.");
  await dialog.getByRole("textbox", { name: "Folder path" }).fill("relative/dir");
  await dialog.getByRole("button", { name: "Add project" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Not a folder");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("a folder that is not a repo offers git init; a dropped folder fills the path; recent folders return", async ({
  page,
}) => {
  await openTerminal(page, "demo&renderer=dom");
  await page.getByRole("button", { name: "Add project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add project" });
  const box = await dialog.locator("[data-drop-folder]").boundingBox();
  if (!box) throw new Error("no drop zone");
  await page.evaluate(
    ([x, y]) => window.__tesseraDrop?.(["/tmp/not-a-repo-yet"], x ?? 0, y ?? 0),
    [box.x + 20, box.y + 20],
  );
  await expect(dialog.getByRole("textbox", { name: "Folder path" })).toHaveValue("/tmp/not-a-repo-yet");
  await dialog.getByRole("button", { name: "Add project" }).click();
  const offer = dialog.locator("[data-init-offer]");
  await expect(offer).toContainText("This folder is not a git repository. Initialise it?");
  await offer.getByRole("button", { name: "Initialise and add" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(project(page, "not-a-repo-yet")).toBeVisible();

  await page.getByRole("button", { name: "Add project" }).first().click();
  await expect(page.getByRole("button", { name: "/tmp/not-a-repo-yet" })).toBeVisible();
  await page.getByRole("textbox", { name: "Folder path" }).fill("/tmp/not-a-repo-no-init");
  await page.getByRole("dialog").getByRole("button", { name: "Add project" }).click();
  await expect(page.locator("[data-init-offer]")).toContainText("Tessera can't initialise it");
  await expect(page.getByRole("button", { name: "Initialise and add" })).toHaveCount(0);
});

test("clone shows progress and can be cancelled; a failing URL shows the error", async ({ page }) => {
  await openTerminal(page, "demo&renderer=dom");
  await page.getByRole("button", { name: "Add project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add project" });
  await dialog.getByRole("tab", { name: "Clone" }).click();
  await dialog.getByRole("textbox", { name: "Repository URL" }).fill("https://example.com/team/fail.git");
  await dialog.getByRole("button", { name: "Clone and add" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Could not read from");
  await dialog.getByRole("textbox", { name: "Repository URL" }).fill("https://example.com/team/slow.git");
  await dialog.getByRole("button", { name: "Clone and add" }).click();
  await expect(dialog.locator("[data-clone-progress]")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel clone" }).click();
  await expect(dialog.getByRole("button", { name: "Clone and add" })).toBeEnabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Clone and add" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 5000 });
  await expect(project(page, "slow")).toBeVisible();
});

test("a repository on an SSH host: pick the host, a folder that is not a repo is refused, then added", async ({
  page,
}) => {
  await openTerminal(page, "demo&renderer=dom");
  await page.getByRole("button", { name: "Add project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add project" });
  await dialog.getByRole("tab", { name: "Clone" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("tab", { name: "SSH host" })).toHaveAttribute("aria-selected", "true");
  const panel = dialog.locator("[data-add-remote]");
  await expect(panel.getByRole("combobox", { name: "Host" })).toContainText("build");
  await dialog.getByRole("button", { name: "Add project" }).click();
  await expect(panel).toContainText("This field is required");
  const folder = panel.getByRole("textbox", { name: "Repository folder on the host" });
  await folder.fill("~/code/not-a-repo");
  await dialog.getByRole("button", { name: "Add project" }).click();
  await expect(dialog.getByRole("alert")).toContainText("not a Git repository");
  await folder.fill("~/code/remote-api");
  await dialog.getByRole("button", { name: "Add project" }).click();
  await expect(dialog).toHaveCount(0);
  const row = project(page, "remote-api");
  await expect(row.locator("[data-remote-project]")).toHaveText("build");
  expect(
    await page.evaluate(() =>
      Object.values(window.__tesseraStore?.getState().projects.projects ?? {}).map((p) => p.path),
    ),
  ).toContain("ssh://build/home/you/code/remote-api");
});

test("project settings: validation negatives, save, run scripts, approval", async ({ page }) => {
  await openTerminal(page, "demo&renderer=dom");
  await project(page, "shop-api").hover();
  await project(page, "shop-api").getByRole("button", { name: "More actions for shop-api" }).click();
  await page.getByRole("menuitem", { name: "Project settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Project settings" });
  await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("shop-api");
  await expect(dialog.getByRole("textbox", { name: "Folder", exact: true })).toHaveAttribute("readonly", "");
  await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(dialog.getByRole("textbox", { name: "File path 1" })).toHaveValue(".env");
  await expect(dialog.getByText("Approved", { exact: true })).toBeVisible();
  await expect(dialog.locator('[data-run-script="dev"]')).toContainText("pnpm dev");

  // Negatives: empty name, bad copy paths, bad port, relative worktree folder.
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("");
  await dialog.getByRole("textbox", { name: "File path 1" }).fill("../secret");
  await dialog.getByRole("button", { name: "Add file" }).click();
  await dialog.getByRole("textbox", { name: "File path 3" }).fill("/etc/passwd");
  await dialog.getByRole("textbox", { name: "Port base" }).fill("80");
  await dialog.getByRole("textbox", { name: "Worktree folder" }).fill("relative");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByText("Enter a name.")).toBeVisible();
  await expect(dialog.locator('[data-copy-row="0"]')).toContainText('A path cannot contain "..".');
  await expect(dialog.locator('[data-copy-row="2"]')).toContainText("Use a path inside the repository");
  await expect(dialog.getByText("Enter a whole number from 1024 to 65000.")).toBeVisible();
  await expect(dialog.getByText("Use an absolute path, or leave it empty.", { exact: true }).first()).toBeVisible();
  await expect(dialog.locator("[data-form-error]")).toHaveText("Fix the highlighted fields first.");

  // Fix them and save.
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Shop API");
  await dialog.getByRole("textbox", { name: "File path 1" }).fill(".env.local");
  await dialog.getByRole("button", { name: "Remove /etc/passwd" }).click();
  await dialog.getByRole("textbox", { name: "Port base" }).fill("5000");
  await dialog.getByRole("textbox", { name: "Worktree folder" }).fill("/tmp/trees");
  await dialog.getByRole("textbox", { name: "Setup script" }).fill("make setup");
  await expect(dialog.getByText("Save your changes first, then approve.")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(project(page, "Shop API")).toBeVisible();
  const saved = await page.evaluate(async () => (await window.__tesseraProjects?.projectList())?.[0]);
  expect(saved).toMatchObject({
    name: "Shop API",
    port_base: 5000,
    worktree_dir: "/tmp/trees",
    setup_script: "make setup",
    setup_state: "needs_approval",
    copy_files: [
      { path: ".env.local", mode: "copy" },
      { path: "node_modules", mode: "symlink" },
    ],
  });

  // The changed script needs approval again; approving needs it saved first.
  await project(page, "Shop API").hover();
  await project(page, "Shop API").getByRole("button", { name: "More actions for Shop API" }).click();
  await page.getByRole("menuitem", { name: "Project settings" }).click();
  await expect(dialog.getByText("Needs approval", { exact: true })).toBeVisible();
  await dialog.getByRole("textbox", { name: "Setup script" }).fill("make setup2");
  await expect(dialog.getByText("Save your changes first, then approve.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Approve script" })).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Setup script" }).fill("make setup");
  await dialog.getByRole("button", { name: "Approve script" }).click();
  await expect(dialog.getByText("Approved", { exact: true })).toBeVisible();

  // Run scripts save as you go.
  await dialog.getByRole("textbox", { name: "Run script command" }).fill("pnpm test");
  await dialog.getByRole("button", { name: "Add script" }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "needs a name and a command" })).toBeVisible();
  await dialog.getByRole("textbox", { name: "Run script name" }).fill("test");
  await dialog.getByRole("button", { name: "Add script" }).click();
  await expect(dialog.locator('[data-run-script="test"]')).toContainText("pnpm test");
  await dialog.getByRole("switch", { name: "Start with the task: test" }).click();
  await expect
    .poll(async () =>
      page.evaluate(
        async () =>
          (await window.__tesseraProjects?.runScriptList("prj_1"))?.find((s) => s.name === "test")?.auto_start,
      ),
    )
    .toBe(true);
  await dialog.getByRole("button", { name: "Remove test" }).click();
  await expect(dialog.locator('[data-run-script="test"]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("new task: live slug and branch, create opens the task tab, errors stay inline", async ({ page }) => {
  await openTerminal(page, "demo&renderer=dom");
  await task(page, "Dark mode").click();
  await page.keyboard.press("Control+Alt+Shift+N");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog).toBeVisible();
  // The project defaults to the current task's project.
  await expect(dialog.getByRole("combobox", { name: "Project" })).toContainText("web");
  await expect(dialog.getByRole("textbox", { name: "Task name" })).toBeFocused();
  const preview = dialog.locator("[data-branch-preview]");
  await expect(preview).toHaveText("The branch is named after the task.");
  await page.keyboard.type("Add 2FA login!");
  await expect(preview).toHaveText("Branch tessera/add-2fa-login");
  await dialog.getByRole("textbox", { name: "Task name" }).fill("");
  await dialog.getByRole("textbox", { name: "Prompt" }).fill("Fix the flaky payment test in checkout today");
  await expect(preview).toHaveText("Branch tessera/fix-the-flaky-payment-test-in");
  // Installed agents offer real chips; nothing is chosen yet, so no agent starts.
  await expect(dialog.locator('[data-agent-chip="claude"]')).toBeEnabled();
  await expect(dialog.locator('[data-agent-chip="claude"]')).toHaveAttribute("aria-pressed", "false");

  // A branch that exists, and a worktree that cannot be made.
  await dialog.getByRole("textbox", { name: "Task name" }).fill("branch exists");
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog.getByRole("alert")).toContainText("A branch named tessera/branch-exists already exists.");
  await dialog.getByRole("textbox", { name: "Task name" }).fill("fail-worktree");
  await page.keyboard.press("Control+Enter");
  await expect(dialog.locator("[data-form-error]")).toContainText("Git could not create the worktree");
  await dialog.getByRole("textbox", { name: "Task name" }).fill("x".repeat(81));
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Use 80 characters or fewer.");
  await dialog.getByRole("combobox", { name: "Base branch" }).fill("");
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "Enter a base branch." })).toBeVisible();

  await dialog.getByRole("textbox", { name: "Task name" }).fill("Add 2FA login");
  await dialog.getByRole("combobox", { name: "Base branch" }).fill("main");
  await page.keyboard.press("Control+Enter");
  await expect(dialog).toHaveCount(0);
  await expect(task(page, "Add 2FA login")).toBeVisible();
  await expect(page.getByRole("tab", { name: /Add 2FA login/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-segment="cwd"]')).toHaveText("/Users/you/code/web-worktrees/add-2fa-login");
});

test("new task on the main checkout shows the warning and skips the setup script", async ({ page }) => {
  await openTerminal(page, "demo&renderer=dom");
  await expect(task(page, "Dark mode")).toBeVisible();
  await page.keyboard.press("Control+Alt+Shift+N");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog.getByRole("switch", { name: "Run the setup script" })).toBeChecked();
  await dialog.getByRole("switch", { name: "Use the main checkout" }).click();
  await expect(dialog.getByRole("note")).toContainText("No separate worktree");
  await expect(dialog.getByRole("switch", { name: "Run the setup script" })).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Task name" }).fill("Direct work");
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(task(page, "Direct work")).toContainText("Main checkout");
  await expect(page.locator('[data-segment="cwd"]')).toHaveText("/Users/you/code/shop-api");
});

test("a setup script that needs approval shows the approval pane; Approve and run runs it; a failure leaves the tab usable", async ({
  page,
}) => {
  await openTerminal(page, "demo&renderer=dom");
  await expect(task(page, "Dark mode")).toBeVisible();
  await page.evaluate(() =>
    window.__tesseraProjects?.projectUpdate("prj_1", { setup_script: "exit-now", setup_shell: "zsh" }),
  );
  await page.keyboard.press("Control+Alt+Shift+N");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByRole("textbox", { name: "Task name" }).fill("Needs setup");
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toHaveCount(0);
  const approval = page.locator("[data-setup-approval]");
  await expect(approval).toBeVisible();
  await expect(approval).toContainText("Setup script needs your approval");
  await expect(approval).toContainText("exit-now");
  await expect(approval).toContainText("Shell: zsh");
  await expect(approval).toContainText(/Hash [0-9a-f]{12}/);
  // The shell pane above it keeps the focus; a task tab with a setup pane has two panes.
  await expect(page.locator('[role="tabpanel"]:not([hidden]) section[data-pane-id]')).toHaveCount(2);
  await approval.getByRole("button", { name: "Approve and run" }).click();
  await expect(page.locator('[data-setup-status="running"], [data-setup-status="failed"]')).toBeVisible();
  await expect(page.locator('[data-setup-status="failed"]')).toContainText(
    "Setup failed with exit code 127. The tab still works.",
    { timeout: 10_000 },
  );
  const approved = await page.evaluate(async () => (await window.__tesseraProjects?.projectList())?.[0]?.setup_state);
  expect(approved).toBe("approved");
  // The tab is usable: its shell pane still takes input.
  await page.getByRole("tab", { name: /Needs setup/ }).click();
  await expect(page.locator('[data-segment="cwd"]')).toHaveText(/needs-setup/);
});

test("Skip leaves the terminal alone", async ({ page }) => {
  await openTerminal(page, "demo&renderer=dom");
  await expect(task(page, "Dark mode")).toBeVisible();
  await page.evaluate(() =>
    window.__tesseraProjects?.projectUpdate("prj_1", { setup_script: "make", setup_shell: "bash" }),
  );
  await page.keyboard.press("Control+Alt+Shift+N");
  await page.getByRole("dialog").getByRole("textbox", { name: "Task name" }).fill("Skipper");
  await page.getByRole("dialog").getByRole("button", { name: "Create task" }).click();
  await page.locator("[data-setup-approval]").getByRole("button", { name: "Skip" }).click();
  await expect(page.locator('[data-setup-status="skipped"]')).toContainText("Setup skipped.");
  expect(await page.evaluate(async () => (await window.__tesseraProjects?.projectList())?.[0]?.setup_state)).toBe(
    "needs_approval",
  );
});

test("removing a project asks first and keeps worktrees on disk", async ({ page }) => {
  await openTerminal(page, "demo&renderer=dom");
  await project(page, "shop-api").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove project" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Remove shop-api?" });
  await expect(dialog).toContainText("Folders and worktrees on disk stay where they are.");
  await expect(dialog).toContainText("3 tasks still have worktrees on disk.");
  await dialog.getByRole("button", { name: "Remove project" }).click();
  await expect(project(page, "shop-api")).toHaveCount(0);
  await expect(project(page, "web")).toBeVisible();
});

test("mute dims a project; the sidebar shows it", async ({ page }) => {
  await openTerminal(page, "demo&renderer=dom");
  await project(page, "web").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mute project" }).click();
  await expect(project(page, "web")).toHaveAttribute("aria-label", "web, muted");
  await project(page, "web").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Unmute project" })).toBeVisible();
});
