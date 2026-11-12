import { expect, test, type Page } from "@playwright/test";

import { mockTauri } from "./tauri-mock";
import { openTerminal } from "./terminal-helpers";
import { prepare } from "./review-helpers";

const SHOTS = process.env.TESSERA_SHOTS_DIR ?? ".ai/agent-lead/briefs/shots/43";

async function shot(page: Page, name: string) {
  const dir = SHOTS.startsWith("/") ? SHOTS : `${process.cwd()}/../../${SHOTS}`;
  await page.screenshot({ path: `${dir}/${name}`, fullPage: false });
}

async function openPrPanel(page: Page) {
  await page.getByRole("button", { name: "Create pull request" }).click();
  await expect(page.locator("[data-pr-panel]")).toBeVisible();
}

test("create a pull request, see checks, merge and get the archive prompt", async ({ page }) => {
  await mockTauri(page);
  const taskId = await prepare(page, false);
  await page.evaluate((id) => {
    const pulls = (window as never as { __tesseraPulls: { checks: Map<string, unknown[]> } }).__tesseraPulls;
    pulls.checks.set(id, [
      { name: "build", status: "completed", conclusion: "success", duration_ms: 95_000, url: "https://ci/1" },
      { name: "test", status: "completed", conclusion: "failure", duration_ms: 42_000, url: "https://ci/2" },
    ]);
  }, taskId);
  await openPrPanel(page);
  // Create form is prefilled with the task name.
  await expect(page.locator("[data-pr-panel] input").first()).toHaveValue("Dark mode");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator("[data-pr-panel]")).toContainText("#42");
  await expect(page.locator("[data-checks-list] li")).toHaveCount(2);
  await shot(page, "pr-checks.png");
  // Merge is blocked while a check fails.
  await expect(page.getByRole("button", { name: "Merge pull request" })).toBeDisabled();
  // Send failure to agent needs an agent; without one the button is hidden.
  await expect(page.getByRole("button", { name: "Send failure to agent" })).toHaveCount(0);
  // Flip the failing check to success and merge locally.
  await page.evaluate((id) => {
    const pulls = (window as never as { __tesseraPulls: { checks: Map<string, unknown[]> } }).__tesseraPulls;
    pulls.checks.set(id, [
      { name: "build", status: "completed", conclusion: "success", duration_ms: 95_000, url: "https://ci/1" },
      { name: "test", status: "completed", conclusion: "success", duration_ms: 42_000, url: "https://ci/2" },
    ]);
  }, taskId);
  await page.getByRole("button", { name: "Merge locally" }).click();
  await expect(page.getByRole("dialog")).toContainText("Archive this task?");
  await shot(page, "pr-archive.png");
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("merge conflicts are listed instead of archiving", async ({ page }) => {
  await mockTauri(page);
  const taskId = await prepare(page, false);
  await page.evaluate((id) => {
    const pulls = (
      window as never as {
        __tesseraPulls: { mergeConflicts: Map<string, string[]>; seed: (id: string, pr: object) => void };
      }
    ).__tesseraPulls;
    pulls.seed(id, { number: 7, state: "open", ci_state: "success" });
    pulls.mergeConflicts.set(id, ["src/a.ts", "src/b.ts"]);
    const task = Object.values(
      (
        window as never as {
          __tesseraStore: {
            getState: () => {
              projects: { tasks: Record<string, Record<string, unknown> & { name?: string; id: string }> };
            };
          };
        }
      ).__tesseraStore.getState().projects.tasks,
    ).find((t) => t.id === id);
    if (task) {
      (
        window as never as { __tesseraStore: { dispatch: (a: { type: string; payload: unknown }) => void } }
      ).__tesseraStore.dispatch({
        type: "projects/taskUpserted",
        payload: {
          ...task,
          pr_number: 7,
          pr_state: "open",
          ci_state: "success",
          pr_url: "https://github.com/o/r/pull/7",
        },
      });
    }
  }, taskId);
  await openPrPanel(page);
  await page.getByRole("button", { name: "Merge locally" }).click();
  await expect(page.locator("[data-merge-conflicts]")).toContainText("src/a.ts");
  await expect(page.locator("[data-merge-conflicts]")).toContainText("src/b.ts");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("push failure surfaces git's error", async ({ page }) => {
  await mockTauri(page);
  const taskId = await prepare(page, false);
  await page.evaluate((id) => {
    (window as never as { __tesseraPulls: { failCreate: Set<string> } }).__tesseraPulls.failCreate.add(id);
  }, taskId);
  await openPrPanel(page);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator("[data-pr-panel] [role=alert]")).toContainText("git push failed");
});

test("PR and CI chips show on the sidebar row", async ({ page }) => {
  await mockTauri(page);
  await openTerminal(page, "demo&renderer=dom");
  await expect(page.getByRole("treeitem", { name: /^Dark mode,/ })).toBeVisible();
  await page.evaluate(() => {
    const store = (
      window as never as {
        __tesseraStore: {
          getState: () => { projects: { tasks: Record<string, Record<string, unknown> & { name?: string }> } };
          dispatch: (a: { type: string; payload: unknown }) => void;
        };
      }
    ).__tesseraStore;
    const task = Object.values(store.getState().projects.tasks).find((t) => t.name === "Dark mode");
    if (!task) return;
    store.dispatch({
      type: "projects/taskUpserted",
      payload: {
        ...task,
        pr_number: 9,
        pr_state: "open",
        ci_state: "failing",
        pr_url: "https://github.com/o/r/pull/9",
      },
    });
  });
  const row = page.locator("[data-task]").filter({ hasText: "Dark mode" });
  await expect(row.locator("[data-pr-chips]")).toContainText("#9");
  await expect(row.locator('[data-ci-chip="failing"]')).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  for (const [width, height] of [
    [1280, 800],
    [900, 600],
  ] as const) {
    test(`screenshot ${scheme} ${width}×${height}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      await mockTauri(page);
      const taskId = await prepare(page, false);
      await page.evaluate((id) => {
        const pulls = (
          window as never as {
            __tesseraPulls: { checks: Map<string, unknown[]>; seed: (id: string, pr: object) => void };
          }
        ).__tesseraPulls;
        pulls.seed(id, { number: 42, state: "open", ci_state: "pending", title: "Dark mode" });
        pulls.checks.set(id, [
          { name: "build", status: "completed", conclusion: "success", duration_ms: 95_000, url: null },
          { name: "test", status: "in_progress", conclusion: null, duration_ms: null, url: null },
        ]);
      }, taskId);
      await openPrPanel(page);
      await shot(page, `pr-panel-${scheme}-${width}x${height}.png`);
    });
  }
}
