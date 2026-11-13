import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { resolveDevPort } from "../../scripts/lib/port.mjs";

// UI tests run the React app in plain Chromium with the Tauri IPC mocked (tests/ui/tauri-mock.ts), so they need no
// native shell. Port: TESSERA_DEV_PORT, else 1420 (lead) — workers set 1421 / 1422.
const port = resolveDevPort(process.env.TESSERA_DEV_PORT);
const baseURL = `http://localhost:${port}`;
const { userAgent: chromeUserAgent, ...desktopChrome } = devices["Desktop Chrome"];
const windowsUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
const platformMode = process.env.TESSERA_UI_PLATFORM;
const platformUserAgent =
  platformMode === "windows-emulated"
    ? { userAgent: windowsUserAgent }
    : platformMode === "windows-native"
      ? {}
      : { userAgent: chromeUserAgent };

export default defineConfig({
  testDir: "./tests/ui",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium",
      use: { ...desktopChrome, ...platformUserAgent, viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: "pnpm exec vite --strictPort",
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    url: baseURL,
    env: { TESSERA_DEV_PORT: String(port) },
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
