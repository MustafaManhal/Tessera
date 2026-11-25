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

test("queries in the saved history are not answered into the new shell", async ({ page }) => {
  await openTerminal(page, "renderer=dom");
  await waitForAutosave(page, 1);
  // The history an agent left: it asked for the device attributes, the background colour and focus reports.
  await page.evaluate(() => {
    const store = window.__tesseraStore;
    if (!store) throw new Error("no store");
    for (const paneId of Object.keys(store.getState().layout.panes)) {
      localStorage.setItem(`tessera.scrollback.${paneId}`, "agent said hi\r\n\x1b[c\x1b]11;?\x07\x1b[?1004h");
    }
  });

  await openTerminal(page, "renderer=dom");
  await expect.poll(() => screen(page)).toContain("restored session");
  // Give xterm time to parse the history (its answers would come now) and the fake shell time to start.
  await expect.poll(async () => (await fakeLog(page)).spawns.length).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  const typed = (await fakeLog(page)).writes.map((write) => String.fromCharCode(...write.bytes)).join("");
  expect(typed).not.toContain("\x1b[?");
  expect(typed).not.toContain("\x1b]11;");
  expect(typed).not.toContain("\x1b[I");
});

test("commands in the saved history are not reported again: the agent record keeps the latest conversation", async ({
  page,
}) => {
  await openTerminal(page, "renderer=dom");
  await waitForAutosave(page, 1);
  // The old shell's history: an older `claude --resume` that started and ended, with its command marks.
  await page.evaluate(() => {
    const store = window.__tesseraStore;
    if (!store) throw new Error("no store");
    const marks =
      "\x1b]133;A\x07$ \x1b]133;B\x07claude --resume old-conversation\r\n\x1b]133;C\x07working\r\n\x1b]133;D;0\x07";
    for (const paneId of Object.keys(store.getState().layout.panes)) {
      localStorage.setItem(`tessera.scrollback.${paneId}`, marks);
    }
  });

  await openTerminal(page, "renderer=dom");
  await expect.poll(() => screen(page)).toContain("restored session");
  await page.waitForTimeout(500);
  const calls = await page.evaluate(() =>
    (window.__tesseraAgents?.calls ?? [])
      .filter((call) => call.method === "paneAgentStarted" || call.method === "paneAgentFinished")
      .map((call) => ({ method: call.method, args: call.args.map(String) })),
  );
  expect(calls).toEqual([]);
});

test("Undo on the restore toast starts empty and saves that", async ({ page }) => {
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
  // Undo opens nothing by itself: the window is empty until the user opens a terminal.
  await expect(tabs(page)).toHaveCount(0);
  await expect(page.getByText("No tabs are open.")).toBeVisible();
  await waitForAutosave(page, 0);

  // Nothing to restore: no restore toast (the browser preview opens its starter terminal).
  await openTerminal(page, "renderer=dom");
  await expect(tabs(page)).toHaveCount(1);
  await expect(page.getByRole("region", { name: /Notifications/ }).getByText(/Restored/)).toHaveCount(0);
});

test("with nothing saved the window starts empty: no terminal the user did not ask for", async ({ page }) => {
  await page.goto("/?renderer=dom&start=empty");
  await expect(page.getByText("No tabs are open.")).toBeVisible();
  await expect(tabs(page)).toHaveCount(0);
  expect((await fakeLog(page)).spawns).toEqual([]);
  await page.getByRole("button", { name: "New terminal in home folder" }).click();
  await expect(tabs(page)).toHaveCount(1);
  await expect.poll(async () => (await fakeLog(page)).spawns.length).toBe(1);
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
