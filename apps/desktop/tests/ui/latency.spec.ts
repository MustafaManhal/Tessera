import { expect, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { openTerminal } from "./terminal-helpers";

test.beforeEach(async ({ page }) => {
  await mockTauri(page);
});

for (const mode of ["dom", "webgl"] as const) {
  test(`measures key-to-glyph latency with the ${mode} renderer`, async ({ page }) => {
    await openTerminal(page, mode === "dom" ? "renderer=dom" : "");
    const renderer = await page.evaluate(() => Array.from(window.__tesseraPanes?.values() ?? [])[0]?.engine.renderer);
    expect(renderer).toBe(mode);

    await page.keyboard.type("z".repeat(30));
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                window as Window & {
                  __tessera_latency?: { n: number };
                }
              ).__tessera_latency?.n ?? 0,
          ),
        { timeout: 2_000 },
      )
      .toBe(30);

    const summary = await page.evaluate(
      () =>
        (
          window as Window & {
            __tessera_latency?: { n: number; p50: number; p95: number; p99: number; renderer: string };
          }
        ).__tessera_latency,
    );
    console.info(`${mode} latency p50=${summary?.p50}ms p95=${summary?.p95}ms p99=${summary?.p99}ms n=${summary?.n}`);
    expect(summary).toMatchObject({ n: 30, renderer: mode });
    expect(summary?.p50).toBeGreaterThan(0);
    // The 16 ms budget (NFR-01) is a statement about real hardware. Shared CI runners draw WebGL in software and are
    // noisy, so there the test only guards against a gross regression (4x the budget); run it locally for the real gate.
    expect(summary?.p95).toBeLessThanOrEqual(process.env.CI ? 64 : 16);
    expect(summary?.p99).toBeGreaterThanOrEqual(summary?.p95 ?? 0);
  });
}
