import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { fakeLog } from "./terminal-helpers";
import { prepare } from "./review-helpers";
const SHOTS = process.env.TESSERA_SHOTS_DIR ?? join(tmpdir(), "tessera-shots", "39");
async function add(page: Page, side: "a" | "b", body: string, range = false) {
  const gutter = page.locator(`.cm-merge-${side} .cm-lineNumbers`);
  await gutter.locator(".cm-gutterElement").filter({ hasText: /^1$/ }).click();
  if (range)
    await gutter
      .locator(".cm-gutterElement")
      .filter({ hasText: /^3$/ })
      .click({ modifiers: ["Shift"] });
  await page.getByRole("textbox", { name: "Comment", exact: true }).fill(body);
  await page.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(page.locator("[data-review-comment]")).toBeVisible();
}
test("line ranges support add edit resolve delete send and sent markers", async ({ page }) => {
  const id = await prepare(page, true);
  await add(page, "b", "Explain these values", true);
  expect(await page.evaluate(async (id) => (await window.__tesseraComments?.list(id))?.[0], id)).toMatchObject({
    side: "head",
    line_start: 1,
    line_end: 3,
    code_excerpt: "const one = 10;\nconst two = 20;\nconst three = 30;",
  });
  await page.getByRole("button", { name: "Edit comment", exact: true }).click();
  await page.getByRole("textbox", { name: "Comment", exact: true }).fill("Please fix these values");
  await page.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(page.locator("[data-review-comment]")).toContainText("Please fix these values");
  await page.getByRole("button", { name: "Resolve comment", exact: true }).click();
  await expect(page.locator("[data-review-comment]")).toContainText("Resolved");
  await expect(page.getByRole("button", { name: "Send 0 comments to agent", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Reopen comment", exact: true }).click();
  await page.getByRole("button", { name: "Delete comment", exact: true }).click();
  await expect(page.locator("[data-review-comment]")).toHaveCount(0);
  await add(page, "b", "Please fix these values", true);
  await page.getByRole("button", { name: "Send 1 comments to agent", exact: true }).click();
  await expect(page.locator("[data-review-comment]")).toContainText("Sent");
  const log = await fakeLog(page);
  const text = log.writes.map((w) => new TextDecoder().decode(new Uint8Array(w.bytes))).join("");
  expect(text).toContain("\x1b[200~Review comments on your changes:");
  expect(text).toContain("example.ts:1-3 (head)");
  expect(text).toContain("> const one = 10;");
  expect(text).toContain("Please fix these values\x1b[201~\r");
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const [width, height] of [
      [1280, 800],
      [900, 600],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: join(SHOTS, `comments-${theme}-${width}.png`) });
    }
  }
});
test("base-side comments stay unsent when no agent is running", async ({ page }) => {
  const id = await prepare(page, false);
  await add(page, "a", "Check the original");
  await page.getByRole("button", { name: "Send 1 comments to agent", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("No agent is running for this task.");
  expect((await page.evaluate(async (id) => window.__tesseraComments?.list(id), id))?.[0]?.sent_at).toBeNull();
});
