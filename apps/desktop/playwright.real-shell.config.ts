import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { resolveDevPort } from "../../scripts/lib/port.mjs";

const port = resolveDevPort(process.env.TESSERA_DEV_PORT);
const baseURL = `http://localhost:${port}`;
const { userAgent: chromeUserAgent, ...desktopChrome } = devices["Desktop Chrome"];

export default defineConfig({
  testDir: "./tests/real-shell",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    ...desktopChrome,
    userAgent: chromeUserAgent,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "real-shell", testMatch: "**/*.spec.ts" }],
  webServer: {
    command: "pnpm exec vite --strictPort",
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    url: baseURL,
    env: { TESSERA_DEV_PORT: String(port) },
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
