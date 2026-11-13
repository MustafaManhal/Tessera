import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { flattenSchema, type JsonSchema } from "../../src/settings/schema";
import { mockTauri } from "./tauri-mock";
import { fakeLog, openTerminal, run, screen } from "./terminal-helpers";

// Session restore through the fake LayoutStore (localStorage): change layout, reload, same tabs and splits come back;
// corrupt JSON gives a fresh tab and a toast. The divider line shows on restored panes.

const errors: string[] = [];
const tabs = (page: Page) => page.getByRole("tab");
const panel = (page: Page) => page.locator('[role="tabpanel"]:not([hidden])');
const panes = (page: Page) => panel(page).locator("section[data-pane-id]:not([hidden])");
const schema = JSON.parse(
  readFileSync(new URL("../../../../packages/ipc/schema/config.schema.json", import.meta.url), "utf8"),
) as JsonSchema;

test.beforeEach(async ({ page }, testInfo) => {
  errors.length = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await mockTauri(page);
  await page.addInitScript((corrupt) => {
    const initialized = "tessera.restore-test-initialized";
    if (sessionStorage.getItem(initialized) === "true") return;
    try {
      localStorage.removeItem("tessera.layouts");
      localStorage.removeItem("tessera.restoreSession");
      if (corrupt) localStorage.setItem("tessera.layouts", "{not-valid-json");
    } catch {
      // Private mode.
    }
    sessionStorage.setItem(initialized, "true");
  }, testInfo.title.includes("corrupt saved layout"));
});

test.afterEach(() => {
  expect(errors, "console errors").toEqual([]);
});

async function mockSettings(page: Page) {
  const config: Record<string, Record<string, unknown>> = {};
  for (const field of flattenSchema(schema)) {
    config[field.section] = { ...config[field.section], [field.name]: field.default };
  }
  await page.exposeFunction(
    "__tesseraIpc",
    async (cmd: string, args: { patch?: Record<string, Record<string, unknown>> }) => {
      if (cmd === "settings_get") return { ok: config };
      if (cmd === "settings_set") {
        for (const [section, values] of Object.entries(args.patch ?? {})) {
          config[section] = { ...config[section], ...values };
        }
        return { ok: config };
      }
      if (cmd === "app_info") {
        return {
          ok: { name: "Tessera", version: "0.1.0", data_dir: "/x", log_dir: "/x", dev_build: true, schema_version: 1 },
        };
      }
      return undefined;
    },
  );
}

async function waitForAutosave(page: Page, expectedTabs: number) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const saved = JSON.parse(localStorage.getItem("tessera.layouts") ?? "[]") as {
          state?: { tabs?: unknown[] };
        }[];
        return saved[0]?.state?.tabs?.length ?? 0;
      }),
    )
    .toBe(expectedTabs);
}

test("changing tabs and splits, then reloading, restores the same layout", async ({ page }) => {
  await openTerminal(page, "renderer=dom");
  await run(page, "cd /tmp");
  await page.keyboard.press("Control+Shift+T");
  await page.keyboard.press("Control+Shift+D");
  await expect(tabs(page)).toHaveCount(2);
  await expect(panes(page)).toHaveCount(2);
  await waitForAutosave(page, 2);

  await openTerminal(page, "renderer=dom");
  await expect(tabs(page)).toHaveCount(2);
  await expect(panes(page)).toHaveCount(2);
  await expect(page.getByRole("region", { name: /Notifications/ }).getByText(/Restored 2 tabs/)).toBeVisible();
  await expect.poll(async () => (await fakeLog(page)).spawns.some((spawn) => spawn.cwd === "/tmp")).toBe(true);
  await expect.poll(() => screen(page)).toContain("restored session");
});

test("Undo on the restore toast starts fresh and saves that", async ({ page }) => {
  await openTerminal(page, "renderer=dom");
  await page.keyboard.press("Control+Shift+T");
  await page.keyboard.press("Control+Shift+T");
  await expect(tabs(page)).toHaveCount(3);
  await waitForAutosave(page, 3);

  await openTerminal(page, "renderer=dom");
  await expect(tabs(page)).toHaveCount(3);
  const toast = page.getByRole("region", { name: /Notifications/ }).getByText(/Restored 3 tabs/);
  await expect(toast).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(tabs(page)).toHaveCount(1);
  await waitForAutosave(page, 1);

  await openTerminal(page, "renderer=dom");
  await expect(tabs(page)).toHaveCount(1);
  await expect(page.getByRole("region", { name: /Notifications/ }).getByText(/Restored 1 tab/)).toBeVisible();
});

test("corrupt saved layout gives a fresh tab and an error toast", async ({ page }) => {
  await openTerminal(page, "renderer=dom");
  await expect(tabs(page)).toHaveCount(1);
  await expect(
    page.getByRole("region", { name: /Notifications/ }).getByText(/Couldn't restore your last session/),
  ).toBeVisible();
});

test("window.restore off starts fresh even when a layout is saved", async ({ page }) => {
  await mockSettings(page);
  await openTerminal(page, "renderer=dom");
  await page.keyboard.press("Control+Shift+T");
  await expect(tabs(page)).toHaveCount(2);
  await waitForAutosave(page, 2);
  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("switch", { name: "Restore tabs and splits when Tessera starts" }).click();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);

  await openTerminal(page, "renderer=dom");
  await expect(tabs(page)).toHaveCount(1);
  await expect(page.getByText(/Restored/)).toHaveCount(0);
});
