import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { flattenSchema, type JsonSchema } from "../../src/settings/schema";
import { mockTauri } from "./tauri-mock";
import { openTerminal } from "./terminal-helpers";

// The shortcut editor (S-13) against mocked IPC: record, conflicts, reset, overrides reaching the real key handler,
// bad chords in the file, export and import. "Desktop Chrome" reports Windows, so chords are Windows ones.

const schema = JSON.parse(
  readFileSync(new URL("../../../../packages/ipc/schema/config.schema.json", import.meta.url), "utf8"),
) as JsonSchema;
const fields = flattenSchema(schema);
const errors: string[] = [];

async function mockSettings(page: Page) {
  const config: Record<string, Record<string, unknown>> = {};
  for (const field of fields) config[field.section] = { ...config[field.section], [field.name]: field.default };
  const server = { config, sets: [] as Record<string, Record<string, unknown>>[] };
  await page.exposeFunction(
    "__tesseraIpc",
    async (cmd: string, args: { patch?: Record<string, Record<string, unknown>> }) => {
      if (cmd === "settings_get") return { ok: server.config };
      if (cmd === "app_info")
        return {
          ok: { name: "Tessera", version: "0.1.0", data_dir: "/x", log_dir: "/x", dev_build: true, schema_version: 1 },
        };
      if (cmd === "settings_set") {
        server.sets.push(args.patch ?? {});
        for (const [section, values] of Object.entries(args.patch ?? {})) {
          server.config[section] = { ...server.config[section], ...values };
        }
        return { ok: server.config };
      }
      return undefined;
    },
  );
  return server;
}

test.beforeEach(async ({ page, context }) => {
  errors.length = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
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

async function openKeys(page: Page) {
  await openTerminal(page);
  await page.keyboard.press("Control+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Keybindings", exact: true }).click();
  await expect(dialog.locator("[data-keybindings]")).toBeVisible();
  return dialog;
}
const row = (page: Page, id: string) => page.locator(`[data-action="${id}"]`);

test("lists actions with their shortcuts, a Default marker, and searches", async ({ page }) => {
  await mockSettings(page);
  const dialog = await openKeys(page);
  await expect(row(page, "tab.new").locator("[data-chord]")).toContainText("Ctrl+Shift+T");
  await expect(row(page, "tab.new").locator("[data-marker]")).toHaveAttribute("data-marker", "default");
  await expect(row(page, "view.sidebar")).toBeVisible();
  const search = dialog.getByRole("searchbox", { name: "Search shortcuts" });
  await search.fill("ctrl+shift+t");
  await expect(row(page, "tab.new")).toBeVisible();
  await expect(row(page, "view.sidebar")).toHaveCount(0);
  await search.fill("split");
  await expect(row(page, "pane.splitRight")).toBeVisible();
  await expect(dialog.locator("[data-conflict-summary]")).toContainText("conflicts");
});

test("record a shortcut: it saves, shows Custom, and the real handler uses it", async ({ page }) => {
  const server = await mockSettings(page);
  const dialog = await openKeys(page);
  await dialog.getByRole("button", { name: "Record a shortcut for New tab" }).click();
  const recorder = dialog.locator("[data-recorder]");
  await expect(recorder).toBeFocused();
  await expect(recorder).toHaveValue("Press the new shortcut");
  // The key goes to the recorder, not to the app: no new tab opens.
  await page.keyboard.press("Control+Alt+Y");
  await expect.poll(() => server.sets).toEqual([{ keybindings: { "tab.new": ["Mod+Alt+Y"] } }]);
  await expect(row(page, "tab.new").locator("[data-chord]")).toContainText("Ctrl+Alt+Y");
  await expect(row(page, "tab.new").locator("[data-marker]")).toHaveAttribute("data-marker", "custom");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(1);

  await page.keyboard.press("Control+Alt+Y");
  await expect(page.getByRole("tab")).toHaveCount(2);
  // The old default is free now.
  await page.keyboard.press("Control+Shift+T");
  await expect(page.getByRole("tab")).toHaveCount(2);
  // The tooltip and the shortcut sheet show the override.
  await page.getByRole("button", { name: "New tab" }).hover();
  await expect(page.getByRole("tooltip").first()).toContainText("Ctrl+Alt+Y");
  await page.keyboard.press("Control+/");
  await expect(page.getByRole("dialog", { name: /Keyboard shortcuts/i })).toContainText("Ctrl+Alt+Y");
});

test("Esc cancels recording and nothing is saved", async ({ page }) => {
  const server = await mockSettings(page);
  const dialog = await openKeys(page);
  await dialog.getByRole("button", { name: "Record a shortcut for New tab" }).click();
  await page.keyboard.press("Escape");
  await expect(dialog.locator("[data-recorder]")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  expect(server.sets).toEqual([]);
});

test("a shortcut another action uses asks: Replace takes it, Keep both shares it", async ({ page }) => {
  const server = await mockSettings(page);
  const dialog = await openKeys(page);
  await dialog.getByRole("button", { name: "Record a shortcut for Close pane" }).click();
  await page.keyboard.press("Control+Shift+T");
  const warning = row(page, "pane.close").locator("[data-conflict]");
  await expect(warning).toContainText("Ctrl+Shift+T is already used by New tab.");
  expect(server.sets).toEqual([]);
  await warning.getByRole("button", { name: "Replace" }).click();
  await expect
    .poll(() => server.sets.at(-1))
    .toEqual({ keybindings: { "tab.new": [], "pane.close": ["Mod+Shift+T"] } });
  await expect(row(page, "tab.new").getByText("Not set")).toBeVisible();
  await expect(row(page, "pane.close").locator("[data-chord]")).toContainText("Ctrl+Shift+T");

  await dialog.getByRole("button", { name: "Record a shortcut for New tab" }).click();
  await page.keyboard.press("Control+Shift+T");
  await row(page, "tab.new").locator("[data-conflict]").getByRole("button", { name: "Keep both" }).click();
  await expect(row(page, "tab.new").locator("[data-chord]")).toContainText("Ctrl+Shift+T");
  await expect(row(page, "pane.close").locator("[data-chord]")).toContainText("Ctrl+Shift+T");
  await expect(dialog.locator("[data-conflict-summary]")).toContainText("3 shortcut conflicts");
});

test("a key the shell needs is flagged and can be refused", async ({ page }) => {
  const server = await mockSettings(page);
  const dialog = await openKeys(page);
  await dialog.getByRole("button", { name: "Record a shortcut for Find", exact: true }).click();
  await page.keyboard.press("Control+KeyC");
  const warning = row(page, "terminal.find").locator("[data-conflict]");
  await expect(warning).toContainText("Ctrl+C is a key the shell uses");
  await warning.getByRole("button", { name: "Cancel" }).click();
  expect(server.sets).toEqual([]);
  await dialog.getByRole("button", { name: "Record a shortcut for Find", exact: true }).click();
  await page.keyboard.press("KeyQ");
  await expect(row(page, "terminal.find").locator("[data-conflict]")).toContainText("Q types text");
});

test("reset one, unbind, reset all", async ({ page }) => {
  const server = await mockSettings(page);
  const dialog = await openKeys(page);
  await dialog.getByRole("button", { name: "Record a shortcut for New tab" }).click();
  await page.keyboard.press("Control+Alt+Y");
  await dialog.getByRole("button", { name: "Remove the shortcut for Close pane" }).click();
  await expect(row(page, "pane.close").getByText("Not set")).toBeVisible();
  expect(server.sets.at(-1)).toEqual({ keybindings: { "pane.close": [] } });
  await dialog.getByRole("button", { name: "Reset New tab to its default" }).click();
  await expect(row(page, "tab.new").locator("[data-chord]")).toContainText("Ctrl+Shift+T");
  await expect(row(page, "tab.new").locator("[data-marker]")).toHaveAttribute("data-marker", "default");
  expect(server.sets.at(-1)).toEqual({ keybindings: { "tab.new": ["Ctrl+Shift+T"] } });
  await dialog.getByRole("button", { name: "Reset all" }).click();
  await expect(row(page, "pane.close").locator("[data-chord]")).toContainText("Ctrl+Shift+W");
  await expect(dialog.getByRole("button", { name: "Reset all" })).toBeDisabled();
});

test("a bad chord in config.toml is ignored and reported with its key; the default stays", async ({ page }) => {
  const server = await mockSettings(page);
  await openTerminal(page);
  await emit(page, "config:changed", {
    ...server.config,
    keybindings: { ...server.config.keybindings, "tab.new": "Mod+Nope", "no.such": "Mod+Z" },
  });
  await expect(
    page.getByText("Ignored the shortcut Mod+Nope for tab.new: it is not a valid shortcut").first(),
  ).toBeVisible();
  await expect(page.getByText("Ignored the shortcut Mod+Z for no.such: there is no such action").first()).toBeVisible();
  await page.keyboard.press("Control+Shift+T");
  await expect(page.getByRole("tab")).toHaveCount(2);
});

test("a hand edit of config.toml rebinds live", async ({ page }) => {
  const server = await mockSettings(page);
  await openTerminal(page);
  await emit(page, "config:changed", {
    ...server.config,
    keybindings: { ...server.config.keybindings, "tab.new": ["Ctrl+Alt+J"] },
  });
  await page.keyboard.press("Control+Alt+J");
  await expect(page.getByRole("tab")).toHaveCount(2);
});

test("a conflicting config override is reported as an error toast", async ({ page }) => {
  const server = await mockSettings(page);
  await openTerminal(page);
  await emit(page, "config:changed", {
    ...server.config,
    keybindings: { ...server.config.keybindings, "pane.close": "Ctrl+Shift+T" },
  });
  await expect(
    page.getByRole("region", { name: /Notifications/ }).getByText("Ctrl+Shift+T is already used by New tab."),
  ).toBeVisible();
});

test("export copies a TOML snippet; import applies one and reports bad lines", async ({ page }) => {
  const server = await mockSettings(page);
  const dialog = await openKeys(page);
  await dialog.getByRole("button", { name: "Copy as TOML" }).click();
  await expect(page.getByText("No custom shortcuts to copy.").first()).toBeVisible();
  await dialog.getByRole("button", { name: "Import" }).click();
  await dialog
    .locator("#keys-import")
    .fill('[keybindings]\n"tab.new" = "ctrl+alt+u"\nnonsense\n"nope.action" = "Mod+Z"\n');
  await dialog.getByRole("button", { name: "Import shortcuts" }).click();
  await expect(dialog.locator("[data-import-panel]")).toContainText("Line 3 was ignored: nonsense");
  await expect(dialog.locator("[data-import-panel]")).toContainText("nope.action is not an action Tessera knows.");
  expect(server.sets.at(-1)).toEqual({ keybindings: { "tab.new": ["Ctrl+Alt+U"] } });
  await expect(row(page, "tab.new").locator("[data-chord]")).toContainText("Ctrl+Alt+U");
  await dialog.getByRole("button", { name: "Copy as TOML" }).click();
  await expect
    .poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"))
    .toBe('[keybindings]\n"tab.new" = "Ctrl+Alt+U"\n');
});

test("the Terminal-safe preset moves Find off Ctrl+F", async ({ page }) => {
  await mockSettings(page);
  const dialog = await openKeys(page);
  await expect(row(page, "terminal.find").locator("[data-chord]")).toContainText("Ctrl+F");
  await dialog.getByRole("combobox", { name: "Shortcut preset" }).click();
  await page.getByRole("option", { name: "Terminal-safe (Windows)" }).click();
  await expect(row(page, "terminal.find").locator("[data-chord]")).toContainText("Ctrl+Shift+F");
});
