import { expect, type Page } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { openTerminal } from "./terminal-helpers";
export async function prepare(page: Page, agent: boolean) {
  await mockTauri(page);
  await openTerminal(page, "demo&renderer=dom");
  await expect(page.getByRole("treeitem", { name: /^Dark mode,/ })).toBeVisible();
  if (agent) {
    await page.keyboard.press("Control+Alt+Shift+N");
    const dialog = page.getByRole("dialog", { name: "New task", exact: true });
    await dialog.locator('[data-agent-chip="claude"]').click();
    await dialog.getByRole("textbox", { name: "Task name" }).fill("Comment task");
    await dialog.getByRole("button", { name: "Create task" }).click();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await window.__tesseraAgents?.agentSessionsList(null))?.some((s) => s.task_id && s.pane_session_id),
        ),
      )
      .toBe(true);
  } else await page.getByRole("treeitem", { name: /^Dark mode,/ }).click();
  const id = await page.evaluate(
    (name) => {
      const task = Object.values(window.__tesseraStore?.getState().projects.tasks ?? {}).find((t) => t.name === name);
      if (!task) throw Error("No task");
      const file = { path: "example.ts", old_path: null, status: "M", added: 3, removed: 3, is_binary: false };
      window.__tesseraReview?.set(task.id, [file], {
        "example.ts": {
          base_text: "const one = 1;\nconst two = 2;\nconst three = 3;\n",
          head_text: "const one = 10;\nconst two = 20;\nconst three = 30;\n",
          too_large: false,
          binary: false,
          conflict: false,
        },
      });
      return task.id;
    },
    agent ? "Comment task" : "Dark mode",
  );
  await page.keyboard.press("Control+Alt+Shift+F7");
  await expect(page.locator(".cm-mergeView")).toBeVisible();
  return id;
}
