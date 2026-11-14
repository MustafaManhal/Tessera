import { join } from "node:path";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { fakeLog, openTerminal, run, screen } from "./terminal-helpers";

// M1.3 and M1.4 over the fake shell: font zoom, ligatures, Unicode cells, search, links, paste and drop.
// "Desktop Chrome" reports Windows, so chords are the Windows ones.

const errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await mockTauri(page, { settings_set: null });
  // Never open real windows: record window.open instead.
  await page.addInitScript(() => {
    window.open = (() => null) as typeof window.open;
  });
});

test.afterEach(() => {
  expect(errors, "console errors").toEqual([]);
});

async function shot(page: Page, testInfo: TestInfo, name: string) {
  const dir = process.env.TESSERA_SHOTS_DIR;
  const path = dir ? join(dir, name) : testInfo.outputPath(name);
  await page.screenshot({ path, animations: "disabled" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

const fontSize = (page: Page) => page.evaluate(() => window.__tesseraStore?.getState().settings.terminal.fontSize);
const written = async (page: Page) => (await fakeLog(page)).writes.map((w) => String.fromCharCode(...w.bytes)).join("");

/** Screen position (CSS px) of the cell at the middle of `text` on the visible screen. */
async function cellOf(page: Page, text: string, offset = 0) {
  return page.evaluate(
    ({ text, offset }) => {
      const screenEl = document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden]) .xterm-screen');
      const terminals = window.__tesseraPanes ? Array.from(window.__tesseraPanes.values()) : [];
      const engine = terminals[0]?.engine;
      if (!screenEl || !engine) throw new Error("no terminal");
      const box = screenEl.getBoundingClientRect();
      const cellW = box.width / engine.cols;
      const cellH = box.height / engine.rows;
      // The engine's screen text works with either renderer (WebGL draws to a canvas).
      const lines = engine.screenText().split("\n");
      const y = lines.findIndex((line) => line.includes(text));
      if (y < 0) throw new Error(`"${text}" not on screen`);
      const x = (lines[y] ?? "").indexOf(text) + offset;
      return { x: box.left + (x + 0.5) * cellW, y: box.top + (y + 0.5) * cellH };
    },
    { text, offset },
  );
}

test.describe("fonts and Unicode (M1.3)", () => {
  test("font zoom: bigger, smaller, reset, announced; applies to every pane", async ({ page }) => {
    await openTerminal(page);
    const start = (await fontSize(page)) ?? 0;
    const cell = () =>
      page
        .locator(".xterm-rows > div")
        .first()
        .evaluate((row) => row.getBoundingClientRect().height);
    const height = await cell();
    await page.keyboard.press("Control+Equal");
    await page.keyboard.press("Control+Equal");
    await expect.poll(() => fontSize(page)).toBe(start + 2);
    await expect(page.getByTestId("announcer")).toHaveText(`Text size ${start + 2} px`);
    await expect.poll(cell).toBeGreaterThan(height);
    await page.keyboard.press("Control+Shift+D");
    await expect(page.locator(".xterm-rows")).toHaveCount(2);
    const heights = await page
      .locator(".xterm-rows")
      .evaluateAll((all) => all.map((rows) => rows.firstElementChild?.getBoundingClientRect().height));
    expect(heights[0]).toBe(heights[1]);
    await page.keyboard.press("Control+Minus");
    await expect.poll(() => fontSize(page)).toBe(start + 1);
    await page.keyboard.press("Control+0");
    await expect.poll(() => fontSize(page)).toBe(start);
    // The pane context menu has the same actions.
    await page.locator("section[data-pane-id]").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: /Bigger text/ }).click();
    await expect.poll(() => fontSize(page)).toBe(start + 1);
  });

  test("the ligatures toggle turns the addon on and off", async ({ page }) => {
    await openTerminal(page);
    const ligatures = () => page.evaluate(() => window.__tesseraStore?.getState().settings.terminal.ligatures);
    expect(await ligatures()).toBe(false);
    await page.keyboard.press("Control+Alt+Shift+L");
    await expect.poll(ligatures).toBe(true);
    await expect(page.getByTestId("announcer")).toHaveText("Ligatures on");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const engine = Array.from(window.__tesseraPanes?.values() ?? [])[0]?.engine as
            | { ligaturesActive?: boolean }
            | undefined;
          return engine?.ligaturesActive;
        }),
      )
      .toBe(true);
    await page.keyboard.press("Control+K");
    await page.getByRole("combobox").fill("ligatures");
    await expect(page.getByRole("option").first()).toContainText("Turn off ligatures");
    await page.keyboard.press("Enter");
    await expect.poll(ligatures).toBe(false);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`Unicode: CJK takes two cells, a flag is one glyph (${scheme}, WebGL)`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1280, height: 800 });
      await openTerminal(page, "");
      await run(page, "unicode");
      await expect
        .poll(() =>
          page.evaluate(() => Array.from(window.__tesseraPanes?.values() ?? [])[0]?.engine.screenText() ?? ""),
        )
        .toContain("Ligatures");
      expect(await page.evaluate(() => Array.from(window.__tesseraPanes?.values() ?? [])[0]?.engine.renderer)).toBe(
        "webgl",
      );
      // The buffer: each CJK character is one wide cell (width 2), the flag is one grapheme in one wide cell.
      const cells = await page.evaluate(() => {
        const engine = Array.from(window.__tesseraPanes?.values() ?? [])[0]?.engine as unknown as {
          xterm: {
            buffer: {
              active: {
                length: number;
                getLine(y: number):
                  | {
                      translateToString(trim: boolean): string;
                      getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
                    }
                  | undefined;
              };
            };
          };
        };
        const buffer = engine.xterm.buffer.active;
        const row = (prefix: string) => {
          for (let y = 0; y < buffer.length; y++) {
            const line = buffer.getLine(y);
            if (line?.translateToString(true).startsWith(prefix)) return line;
          }
          return undefined;
        };
        const cjk = row("CJK");
        const emoji = row("Emoji");
        const widths: number[] = [];
        for (let x = 11; x < 21; x++) widths.push(cjk?.getCell(x)?.getWidth() ?? -1);
        const closing = cjk?.getCell(21)?.getChars();
        const flags: { chars: string; width: number }[] = [];
        for (let x = 0; x < 60; x++) {
          const cell = emoji?.getCell(x);
          if (cell && /\p{Regional_Indicator}/u.test(cell.getChars())) {
            flags.push({ chars: cell.getChars(), width: cell.getWidth() });
          }
        }
        return { widths, closing, flags };
      });
      // 5 wide characters: width 2 then a 0-width continuation cell, five times; the bar lands on cell 21.
      expect(cells.widths).toEqual([2, 0, 2, 0, 2, 0, 2, 0, 2, 0]);
      expect(cells.closing).toBe("|");
      expect(cells.flags).toEqual([
        { chars: "🇯🇵", width: 2 },
        { chars: "🇺🇦", width: 2 },
      ]);
      // Pixels: the bar after the CJK run is drawn at cell 21 (cell-width multiples), not where 5 narrow cells end.
      const bar = await cellOf(page, "|", 0);
      const png = await page.screenshot();
      const ink = await page.evaluate(
        async ({ data, y }) => {
          const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
          const bitmap = await createImageBitmap(blob);
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = canvas.getContext("2d");
          if (!context) throw new Error("no 2d context");
          context.drawImage(bitmap, 0, 0);
          const screenEl = document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden]) .xterm-screen');
          const engine = Array.from(window.__tesseraPanes?.values() ?? [])[0]?.engine;
          if (!screenEl || !engine) throw new Error("no terminal");
          const box = screenEl.getBoundingClientRect();
          const cellW = box.width / engine.cols;
          const cellH = box.height / engine.rows;
          const scale = bitmap.width / window.innerWidth;
          const row = Math.floor((y - box.top) / cellH) + 1; // the CJK line is right after the ASCII line
          const background = context.getImageData(
            Math.round((box.right - 4) * scale),
            Math.round((box.top + row * cellH + 2) * scale),
            1,
            1,
          ).data;
          // Ink per cell: how many pixels in the cell differ from the background.
          const inkIn = (cell: number) => {
            const x0 = Math.round((box.left + cell * cellW) * scale);
            const y0 = Math.round((box.top + row * cellH) * scale);
            const w = Math.max(1, Math.round(cellW * scale));
            const h = Math.max(1, Math.round(cellH * scale));
            const pixels = context.getImageData(x0, y0, w, h).data;
            let count = 0;
            for (let i = 0; i < pixels.length; i += 4) {
              const d =
                Math.abs((pixels[i] ?? 0) - (background[0] ?? 0)) +
                Math.abs((pixels[i + 1] ?? 0) - (background[1] ?? 0)) +
                Math.abs((pixels[i + 2] ?? 0) - (background[2] ?? 0));
              if (d > 60) count += 1;
            }
            return count;
          };
          return { bar: inkIn(21), narrowEnd: inkIn(16), cjk: inkIn(12) };
        },
        { data: png.toString("base64"), y: bar.y },
      );
      expect(ink.bar).toBeGreaterThan(0);
      expect(ink.cjk).toBeGreaterThan(0);
      await shot(page, testInfo, `unicode-${scheme}-1280.png`);
    });
  }
});

test.describe("search (M1.4)", () => {
  test("Ctrl+F finds and counts, Enter and Shift+Enter move, regex errors show, Esc returns focus", async ({
    page,
  }, testInfo) => {
    await openTerminal(page);
    await run(page, "flood 10000");
    await expect.poll(() => screen(page), { timeout: 20_000 }).toContain("$");
    await expect.poll(async () => (await screen(page)).includes("10000"), { timeout: 20_000 }).toBe(true);
    await page.keyboard.press("Control+F");
    const input = page.getByRole("searchbox", { name: "Find in terminal" });
    await expect(input).toBeFocused();
    const started = Date.now();
    await input.fill("   9999 ");
    await expect(page.getByText("1 of 1", { exact: true })).toBeVisible();
    const searchMs = Date.now() - started;
    testInfo.annotations.push({ type: "perf", description: `search over 10,000 lines: ${searchMs} ms` });
    expect(searchMs).toBeLessThan(2000);
    // "000 " is in lines 1000, 2000, … 10000: ten matches.
    await input.fill("000 ");
    const count = page.getByText(/^\d+ of 10$/);
    await expect(count).toBeVisible();
    const first = await count.textContent();
    await input.press("Enter");
    await expect(count).not.toHaveText(first ?? "");
    await input.press("Shift+Enter");
    await expect(count).toHaveText(first ?? "");
    await page.getByRole("button", { name: "Regular expression" }).click();
    await expect(page.getByRole("button", { name: "Regular expression" })).toHaveAttribute("aria-pressed", "true");
    await input.fill("000(");
    await expect(page.getByRole("alert")).toContainText("Invalid regular expression");
    await input.fill("000 |9999");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await shot(page, testInfo, "search-light-1280.png");
    await input.press("Escape");
    await expect(input).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea")))
      .toBe(true);
  });

  test("no matches says so", async ({ page }) => {
    await openTerminal(page);
    await page.keyboard.press("Control+F");
    await page.getByRole("searchbox", { name: "Find in terminal" }).fill("nothing-like-this");
    await expect(page.getByText("No results")).toBeVisible();
  });
});

test.describe("links (M1.4)", () => {
  // The test machine is a Mac, where Chromium turns Ctrl+click into a secondary click; so this runs as macOS (Cmd).
  // Windows Ctrl+click is on the manual checklist.
  test.use({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  });

  test("Cmd+click opens allowed URLs and paths; a plain click and unsafe schemes do not", async ({ page }) => {
    await openTerminal(page);
    await run(page, "links");
    await run(page, "osc8 javascript:alert(1) unsafe-link");
    await expect.poll(() => screen(page)).toContain("unsafe-link");
    const opened = () => page.evaluate(() => window.__tesseraOpened ?? []);

    const url = await cellOf(page, "https://example.com", 3);
    await page.mouse.move(url.x, url.y);
    await expect(page.getByRole("tooltip")).toContainText("https://example.com/docs?q=1");
    await page.mouse.click(url.x, url.y);
    expect(await opened()).toEqual([]);
    await page.keyboard.down("Meta");
    await page.mouse.click(url.x, url.y);
    await page.keyboard.up("Meta");
    await expect.poll(opened).toEqual([{ kind: "url", url: "https://example.com/docs?q=1" }]);

    const osc8 = await cellOf(page, "an OSC 8 link", 3);
    await page.mouse.move(osc8.x, osc8.y);
    await page.keyboard.down("Meta");
    await page.mouse.click(osc8.x, osc8.y);
    await page.keyboard.up("Meta");
    await expect.poll(async () => (await opened()).length).toBe(2);
    expect((await opened())[1]).toEqual({ kind: "url", url: "https://tessera.dev/osc8" });

    const path = await cellOf(page, "src/main.rs:42:7", 2);
    await page.mouse.move(path.x, path.y);
    await expect(page.getByRole("tooltip")).toContainText("/home/you/src/main.rs:42");
    await page.keyboard.down("Meta");
    await page.mouse.click(path.x, path.y);
    await page.keyboard.up("Meta");
    await expect.poll(async () => (await opened()).length).toBe(3);
    expect((await opened())[2]).toEqual({ kind: "editor", path: "/home/you/src/main.rs", line: 42, column: 7 });

    const unsafe = await cellOf(page, "unsafe-link", 2);
    await page.mouse.move(unsafe.x, unsafe.y);
    await page.keyboard.down("Meta");
    await page.mouse.click(unsafe.x, unsafe.y);
    await page.keyboard.up("Meta");
    // xterm does not activate a javascript: OSC 8 target, and our allowlist would refuse it anyway: nothing opens.
    await page.waitForTimeout(200);
    expect(await opened()).toHaveLength(3);
  });
});

async function paste(page: Page, text: string) {
  await page.evaluate((value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    document
      .querySelector('[role="tabpanel"]:not([hidden]) .xterm-helper-textarea')
      ?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

test.describe("paste and drop (M1.4)", () => {
  test("one line pastes at once, wrapped in bracketed-paste markers", async ({ page }) => {
    await openTerminal(page);
    await paste(page, "echo pasted");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect.poll(() => written(page)).toContain("\x1b[200~echo pasted\x1b[201~");
  });

  test("several lines ask first: Paste, Paste as one line, Cancel, Don't ask again", async ({ page }, testInfo) => {
    await openTerminal(page);
    await page.evaluate(() =>
      window.__tesseraStore?.dispatch({ type: "settings/setTerminal", payload: { pasteConfirm: "multiline" } }),
    );
    await paste(page, "echo one\necho two\n");
    const dialog = page.getByRole("alertdialog", { name: "Paste 2 lines?" });
    await expect(dialog).toContainText("echo one");
    await shot(page, testInfo, "paste-confirm-light-1280.png");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect(await written(page)).not.toContain("echo one");

    await paste(page, "echo one\necho two\n");
    await page.getByRole("button", { name: "Paste as one line" }).click();
    await expect.poll(() => written(page)).toContain("\x1b[200~echo one echo two\x1b[201~");

    await page.evaluate(() =>
      window.__tesseraStore?.dispatch({ type: "settings/setTerminal", payload: { pasteConfirm: "multiline" } }),
    );
    await paste(page, "a\x1b[201~b");
    await expect(page.getByRole("alertdialog")).toContainText("a␛[201~b");
    await page.getByRole("switch", { name: "Don't ask again" }).click();
    await page.getByRole("button", { name: "Paste", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.__tesseraStore?.getState().settings.terminal.pasteConfirm))
      .toBe("never");
    await paste(page, "x\ny");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });

  test("dropped files insert quoted names; native drops insert quoted paths", async ({ page }) => {
    await openTerminal(page);
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File(["x"], "my file.txt"));
      data.items.add(new File(["y"], "it's.md"));
      document
        .querySelector('[role="tabpanel"]:not([hidden]) [data-terminal]')
        ?.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    // Windows (the test browser's platform) quotes for PowerShell: single quotes, a quote doubled.
    await expect.poll(() => written(page)).toContain("'my file.txt' 'it''s.md' ");
    const point = await cellOf(page, "$", 0);
    const took = await page.evaluate(
      ({ x, y }) => window.__tesseraDrop?.(["/Users/me/a b.txt", "/tmp/plain.log"], x, y),
      point,
    );
    expect(took).toBe(true);
    await expect.poll(() => written(page)).toContain("'/Users/me/a b.txt' /tmp/plain.log ");
    const windowsPaths = await page.evaluate((point) => {
      const { x, y } = point;
      return window.__tesseraDrop?.(["C:\\Users\\me\\a b.txt", "\\\\server\\share\\it's.md"], x, y);
    }, point);
    expect(windowsPaths).toBe(true);
    await expect.poll(() => written(page)).toContain("'C:\\Users\\me\\a b.txt' '\\\\server\\share\\it''s.md' ");
  });
});

test.describe("screenshots", () => {
  for (const scheme of ["light", "dark"] as const) {
    for (const [width, height] of [
      [1280, 800],
      [900, 600],
    ] as const) {
      test(`terminal with colours and a split, ${scheme}, ${width}×${height}`, async ({ page }, testInfo) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height });
        await openTerminal(page, "");
        await run(page, "colors");
        await page.keyboard.press("Control+Shift+D");
        await expect.poll(async () => (await fakeLog(page)).spawns.length).toBe(2);
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea")))
          .toBe(true);
        await run(page, "links");
        await page.waitForTimeout(300);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        await shot(page, testInfo, `terminal-${scheme}-${width}.png`);
      });
    }
  }
});
