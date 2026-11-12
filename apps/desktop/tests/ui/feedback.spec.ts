import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openTerminal } from "./terminal-helpers";

// The feedback form: kinds, validation, screenshots, sending, and the GitHub fallback, with the in-memory client.
const SHOTS = process.env.TESSERA_SHOTS_DIR ?? join(tmpdir(), "tessera-shots", "feedback");
// A real 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function openForm(page: Page) {
  await openTerminal(page, "demo&renderer=dom");
  await page.keyboard.press("Control+K");
  await page.keyboard.type("send feedback");
  await page.keyboard.press("Enter");
  // Located by its marker: the dialog's name changes to "Thank you" after sending.
  const dialog = page.locator("[data-feedback-dialog]");
  await expect(dialog).toBeVisible();
  return dialog;
}

test("Send stays off until there is a summary and details; kinds change the hint and the technical-details default", async ({
  page,
}) => {
  const dialog = await openForm(page);
  const send = dialog.locator("[data-feedback-send]");
  await expect(send).toBeDisabled();
  await dialog.getByLabel("Short summary", { exact: true }).fill("Button hard to read");
  await expect(send).toBeDisabled();
  await dialog.getByLabel("Details", { exact: true }).fill("The broadcast buttons are dark on red.");
  await expect(send).toBeEnabled();

  const reportSwitch = dialog.getByRole("switch", { name: "Include technical details" });
  await expect(reportSwitch).toHaveAttribute("aria-checked", "true");
  await dialog.locator('[data-feedback-kind="idea"]').click();
  await expect(reportSwitch).toHaveAttribute("aria-checked", "false");
  await expect(dialog).toContainText("What would you like Tessera to do");
  await dialog.locator('[data-feedback-kind="bug"]').click();
  await expect(reportSwitch).toHaveAttribute("aria-checked", "true");

  await dialog.locator("[data-feedback-preview]").click();
  await expect(dialog.locator("[data-feedback-report]")).toContainText("Tessera error report");
  await page.screenshot({ path: join(SHOTS, "form.png") });
});

test("screenshots are attached, limited to three, removable, and sent shrunk", async ({ page }) => {
  const dialog = await openForm(page);
  const input = dialog.locator("[data-feedback-file]");
  await input.setInputFiles([{ name: "one.png", mimeType: "image/png", buffer: PNG }]);
  await expect(dialog.locator("[data-feedback-shot]")).toHaveCount(1);
  await input.setInputFiles([
    { name: "two.png", mimeType: "image/png", buffer: PNG },
    { name: "three.png", mimeType: "image/png", buffer: PNG },
    { name: "four.png", mimeType: "image/png", buffer: PNG },
  ]);
  await expect(dialog.locator("[data-feedback-shot]")).toHaveCount(3);
  await expect(dialog.locator("[data-feedback-shot-error]")).toContainText("up to 3");
  await dialog.getByRole("button", { name: "Remove two.jpg" }).click();
  await expect(dialog.locator("[data-feedback-shot]")).toHaveCount(2);
  await input.setInputFiles([{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") }]);
  await expect(dialog.locator("[data-feedback-shot-error]")).toContainText("not an image");

  await dialog.getByLabel("Short summary", { exact: true }).fill("Looks odd");
  await dialog.getByLabel("Details", { exact: true }).fill("Here is a screenshot of it.");
  await dialog.locator("[data-feedback-send]").click();
  await expect(dialog.locator("[data-feedback-sent]")).toBeVisible();
  const sent = await page.evaluate(() => window.__tesseraFeedback?.sent[0]);
  expect(sent?.attachments).toHaveLength(2);
  expect(sent?.attachments[0]?.mime).toBe("image/jpeg");
  expect(sent?.attachments[0]?.data_base64.length).toBeGreaterThan(50);
  expect(sent?.kind).toBe("bug");
  expect(sent?.include_report).toBe(true);
});

test("a sent report shows its reference and closes", async ({ page }) => {
  const dialog = await openForm(page);
  await dialog.getByLabel("Short summary", { exact: true }).fill("Add dark mode toggle");
  await dialog.getByLabel("Details", { exact: true }).fill("A quick switch in the status bar please.");
  await dialog.getByLabel(/How can we reach you/).fill("me@example.com");
  await dialog.locator('[data-feedback-kind="idea"]').click();
  await dialog.locator("[data-feedback-send]").click();
  await expect(dialog.locator("[data-feedback-id]")).toHaveText(/^F-\d{8}$/);
  await page.screenshot({ path: join(SHOTS, "thanks.png") });
  const sent = await page.evaluate(() => window.__tesseraFeedback?.sent[0]);
  expect(sent).toMatchObject({ kind: "idea", contact: "me@example.com", include_report: false });
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
});

test("when sending fails the text is kept and the report can go to GitHub instead", async ({ page }) => {
  const dialog = await openForm(page);
  await page.evaluate(() => {
    if (window.__tesseraFeedback) window.__tesseraFeedback.failWith = "feedback.network";
  });
  await dialog.getByLabel("Short summary", { exact: true }).fill("Crash on start");
  await dialog.getByLabel("Details", { exact: true }).fill("It closes right after opening.");
  await dialog.locator("[data-feedback-send]").click();
  const error = dialog.locator('[data-feedback-error="feedback.network"]');
  await expect(error).toContainText("Could not reach");
  await expect(dialog.getByLabel("Short summary", { exact: true })).toHaveValue("Crash on start");
  await dialog.locator("[data-feedback-github]").click();
  const opened = await page.evaluate(
    () => (window as unknown as { __tesseraOpened?: { kind: string; url: string }[] }).__tesseraOpened ?? [],
  );
  expect(opened.at(-1)?.url).toContain("https://github.com/MustafaManhal/Tessera/issues/new?");
  expect(opened.at(-1)?.url).toContain("title=Crash+on+start");
  // Try again works once the connection is back.
  await dialog.locator("[data-feedback-send]").click();
  await expect(dialog.locator("[data-feedback-sent]")).toBeVisible();
});

test("the form opens from the status bar and its shortcut, and Esc closes it", async ({ page }) => {
  await openTerminal(page, "demo&renderer=dom");
  await page.getByRole("button", { name: "Send feedback…" }).click();
  const dialog = page.locator("[data-feedback-dialog]");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press("Control+Alt+Shift+/");
  await expect(dialog).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  test(`screenshot ${theme} 900x600`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 900, height: 600 });
    const dialog = await openForm(page);
    await dialog.locator("[data-feedback-file]").setInputFiles([{ name: "a.png", mimeType: "image/png", buffer: PNG }]);
    await expect(dialog.locator("[data-feedback-shot]")).toHaveCount(1);
    await page.screenshot({ path: join(SHOTS, `form-${theme}-900.png`) });
  });
}
