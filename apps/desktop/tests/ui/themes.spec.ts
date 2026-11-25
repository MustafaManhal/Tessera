import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { flattenSchema, type JsonSchema } from "../../src/settings/schema";
import { mockTauri } from "./tauri-mock";
import { openTerminal } from "./terminal-helpers";

// App themes and the terminal picker against mocked IPC: one theme recolours the whole app (tokens, terminal, data-theme),
// following the computer switches between the preferred light and dark themes live, the Appearance page saves the
// choice; the terminal picker previews on the real terminal, Esc restores, Enter sets terminal-theme, filters,
// favourites, import of three formats.

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
const token = (page: Page, name: string) =>
  page.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), name);
async function pushConfig(
  page: Page,
  config: Record<string, Record<string, unknown>>,
  appearance: Record<string, unknown>,
) {
  await page.evaluate(
    ([config, appearance]) =>
      (window as unknown as { __tesseraEmit: (e: string, p: unknown) => void }).__tesseraEmit("config:changed", {
        ...config,
        appearance: { ...config.appearance, ...appearance },
      }),
    [config, appearance] as const,
  );
}

async function openPicker(page: Page) {
  await openTerminal(page);
  await page.keyboard.press("Control+Alt+T");
  const dialog = page.getByRole("dialog", { name: "Terminal colours" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("option").first()).toBeVisible();
  return dialog;
}
const option = (page: Page, name: string) => page.getByRole("option", { name: new RegExp(`^${name}`) });

test("opens from the keyboard and the palette; lists the app themes and the bundled ones", async ({ page }) => {
  await mockSettings(page);
  const dialog = await openPicker(page);
  await expect(dialog.getByRole("combobox", { name: "Search themes" })).toBeFocused();
  await expect(dialog.getByRole("option").first()).toContainText("Tessera Dark");
  // The terminal matches the app theme, so no scheme is marked as chosen.
  await expect(dialog.locator("[data-current]")).toHaveCount(0);
  expect(await dialog.getByRole("option").count()).toBeGreaterThan(500);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press("Control+K");
  await page.keyboard.type("theme choose");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Terminal colours" })).toBeVisible();
});

test("arrowing previews on the real terminal at once; Esc puts the old theme back", async ({ page }) => {
  await mockSettings(page);
  const before = await (async () => {
    await openTerminal(page);
    return terminalBackground(page);
  })();
  await page.keyboard.press("Control+Alt+T");
  const dialog = page.getByRole("dialog", { name: "Terminal colours" });
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
  expect(await chromeVar(page)).toBe(before);
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
  const dialog = page.getByRole("dialog", { name: "Terminal colours" });
  const search = dialog.getByRole("combobox", { name: "Search themes" });
  await search.fill("solarized");
  await option(page, "iTerm2 Solarized Light").click();
  await expect.poll(() => terminalBackgrounds(page)).toEqual(["#fdf6e3", "#fdf6e3"]);
  await option(page, "iTerm2 Solarized Dark").hover();
  await expect.poll(() => terminalBackgrounds(page)).toEqual(["#002b36", "#002b36"]);
  await page.keyboard.press("Escape");
  await expect.poll(() => terminalBackground(page)).toBe(before);
});

test("Enter sets the terminal theme, saves through settings_set and keeps it; the app keeps its own theme", async ({
  page,
}) => {
  const server = await mockSettings(page);
  const dialog = await openPicker(page);
  await dialog.getByRole("combobox", { name: "Search themes" }).fill("iterm2 solarized light");
  await expect(option(page, "iTerm2 Solarized Light")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect(server.sets).toEqual([{ appearance: { "terminal-theme": "iTerm2 Solarized Light" } }]);
  await expect.poll(() => terminalBackground(page)).toBe("#fdf6e3");
  expect(await chromeVar(page)).toBe("#fdf6e3");
  expect(await token(page, "--bg")).toBe("#16181c");
  await page.keyboard.press("Control+Alt+T");
  await expect(option(page, "iTerm2 Solarized Light")).toHaveAttribute("data-current", "true");
});

test("one theme recolours the whole app: tokens, data-theme and the terminal", async ({ page }) => {
  const server = await mockSettings(page);
  await openTerminal(page);
  // Tessera Dark is the default.
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.colorTheme)).toBe("tessera-dark");
  expect(await token(page, "--bg")).toBe("#16181c");
  expect(await terminalBackground(page)).toBe("#16181c");

  await pushConfig(page, server.config, { "color-theme": "Dracula" });
  await expect.poll(() => token(page, "--bg")).toBe("#282a36");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => terminalBackground(page)).toBe("#282a36");
  expect(await token(page, "--sidebar-bg")).toBe("#21222c");

  await pushConfig(page, server.config, { "color-theme": "Solarized Light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect.poll(() => terminalBackground(page)).toBe("#fdf6e3");
  // Dark+ has a blue status bar with white text on it.
  await pushConfig(page, server.config, { "color-theme": "Dark+" });
  await expect(page.locator("footer[data-statusbar]")).toHaveCSS("background-color", "rgb(0, 122, 204)");
  await expect(page.locator("footer[data-statusbar]")).toHaveCSS("color", "rgb(255, 255, 255)");
  // An unknown name falls back to the default theme for the computer's setting (light here).
  await pushConfig(page, server.config, { "color-theme": "No Such Theme" });
  await expect.poll(() => token(page, "--bg")).toBe("#ffffff");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("following the computer switches between the preferred light and dark themes live", async ({ page }) => {
  const server = await mockSettings(page);
  await page.emulateMedia({ colorScheme: "light" });
  await openTerminal(page);
  await pushConfig(page, server.config, {
    "follow-system": true,
    "preferred-light-theme": "GitHub Light",
    "preferred-dark-theme": "Nord",
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.colorTheme)).toBe("github-light");
  await expect.poll(() => terminalBackground(page)).toBe("#ffffff");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.colorTheme)).toBe("nord");
  await expect.poll(() => terminalBackground(page)).toBe("#2e3440");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("filters: light, dark, favourites; stars persist", async ({ page }) => {
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
  // "Imported" only shows once something is imported.
  await expect(filter("Imported")).toHaveCount(0);
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
  await page
    .getByRole("dialog", { name: "Terminal colours" })
    .getByRole("button", { name: "Imported", exact: true })
    .click();
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

async function openAppearance(page: Page) {
  await page.keyboard.press("Control+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Appearance", exact: true }).click();
  return dialog;
}

test("the Appearance page picks the theme, follows the computer, and saves each choice", async ({ page }) => {
  const server = await mockSettings(page);
  await openTerminal(page);
  const dialog = await openAppearance(page);
  await expect(dialog.locator('[data-color-theme="tessera-dark"]')).toHaveAttribute("aria-checked", "true");
  expect(await dialog.locator("[data-color-theme]").count()).toBe(16);

  await dialog.locator('[data-color-theme="monokai"]').click();
  await expect.poll(() => server.sets.at(-1)).toEqual({ appearance: { "color-theme": "Monokai" } });
  await expect.poll(() => token(page, "--bg")).toBe("#272822");
  await expect(dialog.locator('[data-color-theme="monokai"]')).toHaveAttribute("aria-checked", "true");

  // Following the computer: a card sets the preferred theme of its kind, and both picks carry a badge.
  await dialog.getByRole("switch", { name: "Match my computer" }).click();
  await expect.poll(() => server.sets.at(-1)).toEqual({ appearance: { "follow-system": true } });
  await dialog.locator('[data-color-theme="light-modern"]').click();
  await expect.poll(() => server.sets.at(-1)).toEqual({ appearance: { "preferred-light-theme": "Light Modern" } });
  await expect(dialog.locator('[data-color-theme="light-modern"] [data-theme-badge]')).toHaveText("Light mode");
  await expect(dialog.locator('[data-color-theme="tessera-dark"] [data-theme-badge]')).toHaveText("Dark mode");
});

test("terminal colours match the app theme until the switch is turned off", async ({ page }) => {
  const server = await mockSettings(page);
  await openTerminal(page);
  const dialog = await openAppearance(page);
  const match = dialog.getByRole("switch", { name: "Match the app theme" });
  await expect(match).toBeChecked();
  await expect(dialog.getByRole("button", { name: "Choose terminal colours" })).toHaveCount(0);
  // Off opens the picker; choosing a scheme there sets the terminal theme.
  await match.click();
  const picker = page.getByRole("dialog", { name: "Terminal colours" });
  await expect(picker).toBeVisible();
  await picker.getByRole("combobox", { name: "Search themes" }).fill("dracula");
  await expect(option(page, "Dracula").first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect.poll(() => server.sets.at(-1)).toEqual({ appearance: { "terminal-theme": "Dracula" } });
  await expect.poll(() => terminalBackground(page)).toBe("#282a36");
  // Back on: the terminal follows the app theme again.
  const again = await openAppearance(page);
  await expect(again.getByRole("switch", { name: "Match the app theme" })).not.toBeChecked();
  await expect(again.getByRole("button", { name: "Choose terminal colours" })).toBeVisible();
  await again.getByRole("switch", { name: "Match the app theme" }).click();
  await expect.poll(() => server.sets.at(-1)).toEqual({ appearance: { "terminal-theme": "" } });
  await expect.poll(() => terminalBackground(page)).toBe("#16181c");
});

test("the primary colour can be changed for any theme and back to the theme's own", async ({ page }) => {
  const server = await mockSettings(page);
  await openTerminal(page);
  const dialog = await openAppearance(page);
  expect(await token(page, "--accent")).toBe("#2f6feb");
  await expect(dialog.locator('[data-accent-preset="default"]')).toHaveAttribute("aria-checked", "true");

  await dialog.locator('[data-accent-preset="pink"]').click();
  await expect.poll(() => server.sets.at(-1)).toEqual({ appearance: { accent: "#e6539f" } });
  await expect.poll(() => token(page, "--accent")).toBe("#e6539f");
  await expect(dialog.locator('[data-accent-preset="pink"]')).toHaveAttribute("aria-checked", "true");

  // The colour stays when the theme changes.
  await dialog.locator('[data-color-theme="nord"]').click();
  await expect.poll(() => token(page, "--bg")).toBe("#2e3440");
  expect(await token(page, "--accent")).toBe("#e6539f");

  // Any colour from the colour input.
  await dialog.locator("[data-accent-custom]").fill("#22a352");
  await expect.poll(() => token(page, "--accent")).toBe("#22a352");

  await dialog.getByRole("button", { name: "Use the theme's colour" }).click();
  await expect.poll(() => server.sets.at(-1)).toEqual({ appearance: { accent: "" } });
  await expect.poll(() => token(page, "--accent")).toBe("#88c0d0");
});
