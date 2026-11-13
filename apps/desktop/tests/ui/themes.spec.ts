import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { flattenSchema, type JsonSchema } from "../../src/settings/schema";
import { mockTauri } from "./tauri-mock";
import { openTerminal } from "./terminal-helpers";

// The theme picker (S-12) and importers against mocked IPC: live preview on the real terminal, Esc restores, Enter applies
// to the light or dark slot, the OS appearance switches slots live, filters, favourites, import of three formats.

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
        for (const [section, values] of Object.entries(args.patch ?? {}))
          server.config[section] = { ...server.config[section], ...values };
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

const terminalBackground = (page: Page) =>
  page.evaluate(() => {
    const pane = Array.from(window.__tesseraPanes?.values() ?? [])[0];
    const xterm = (pane?.engine as unknown as { xterm?: { options: { theme?: { background?: string } } } } | undefined)
      ?.xterm;
    return xterm?.options.theme?.background;
  });
const terminalBackgrounds = (page: Page) =>
  page.evaluate(() =>
    Array.from(window.__tesseraPanes?.values() ?? []).map(
      (pane) =>
        (pane.engine as unknown as { xterm?: { options: { theme?: { background?: string } } } } | undefined)?.xterm
          ?.options.theme?.background,
    ),
  );
const chromeVar = (page: Page) => page.evaluate(() => document.documentElement.style.getPropertyValue("--term-bg"));

async function openPicker(page: Page) {
  await openTerminal(page);
  await page.keyboard.press("Control+Alt+T");
  const dialog = page.getByRole("dialog", { name: "Theme" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("option").first()).toBeVisible();
  return dialog;
}
const option = (page: Page, name: string) => page.getByRole("option", { name: new RegExp(`^${name}`) });

test("opens from the keyboard and the palette; lists built-in, bundled and a current marker", async ({ page }) => {
  await mockSettings(page);
  const dialog = await openPicker(page);
  await expect(dialog.getByRole("combobox", { name: "Search themes" })).toBeFocused();
  await expect(option(page, "Tessera Light")).toHaveAttribute("data-current", "true");
  expect(await dialog.getByRole("option").count()).toBeGreaterThan(500);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press("Control+K");
  await page.keyboard.type("theme choose");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Theme" })).toBeVisible();
});

test("arrowing previews on the real terminal at once; Esc puts the old theme back", async ({ page }) => {
  await mockSettings(page);
  const before = await (async () => {
    await openTerminal(page);
    return terminalBackground(page);
  })();
  await page.keyboard.press("Control+Alt+T");
  const dialog = page.getByRole("dialog", { name: "Theme" });
  const search = dialog.getByRole("combobox", { name: "Search themes" });
  await search.fill("dracula");
  await expect(option(page, "Dracula").first()).toBeVisible();
  await expect.poll(() => terminalBackground(page)).toBe("#282a36");
  expect(await chromeVar(page)).toBe("#282a36");
  await expect(dialog.locator("[data-theme-preview]")).toHaveAttribute("data-theme-preview", "Dracula");
  await search.fill("");
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => terminalBackground(page)).not.toBe("#282a36");
  await search.fill("dracula");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => terminalBackground(page)).toBe(before);
  expect(await chromeVar(page)).toBe("");
});

test("hovering another theme previews it on every open terminal", async ({ page }) => {
  await mockSettings(page);
  const before = await (async () => {
    await openTerminal(page);
    await page.getByRole("button", { name: "Split right" }).click();
    await expect(page.locator("section[data-pane-id]")).toHaveCount(2);
    return terminalBackground(page);
  })();
  await page.keyboard.press("Control+Alt+T");
  const dialog = page.getByRole("dialog", { name: "Theme" });
  const search = dialog.getByRole("combobox", { name: "Search themes" });
  await search.fill("solarized");
  await option(page, "iTerm2 Solarized Light").click();
  await expect.poll(() => terminalBackgrounds(page)).toEqual(["#fdf6e3", "#fdf6e3"]);
  await option(page, "iTerm2 Solarized Dark").hover();
  await expect.poll(() => terminalBackgrounds(page)).toEqual(["#002b36", "#002b36"]);
  await page.keyboard.press("Escape");
  await expect.poll(() => terminalBackground(page)).toBe(before);
});

test("Enter applies to the light slot (the current mode), saves through settings_set and keeps it", async ({
  page,
}) => {
  const server = await mockSettings(page);
  const dialog = await openPicker(page);
  await dialog.getByRole("combobox", { name: "Search themes" }).fill("solarized light");
  await expect(option(page, "iTerm2 Solarized Light")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect(server.sets).toEqual([{ appearance: { "theme-light": "iTerm2 Solarized Light" } }]);
  await expect.poll(() => terminalBackground(page)).toBe("#fdf6e3");
  expect(await chromeVar(page)).toBe("#fdf6e3");
});

test("the dark slot is separate, and the OS appearance switches between the two live", async ({ page }) => {
  const server = await mockSettings(page);
  const dialog = await openPicker(page);
  await dialog.getByRole("combobox", { name: "Apply to" }).click();
  await page.getByRole("option", { name: "Dark mode" }).click();
  await dialog.getByRole("combobox", { name: "Search themes" }).fill("nord");
  await page.locator('[data-theme-id="Nord"]').click();
  await dialog.getByRole("button", { name: "Apply theme" }).click();
  expect(server.sets).toEqual([{ appearance: { "theme-dark": "Nord" } }]);
  const light = await terminalBackground(page);
  expect(light).not.toBe("#2e3440");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => terminalBackground(page)).toBe("#2e3440");
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => terminalBackground(page)).toBe(light);
});

test("appearance.theme forces the window mode", async ({ page }) => {
  const server = await mockSettings(page);
  await openTerminal(page);
  await page.evaluate(
    (config) =>
      (window as unknown as { __tesseraEmit: (e: string, p: unknown) => void }).__tesseraEmit("config:changed", {
        ...config,
        appearance: { ...config.appearance, theme: "dark" },
      }),
    server.config,
  );
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
});

test("filters: light, dark, high contrast, favourites; stars persist", async ({ page }) => {
  await mockSettings(page);
  const dialog = await openPicker(page);
  const filter = (name: string) => dialog.getByRole("button", { name, exact: true });
  await filter("Light").click();
  await dialog.getByRole("combobox", { name: "Search themes" }).fill("solarized");
  await expect(option(page, "iTerm2 Solarized Light")).toBeVisible();
  await expect(option(page, "iTerm2 Solarized Dark")).toHaveCount(0);
  await filter("Dark").click();
  await expect(option(page, "iTerm2 Solarized Dark")).toBeVisible();
  await filter("All").click();
  await dialog.getByRole("combobox", { name: "Search themes" }).fill("dracula");
  await option(page, "Dracula").first().hover();
  await dialog.getByRole("button", { name: "Add Dracula to favourites" }).first().click();
  await filter("Favourites").click();
  await dialog.getByRole("combobox", { name: "Search themes" }).fill("");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "Remove Dracula from favourites" })).toBeVisible();
  await filter("Imported").click();
  await expect(dialog.getByText("No theme matches.")).toBeVisible();
  await filter("All").click();
  await dialog.getByRole("combobox", { name: "Search themes" }).fill("high contrast");
  await expect(dialog.getByRole("option").first()).toBeVisible();
  await filter("High contrast").click();
  await expect(dialog.getByRole("option").first()).toContainText("High Contrast");
});

const WT = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "Pale Blue",
    black: "#ffffff",
    red: "#ffff88",
    green: "#ffffaa",
    yellow: "#ffffcc",
    blue: "#eeeeff",
    purple: "#ffeeff",
    cyan: "#eeffff",
    white: "#000000",
    brightBlack: "#ffffff",
    brightRed: "#ffff88",
    brightGreen: "#ffffaa",
    brightYellow: "#ffffcc",
    brightBlue: "#eeeeff",
    brightPurple: "#ffeeff",
    brightCyan: "#eeffff",
    brightWhite: "#000000",
    background: "#ffffff",
    foreground: "#dddddd",
    cursorColor: "#000000",
    selectionBackground: "#cccccc",
    ...extra,
  });
const ghosttyText = [
  ...[
    "#101010",
    "#cc4444",
    "#44cc44",
    "#cccc44",
    "#7777ff",
    "#cc44cc",
    "#44cccc",
    "#cccccc",
    "#555555",
    "#ff6666",
    "#66ff66",
    "#ffff66",
    "#6666ff",
    "#ff66ff",
    "#66ffff",
    "#ffffff",
  ].map((hex, i) => `palette = ${i}=${hex}`),
  "background = #101010",
  "foreground = #e0e0e0",
].join("\n");

test("import: a Windows Terminal scheme warns about contrast; Ghostty works; a bad file explains itself", async ({
  page,
}) => {
  await mockSettings(page);
  const dialog = await openPicker(page);
  await dialog.locator("[data-theme-file]").setInputFiles([
    { name: "pale.json", mimeType: "application/json", buffer: Buffer.from(WT()) },
    { name: "Midnight.conf", mimeType: "text/plain", buffer: Buffer.from(ghosttyText) },
    { name: "broken.json", mimeType: "application/json", buffer: Buffer.from("{nope") },
    { name: "empty.txt", mimeType: "text/plain", buffer: Buffer.from("") },
    { name: "words.txt", mimeType: "text/plain", buffer: Buffer.from("this is not a theme") },
  ]);
  await expect(dialog.locator("[data-import-error]")).toHaveText([
    "broken.json: the file is not valid JSON",
    "empty.txt: the file is empty",
    "words.txt: this is not an iTerm2, Ghostty or Windows Terminal colour scheme",
  ]);
  await expect(page.getByText("2 themes imported").first()).toBeVisible();
  await dialog.getByRole("button", { name: "Imported", exact: true }).click();
  await expect(dialog.getByRole("option")).toHaveCount(2);
  await option(page, "Pale Blue").click();
  await expect(dialog.locator("[data-theme-warning]").first()).toContainText(
    "The text is hard to read: contrast 1.4:1",
  );
  await option(page, "Midnight").click();
  await expect(dialog.locator("[data-theme-warning]")).toHaveCount(0);
  await expect.poll(() => terminalBackground(page)).toBe("#101010");
  // Imported themes are kept and can be removed.
  await page.keyboard.press("Escape");
  await page.reload();
  await page.keyboard.press("Control+Alt+T");
  await page.getByRole("dialog", { name: "Theme" }).getByRole("button", { name: "Imported", exact: true }).click();
  await expect(page.getByRole("option")).toHaveCount(2);
  await page.getByRole("button", { name: "Remove imported theme Pale Blue" }).click();
  await expect(page.getByRole("option")).toHaveCount(1);
});

test("import: an .itermcolors file", async ({ page }) => {
  await mockSettings(page);
  const dialog = await openPicker(page);
  const part = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => (Number.parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(4));
    return `<dict><key>Blue Component</key><real>${b}</real><key>Green Component</key><real>${g}</real><key>Red Component</key><real>${r}</real></dict>`;
  };
  const colours: Record<string, string> = { "Background Color": "#fdf6e3", "Foreground Color": "#073642" };
  for (let i = 0; i < 16; i++)
    colours[`Ansi ${i} Color`] =
      i % 8 === 7
        ? "#eee8d5"
        : (["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5"][i % 8] ??
          "#000000");
  const xml = `<?xml version="1.0"?><plist version="1.0"><dict>${Object.entries(colours)
    .map(([k, v]) => `<key>${k}</key>${part(v)}`)
    .join("")}</dict></plist>`;
  await dialog
    .locator("[data-theme-file]")
    .setInputFiles({ name: "Paper.itermcolors", mimeType: "text/xml", buffer: Buffer.from(xml) });
  await expect(page.getByText("1 themes imported").first()).toBeVisible();
  await expect(dialog.locator("[data-theme-preview]")).toHaveAttribute("data-theme-preview", "Paper");
  await expect.poll(() => terminalBackground(page)).toBe("#fdf6e3");
});

test("the Appearance page has a button for the picker", async ({ page }) => {
  await mockSettings(page);
  await openTerminal(page);
  await page.keyboard.press("Control+,");
  await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("button", { name: "Choose theme…" }).click();
  await expect(page.getByRole("dialog", { name: "Theme" })).toBeVisible();
});
