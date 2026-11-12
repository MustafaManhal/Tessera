import { expect, type Page, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { flattenSchema, getValue, type JsonSchema } from "../../src/settings/schema";
import { mockTauri } from "./tauri-mock";
import { openTerminal } from "./terminal-helpers";

// The settings screen against mocked IPC: `settings_get` canned, `settings_set` recorded and answered like Rust
// (range errors as AppError), `config:changed` and `config:error` fired by hand.

const schema = JSON.parse(
  readFileSync(new URL("../../../../packages/ipc/schema/config.schema.json", import.meta.url), "utf8"),
) as JsonSchema;
const fields = flattenSchema(schema);
const errors: string[] = [];

function defaults() {
  const config: Record<string, Record<string, unknown>> = {};
  for (const field of fields) {
    config[field.section] = { ...config[field.section], [field.name]: field.default };
  }
  return config;
}

/** A tiny stand-in for the Rust settings commands. */
async function mockSettings(page: Page) {
  const server = { config: defaults(), sets: [] as unknown[] };
  await page.exposeFunction(
    "__tesseraIpc",
    async (cmd: string, args: { patch?: Record<string, Record<string, unknown>> }) => {
      if (cmd === "settings_get") return { ok: server.config };
      if (cmd === "app_info")
        return {
          ok: {
            name: "Tessera",
            version: "0.1.0",
            data_dir: "/home/you/Tessera Dev",
            log_dir: "/x",
            dev_build: true,
            schema_version: 1,
          },
        };
      if (cmd === "settings_set") {
        server.sets.push(args.patch);
        for (const [section, values] of Object.entries(args.patch ?? {})) {
          for (const [name, value] of Object.entries(values)) {
            const field = fields.find((candidate) => candidate.key === `${section}.${name}`);
            if (field?.max !== undefined && typeof value === "number" && value > field.max)
              return { err: { code: "config.invalid", message: `${section}.${name}: must be at most ${field.max}` } };
            server.config[section] = { ...server.config[section], [name]: value };
          }
        }
        return { ok: server.config };
      }
      return undefined;
    },
  );
  return server;
}

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

const emit = (page: Page, event: string, payload: unknown) =>
  page.evaluate(
    ([name, value]) =>
      (window as unknown as { __tesseraEmit: (e: string, p: unknown) => void }).__tesseraEmit(name as string, value),
    [event, payload],
  );

async function openSettings(page: Page) {
  await openTerminal(page);
  await page.keyboard.press("Control+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("opens with Ctrl+, from the palette, lists sections and stubs", async ({ page }) => {
  await mockSettings(page);
  const dialog = await openSettings(page);
  await expect(dialog.getByRole("searchbox", { name: "Search settings" })).toBeFocused();
  for (const name of [
    "General",
    "Appearance",
    "Font",
    "Terminal",
    "Keybindings",
    "Agents",
    "Integrations",
    "Updates",
    "Advanced",
  ])
    await expect(dialog.getByRole("button", { name, exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Agents" }).click();
  await expect(dialog.locator("[data-agents-page]")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Rescan" })).toBeVisible();
  await dialog.getByRole("button", { name: "Keybindings", exact: true }).click();
  await expect(dialog.locator('[data-action="view.palette"]')).toBeVisible();
  await expect(dialog.getByRole("searchbox", { name: "Search shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.keyboard.press("Control+K");
  await page.keyboard.type("open settings");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
});

test("editing the font size saves after 250 ms, shows Saved and the terminal follows", async ({ page }) => {
  const server = await mockSettings(page);
  const dialog = await openSettings(page);
  await dialog.getByRole("button", { name: "Font" }).click();
  const size = dialog.getByRole("textbox", { name: "Font size" });
  await size.fill("17");
  await expect(dialog.locator('[data-setting="font.size"]').getByText("Saved")).toBeVisible();
  expect(server.sets).toEqual([{ font: { size: 17 } }]);
  expect(await page.evaluate(() => window.__tesseraStore?.getState().settings.terminal.fontSize)).toBe(17);
  // A burst of typing is one save.
  await size.fill("");
  await size.pressSequentially("20");
  await expect.poll(() => server.sets.length).toBe(2);
  expect(server.sets[1]).toEqual({ font: { size: 20 } });
});

test("a switch and a select save at once; reset goes back to the default", async ({ page }) => {
  const server = await mockSettings(page);
  const dialog = await openSettings(page);
  await dialog.getByRole("button", { name: "Terminal", exact: true }).click();
  await dialog.getByRole("switch", { name: "Cursor blink" }).click();
  await expect.poll(() => server.sets).toEqual([{ terminal: { "cursor-blink": false } }]);
  await dialog.getByRole("combobox", { name: "Cursor style" }).click();
  await page.getByRole("option", { name: "bar" }).click();
  await expect.poll(() => server.sets.at(-1)).toEqual({ terminal: { "cursor-style": "bar" } });
  expect(await page.evaluate(() => window.__tesseraStore?.getState().settings.terminal.cursorStyle)).toBe("bar");
  const reset = dialog.getByRole("button", { name: "Reset Cursor style to default" });
  await reset.click();
  await expect.poll(() => server.sets.at(-1)).toEqual({ terminal: { "cursor-style": "block" } });
  await expect(reset).toBeDisabled();
});

test("a range error from Rust shows next to the control and the old value stays", async ({ page }) => {
  const server = await mockSettings(page);
  const dialog = await openSettings(page);
  await dialog.getByRole("button", { name: "Font" }).click();
  await dialog.getByRole("textbox", { name: "Font size" }).fill("500");
  await expect(dialog.locator('[data-setting="font.size"]').getByRole("alert")).toHaveText(
    "font.size: must be at most 72",
  );
  expect(getValue(server.config, "font.size")).toBe(13);
  expect(await page.evaluate(() => window.__tesseraStore?.getState().settings.terminal.fontSize)).not.toBe(500);
  // Letters never reach Rust.
  await dialog.getByRole("textbox", { name: "Font size" }).fill("abc");
  await expect(dialog.locator('[data-setting="font.size"]').getByRole("alert")).toHaveText("Enter a number.");
  expect(server.sets).toHaveLength(1);
});

test("search finds settings by label, key and description; the key shows and copies", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockSettings(page);
  const dialog = await openSettings(page);
  const search = dialog.getByRole("searchbox", { name: "Search settings" });
  await search.fill("scrollback");
  await expect(dialog.locator("[data-setting]")).toHaveCount(1);
  await expect(dialog.locator('[data-setting="terminal.scrollback"]')).toBeVisible();
  await search.fill("long-command");
  await expect(dialog.locator('[data-setting="terminal.long-command-notify-seconds"]')).toBeVisible();
  await search.fill("shortcuts for palette");
  await expect(dialog.locator('[data-setting="keybindings.palette.open"]')).toBeVisible();
  await search.fill("zzzz nothing");
  await expect(dialog.getByText('No settings match "zzzz nothing".')).toBeVisible();
  await search.fill("scrollback");
  await dialog.locator('[data-setting="terminal.scrollback"]').hover();
  await expect(dialog.getByText("terminal.scrollback", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Copy setting key" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("terminal.scrollback");
});

test("a hand edit of config.toml updates the open screen and the terminal", async ({ page }) => {
  const server = await mockSettings(page);
  const dialog = await openSettings(page);
  await dialog.getByRole("button", { name: "Font" }).click();
  const size = dialog.getByRole("textbox", { name: "Font size" });
  await expect(size).toHaveValue("13");
  const edited = structuredClone(server.config);
  (edited.font as Record<string, unknown>).size = 22;
  await emit(page, "config:changed", edited);
  await expect(size).toHaveValue("22");
  expect(await page.evaluate(() => window.__tesseraStore?.getState().settings.terminal.fontSize)).toBe(22);
  // The edit did not echo back as a write.
  await page.waitForTimeout(400);
  expect(server.sets).toEqual([]);
});

test("config:error shows a banner with line, key and the suggestion, and clears on the next good config", async ({
  page,
}) => {
  const server = await mockSettings(page);
  const dialog = await openSettings(page);
  await emit(page, "config:error", {
    path: "/home/you/Tessera Dev/config.toml",
    line: 12,
    key: "font.sizee",
    code: "config.unknown_key",
    message: "Unknown setting font.sizee",
    suggestion: "font.size",
  });
  const banner = dialog.locator("[data-config-error]");
  await expect(banner).toContainText("keeps your last good settings");
  await expect(banner).toContainText("Line 12, key font.sizee");
  await expect(banner).toContainText("Did you mean font.size?");
  await emit(page, "config:changed", server.config);
  await expect(banner).toHaveCount(0);
});

test("Open config.toml and Reveal in folder use the data folder from app_info", async ({ page }) => {
  await page.addInitScript(() => {
    window.__tesseraOpened = [];
  });
  await mockSettings(page);
  const dialog = await openSettings(page);
  await expect(dialog.getByRole("button", { name: "Open config.toml" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Open config.toml" }).click();
  await dialog.getByRole("button", { name: "Reveal in folder" }).click();
  expect(await page.evaluate(() => window.__tesseraOpened)).toEqual([
    { kind: "path", path: "/home/you/Tessera Dev/config.toml" },
    { kind: "reveal", path: "/home/you/Tessera Dev/config.toml" },
  ]);
});

test("without settings from Rust the screen says so and can retry", async ({ page }) => {
  await openTerminal(page);
  await page.keyboard.press("Control+,");
  await expect(page.getByText("Couldn't load the settings.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("changing the font size outside the screen (zoom) writes settings_set", async ({ page }) => {
  const server = await mockSettings(page);
  await openTerminal(page);
  await page.keyboard.press("Control+=");
  await expect.poll(() => server.sets.length).toBe(1);
  expect(server.sets[0]).toMatchObject({ font: { size: expect.any(Number) } });
});
