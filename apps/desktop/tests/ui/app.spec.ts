import { expect, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";

test.beforeEach(async ({ page }) => {
  await mockTauri(page);
});

test("app loads with the Tauri IPC mocked", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");

  await expect(page).toHaveTitle(/Tessera$/);
  await expect(page.locator("#root")).not.toBeEmpty();
  expect(await page.evaluate(() => "__TAURI_INTERNALS__" in window)).toBe(true);
  expect(errors).toEqual([]);
});
