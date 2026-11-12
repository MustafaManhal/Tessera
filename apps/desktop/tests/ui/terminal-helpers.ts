import { expect, type Page } from "@playwright/test";

// Helpers for terminal specs: the app runs the fake shell in the browser (window.__tesseraFakePty) and `?renderer=dom`
// forces xterm's DOM renderer so the screen text can be read from the page.

export interface FakeLog {
  spawns: { cwd: string; cols: number; rows: number }[];
  writes: { session: string; bytes: number[] }[];
  resizes: { session: string; cols: number; rows: number }[];
  acks: { session: string; bytes: number }[];
  kills: string[];
}

export async function fakeLog(page: Page): Promise<FakeLog> {
  return page.evaluate(() => {
    const log = window.__tesseraFakePty?.log;
    if (!log) throw new Error("no fake pty");
    return {
      spawns: log.spawns.map((s) => ({ cwd: s.cwd, cols: s.cols, rows: s.rows })),
      writes: log.writes.map((w) => ({ session: w.session, bytes: Array.from(w.bytes) })),
      resizes: log.resizes.slice(),
      acks: log.acks.slice(),
      kills: log.kills.slice(),
    };
  });
}

/** Text of the visible terminal screen in the focused (or given) pane, from the DOM renderer. */
export async function screen(page: Page, index = 0): Promise<string> {
  return page
    .locator('[role="tabpanel"]:not([hidden]) section[data-pane-id]:not([hidden]) .xterm-rows')
    .nth(index)
    .evaluate((rows) =>
      Array.from(rows.children, (row) => (row.textContent ?? "").replaceAll("\u00a0", " ")).join("\n"),
    );
}

export async function openTerminal(page: Page, query = "renderer=dom") {
  await page.goto(`/?${query}`);
  // Works with either renderer: the engine's own screen text (WebGL draws to a canvas, not the DOM).
  await expect
    .poll(() => page.evaluate(() => Array.from(window.__tesseraPanes?.values() ?? [])[0]?.engine.screenText() ?? ""), {
      timeout: 10_000,
    })
    .toContain("$");
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea")))
    .toBe(true);
}

/** Types a command into the focused terminal and presses Enter. */
export async function run(page: Page, command: string) {
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}
