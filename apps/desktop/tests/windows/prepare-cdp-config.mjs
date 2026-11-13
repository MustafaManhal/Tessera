import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const sourcePath = resolve(root, "apps/desktop/src-tauri/tauri.conf.json");
const outputPath = resolve(root, "artifacts/windows/tauri.cdp.conf.json");
const config = JSON.parse(await readFile(sourcePath, "utf8"));
const windows = config.app?.windows;
if (!Array.isArray(windows) || !windows.some((window) => window.label === "main")) {
  throw new Error(`Tauri config at ${sourcePath} must define a main window`);
}

for (const window of windows) {
  if (window.label === "main") {
    window.visible = true;
    // Enable capture before the first PTY spawn. Reloading replaces the pane
    // and can conceal a startup-only failure.
    window.url = "index.html?debug&renderer=dom";
  }
  window.additionalBrowserArgs = [window.additionalBrowserArgs, "--remote-debugging-port=9222"]
    .filter(Boolean)
    .join(" ");
}

await mkdir(resolve(root, "artifacts/windows"), { recursive: true });
await writeFile(outputPath, `${JSON.stringify({ app: { windows } }, null, 2)}\n`);
console.log(`Wrote visible-window DevTools config overlay to ${outputPath}`);
