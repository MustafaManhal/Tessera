import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { openTerminal } from "./terminal-helpers";
const SHOTS = process.env.TESSERA_SHOTS_DIR ?? join(tmpdir(), "tessera-shots", "36");
async function prepare(page: Page, empty = false) {
  await mockTauri(page);
  await openTerminal(page, "demo&renderer=dom");
  await page.getByRole("treeitem", { name: /^Dark mode,/ }).click();
  const taskId = await page.evaluate(() => {
    const task = Object.values(window.__tesseraStore?.getState().projects.tasks ?? {}).find(
      (t) => t.name === "Dark mode",
    );
    if (!task) throw Error("No task");
    return task.id;
  });
  await page.evaluate(
    ({ taskId, empty }) => {
      const client = window.__tesseraReview;
      if (!client) throw Error("No review client");
      const files = empty
        ? []
        : [
            { path: "src/example.ts", status: "M", added: 1, removed: 1, is_binary: false, old_path: null },
            { path: "image.bin", status: "A", added: 0, removed: 0, is_binary: true, old_path: null },
            { path: "large.txt", status: "M", added: 1, removed: 1, is_binary: false, old_path: null },
            { path: "conflict.ts", status: "U", added: 1, removed: 1, is_binary: false, old_path: null },
          ];
      const normal = {
        base_text: "export const value = 1;\n",
        head_text: "export const value = 2;\n",
        too_large: false,
        binary: false,
        conflict: false,
      };
      client.set(taskId, files, {
        "src/example.ts": normal,
        "image.bin": { ...normal, base_text: null, head_text: null, binary: true },
        "large.txt": { ...normal, base_text: null, head_text: null, too_large: true },
        "conflict.ts": { ...normal, conflict: true },
      });
    },
    { taskId, empty },
  );
  await page.keyboard.press("Control+Alt+Shift+F7");
  await expect(page.getByRole("complementary", { name: "Review changes" })).toBeVisible();
  return taskId;
}
test("review renders CodeMirror, toggles, special states and keyboard selection", async ({ page }) => {
  await prepare(page);
  const panel = page.locator("[data-review-panel]");
  await expect(panel.locator(".cm-mergeView")).toBeVisible();
  await expect(panel.locator(".cm-content").first()).toHaveAttribute("contenteditable", "false");
  await expect
    .poll(() =>
      panel
        .locator(".cm-content")
        .first()
        .evaluate((node) =>
          Array.from(node.querySelectorAll("span")).some(
            (span) => getComputedStyle(span).color !== getComputedStyle(node).color,
          ),
        ),
    )
    .toBe(true);
  await expect(panel).toContainText("src/example.ts");
  await panel.getByRole("button", { name: "Split", exact: true }).click();
  await expect(panel.locator("[data-review-diff]")).toHaveAttribute("data-mode", "unified");
  await expect(panel.locator(".cm-content")).toBeVisible();
  await panel.getByRole("button", { name: "Ignore whitespace", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Ignore whitespace", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await panel.getByRole("button", { name: "Tree", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Flat", exact: true })).toBeVisible();
  const options = panel.getByRole("option");
  await options.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel.getByText("Binary file", { exact: true })).toBeVisible();
  await panel.getByRole("option", { name: /large.txt/ }).click();
  await expect(panel.getByText("This file is too large to display")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Open in editor", exact: true })).toBeVisible();
  await panel.getByRole("option", { name: /conflict.ts/ }).click();
  await expect(panel.getByText("Merge conflict", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Resolve in editor", exact: true })).toBeVisible();
  await panel.getByRole("option", { name: /src\/example.ts/ }).click();
  await expect(panel.locator("[data-review-diff] .cm-content")).toBeVisible();
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const [width, height] of [
      [1280, 800],
      [900, 600],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: join(SHOTS, `review-${theme}-${width}.png`) });
    }
  }
});
test("review empty state and local update pill defer refresh while hovering", async ({ page }) => {
  const id = await prepare(page, true);
  const panel = page.locator("[data-review-panel]");
  await expect(panel.getByText("The agent has not changed files yet")).toBeVisible();
  await page.evaluate((id) => {
    window.__tesseraReview?.set(
      id,
      [{ path: "a.ts", status: "A", old_path: null, added: 1, removed: 0, is_binary: false }],
      { "a.ts": { base_text: "", head_text: "first\n", too_large: false, binary: false, conflict: false } },
    );
    window.__tesseraReview?.notify(id);
  }, id);
  await expect(panel.locator(".cm-content").last()).toContainText("first");
  await panel.locator("[data-review-diff]").hover();
  const before = await page.evaluate(
    () => window.__tesseraReview?.calls.filter((c) => c.method === "files").length ?? 0,
  );
  await page.evaluate((id) => window.__tesseraReview?.notify(id), id);
  await expect(panel.getByRole("button", { name: "Changes updated", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__tesseraReview?.calls.filter((c) => c.method === "files").length ?? 0)).toBe(
    before,
  );
  await panel.getByRole("button", { name: "Changes updated", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__tesseraReview?.calls.filter((c) => c.method === "files").length ?? 0))
    .toBeGreaterThan(before);
  await panel.locator("[data-review-diff]").hover();
  await page.evaluate((id) => window.__tesseraReview?.notify(id), id);
  await expect(panel.getByRole("button", { name: "Changes updated", exact: true })).toBeVisible();
  await page.mouse.move(1, 1);
  await expect(panel.getByRole("button", { name: "Changes updated", exact: true })).toHaveCount(0);
});

test("remote review polls at ten seconds and defers refresh while hovering", async ({ page }) => {
  await page.clock.install();
  const id = await prepare(page);
  const panel = page.locator("[data-review-panel]");
  await expect(panel.locator(".cm-content").first()).toBeVisible();
  await page.evaluate((id) => {
    const store = window.__tesseraStore;
    const task = store?.getState().projects.tasks[id];
    if (!store || !task) throw Error("No task");
    store.dispatch({ type: "projects/taskUpserted", payload: { ...task, worktree_path: "ssh://fixture/repo" } });
  }, id);
  await panel.locator("[data-review-diff]").hover();
  const before = await page.evaluate(
    () => window.__tesseraReview?.calls.filter((c) => c.method === "files").length ?? 0,
  );
  await page.clock.fastForward(10_001);
  await expect
    .poll(() => page.evaluate(() => window.__tesseraReview?.calls.filter((c) => c.method === "files").length ?? 0))
    .toBeGreaterThan(before);
  await expect(panel.getByRole("button", { name: "Changes updated", exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    const client = window.__tesseraReview;
    if (!client) throw Error("No client");
    client.diff = async () => ({
      base_text: "export const value = 1;\n",
      head_text: "export const value = 3;\n",
      too_large: false,
      binary: false,
      conflict: false,
    });
  });
  await page.clock.fastForward(10_001);
  await expect(panel.getByRole("button", { name: "Changes updated", exact: true })).toBeVisible();
  await page.mouse.move(1, 1);
  await expect(panel.getByRole("button", { name: "Changes updated", exact: true })).toHaveCount(0);
  await expect(panel.locator(".cm-content").last()).toContainText("3");
});
