import { expect, type Page, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";

// The About dialog (S-22) over the mocked IPC: loading, error with retry, and the details from a canned `app_info`.

const INFO = {
  name: "Tessera",
  version: "0.1.0",
  dev_build: true,
  data_dir: "/Users/you/Library/Application Support/dev.tessera.terminal.dev",
  log_dir: "/Users/you/Library/Logs/dev.tessera.terminal.dev",
  schema_version: 1,
};

/**
 * Answers `app_info` after `delayMs`, with `info` or by failing with `error` (an `AppError`-like value); every other
 * command still goes to mockTauri. Runs after mockTauri's init script and wraps its `invoke`.
 */
async function mockAppInfo(page: Page, options: { delayMs?: number; info?: unknown; error?: unknown }) {
  await page.addInitScript((opts) => {
    const internals = (
      window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }
    ).__TAURI_INTERNALS__;
    const original = internals.invoke;
    // Fails while `__appInfoFails` is true (a test clears it to make the retry succeed).
    const flags = window as unknown as { __appInfoFails?: boolean };
    flags.__appInfoFails = opts.error !== undefined;
    internals.invoke = async (cmd, args) => {
      if (cmd !== "app_info") return original(cmd, args);
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs ?? 0));
      if (flags.__appInfoFails) throw opts.error;
      return opts.info;
    };
  }, options);
}

const errors: string[] = [];

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

test("opens from the status bar, shows loading, then the details", async ({ page }) => {
  await mockAppInfo(page, { delayMs: 600, info: INFO });
  await page.goto("/?placeholder");
  await page.locator(`[data-sidebar-footer="app.about"]`).click();
  const dialog = page.getByRole("dialog", { name: "About Tessera" });
  await expect(dialog.getByRole("status")).toHaveText("Loading app information…");
  await expect(dialog).toContainText("0.1.0");
  await expect(dialog).toContainText("Dev build");
  await expect(dialog).toContainText(INFO.log_dir);
  await expect(dialog.getByRole("button", { name: "Copy details" })).toBeVisible();
  // Esc closes once focus is inside the dialog (Radix moves it there when the dialog opens).
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("shows the error and retries", async ({ page }) => {
  await mockAppInfo(page, { info: INFO, error: { kind: "Internal", message: "store is locked" } });
  await page.goto("/?placeholder");
  await page.keyboard.press("Control+Alt+Shift+A");
  const dialog = page.getByRole("dialog", { name: "About Tessera" });
  await expect(dialog).toContainText("Couldn't load app information");
  await page.evaluate(() => {
    (window as unknown as { __appInfoFails?: boolean }).__appInfoFails = false;
  });
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(dialog).toContainText("0.1.0");
});

test("is in the palette", async ({ page }) => {
  await mockAppInfo(page, { info: INFO });
  await page.goto("/?placeholder");
  await page.keyboard.press("Control+K");
  await page.getByRole("combobox").fill("about");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "About Tessera" })).toContainText("Tessera");
});

test("the name has a respelling and a button that speaks it", async ({ page }) => {
  await mockAppInfo(page, { info: INFO });
  // A fake speech engine records what is spoken.
  await page.addInitScript(() => {
    // No usable audio: the button must fall back to the speech voice.
    window.Audio = class {
      play() {
        return Promise.reject(new Error("blocked"));
      }
    } as unknown as typeof Audio;
  });
  await page.addInitScript(() => {
    const spoken: Array<{ text: string; lang: string; rate: number }> = [];
    (window as unknown as { __spoken: typeof spoken }).__spoken = spoken;
    class Utterance {
      voice: unknown = null;
      lang = "";
      rate = 1;
      constructor(public text: string) {}
    }
    (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = Utterance;
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        speak: (u: Utterance) => spoken.push({ text: u.text, lang: u.lang, rate: u.rate }),
        cancel: () => {},
        getVoices: () => [],
      },
    });
  });
  await page.goto("/?placeholder");
  await page.locator(`[data-sidebar-footer="app.about"]`).click();
  const dialog = page.getByRole("dialog", { name: "About Tessera" });
  await expect(dialog).toContainText("TESS-er-uh");
  await dialog.getByRole("button", { name: "Hear how to say Tessera" }).click();
  expect(await page.evaluate(() => (window as unknown as { __spoken: unknown[] }).__spoken)).toEqual([
    { text: "Tessera", lang: "en-US", rate: 0.9 },
  ]);
});

test("without a speech voice the button explains instead of failing", async ({ page }) => {
  await mockAppInfo(page, { info: INFO });
  await page.addInitScript(() => {
    // No usable audio: the button must fall back to the speech voice.
    window.Audio = class {
      play() {
        return Promise.reject(new Error("blocked"));
      }
    } as unknown as typeof Audio;
  });
  await page.addInitScript(() => {
    // `delete` does nothing here (the property lives on the prototype), so shadow it with undefined.
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: undefined });
  });
  await page.goto("/?placeholder");
  await page.locator(`[data-sidebar-footer="app.about"]`).click();
  await page
    .getByRole("dialog", { name: "About Tessera" })
    .getByRole("button", { name: "Hear how to say Tessera" })
    .click();
  await expect(page.getByText("can't play the name").first()).toBeVisible();
});

test("the button plays the bundled human recording", async ({ page }) => {
  await mockAppInfo(page, { info: INFO });
  await page.addInitScript(() => {
    const played: string[] = [];
    (window as unknown as { __played: string[] }).__played = played;
    window.Audio = class {
      constructor(public src: string) {}
      play() {
        played.push(this.src);
        return Promise.resolve();
      }
    } as unknown as typeof Audio;
  });
  await page.goto("/?placeholder");
  await page.locator(`[data-sidebar-footer="app.about"]`).click();
  await page
    .getByRole("dialog", { name: "About Tessera" })
    .getByRole("button", { name: "Hear how to say Tessera" })
    .click();
  const played = await page.evaluate(() => (window as unknown as { __played: string[] }).__played);
  expect(played).toHaveLength(1);
  expect(played[0]).toContain("tessera");
  expect(played[0]).toContain(".mp3");
});
