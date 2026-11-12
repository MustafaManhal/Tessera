import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { prepare } from "./review-helpers";
import { fakeLog } from "./terminal-helpers";
const SHOTS = process.env.TESSERA_SHOTS_DIR ?? join(tmpdir(), "tessera-shots", "39");
test("file and hunk actions, discard confirmation, hook diagnostics and commit", async ({ page }) => {
  const id = await prepare(page, true);
  await page.evaluate((id) => {
    window.__tesseraStaging?.set(
      id,
      [{ path: "example.ts", old_path: null, staged: false, unstaged: true, untracked: false, conflict: false }],
      {
        "example.ts": [0, 1].map((index) => ({
          index,
          header: `@@ -${index + 1} +${index + 1} @@`,
          patch: `diff --git a/example.ts b/example.ts\n@@ -${index + 1} +${index + 1} @@\n-old\n+new\n`,
        })),
      },
    );
  }, id);
  // Refresh through the visible panel so both clients reload their state.
  await page.getByRole("button", { name: "Refresh changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stage file", exact: true })).toBeEnabled();
  await page.getByText("Hunks and commit", { exact: true }).click();
  await expect(page.locator("[data-review-hunk]")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Commit staged changes", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Stage hunk", exact: true }).first().click();
  await expect(page.locator("[data-review-hunk]")).toHaveCount(1);
  await page.getByRole("button", { name: "Staged hunks", exact: true }).click();
  await page.getByRole("button", { name: "Unstage hunk", exact: true }).click();
  await expect(page.locator("[data-review-hunk]")).toHaveCount(0);
  await page.getByRole("button", { name: "Unstaged hunks", exact: true }).click();
  await expect(page.locator("[data-review-hunk]")).toHaveCount(2);
  await page.getByRole("button", { name: "Discard hunk", exact: true }).first().click();
  const dialog = page.getByRole("alertdialog", { name: "Discard unstaged changes?" });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await page.evaluate(() => window.__tesseraStaging?.calls.some((c) => c.method === "discard"))).toBe(false);
  await page.getByRole("button", { name: "Discard hunk", exact: true }).first().click();
  await dialog.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page.locator("[data-review-hunk]")).toHaveCount(1);
  await page.getByRole("button", { name: "Stage file", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unstage file", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Unstage file", exact: true }).click();
  await page.getByRole("button", { name: "Discard file", exact: true }).click();
  await dialog.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stage file", exact: true })).toBeDisabled();
  // Re-seed a new change for the commit and hook error states.
  await page.evaluate(
    (id) =>
      window.__tesseraStaging?.set(
        id,
        [{ path: "example.ts", old_path: null, staged: true, unstaged: false, untracked: false, conflict: false }],
        {},
      ),
    id,
  );
  await page.getByRole("button", { name: "Refresh changes", exact: true }).click();
  await page.getByRole("button", { name: "Ask the agent to write the message", exact: true }).click();
  const log = await fakeLog(page);
  expect(log.writes.map((w) => new TextDecoder().decode(new Uint8Array(w.bytes))).join("")).toContain(
    "\x1b[200~Write a concise commit message for the staged changes.",
  );
  await page.getByRole("textbox", { name: "Commit message", exact: true }).fill("Improve example values");
  await page.evaluate(() => {
    if (window.__tesseraStaging) window.__tesseraStaging.hookFailure = "pre-commit refused\nfixture lint failed";
  });
  await page.getByRole("button", { name: "Commit staged changes", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("fixture lint failed");
  await expect(page.getByRole("textbox", { name: "Commit message", exact: true })).toHaveValue(
    "Improve example values",
  );
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const [width, height] of [
      [1280, 800],
      [900, 600],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: join(SHOTS, `staging-${theme}-${width}.png`) });
    }
  }
  await page.evaluate(() => {
    if (window.__tesseraStaging) window.__tesseraStaging.hookFailure = null;
  });
  await page.getByRole("button", { name: "Commit staged changes", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /Committed / })).toBeVisible();
  await expect(page.getByRole("button", { name: "Commit staged changes", exact: true })).toBeDisabled();
  const calls = await page.evaluate(() => window.__tesseraStaging?.calls);
  expect(calls).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ method: "stage", hunk: 0 }),
      expect.objectContaining({ method: "unstage", hunk: 0 }),
      expect.objectContaining({ method: "discard", hunk: 0 }),
      expect.objectContaining({ method: "commit", message: "Improve example values" }),
    ]),
  );
});
test("asking for a commit message without an agent shows a clear error", async ({ page }) => {
  await prepare(page, false);
  await page.getByText("Hunks and commit", { exact: true }).click();
  await page.getByRole("button", { name: "Ask the agent to write the message", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("No agent is running for this task.");
});
