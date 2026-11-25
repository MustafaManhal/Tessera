/** Capture four mocked UI views. Start Vite on 1421 first.
 * node scripts/shot.mjs --url "http://localhost:1421/?gallery" --name gallery --out /tmp/tessera-shots
 * Absolute HTTP(S) URLs are also accepted. Output: <name>-<theme>-<width>x<height>.png.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { parseShotArgs } from "./lib/shot-args.mjs";

const options = parseShotArgs(process.argv.slice(2));
await mkdir(options.out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const colorScheme of ["light", "dark"]) {
    for (const [width, height] of [
      [1280, 800],
      [900, 600],
    ]) {
      const page = await browser.newPage({ viewport: { width, height }, colorScheme });
      await page.addInitScript((canned) => {
        const w = window;
        const calls = [];
        const callbacks = new Map();
        let nextId = 1;
        w.__TESSERA_IPC_CALLS__ = calls;
        w.__TAURI_INTERNALS__ = {
          metadata: {
            currentWindow: { label: "main" },
            currentWebview: { windowLabel: "main", label: "main" },
          },
          invoke: async (cmd, args) => {
            calls.push({ cmd, args });
            if (cmd in canned) return canned[cmd];
            throw new Error(`mockTauri: no reply for IPC command "${cmd}"`);
          },
          transformCallback: (callback, once = false) => {
            const id = nextId++;
            callbacks.set(id, (data) => {
              if (once) callbacks.delete(id);
              callback(data);
            });
            return id;
          },
          unregisterCallback: (id) => callbacks.delete(id),
          runCallback: (id, data) => callbacks.get(id)?.(data),
          callbacks,
          convertFileSrc: (path) => path,
        };
        w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event, id) => callbacks.delete(id) };
      }, {});
      await page.goto(options.url);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: join(options.out, `${options.name}-${colorScheme}-${width}x${height}.png`),
        animations: "disabled",
      });
      await page.close();
    }
  }
} finally {
  await browser.close();
}
