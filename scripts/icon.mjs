// Re-exports assets/icon/tessera-1024.png from assets/icon/tessera.svg (transparent corners).
// Usage: node scripts/icon.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const dir = fileURLToPath(new URL("../assets/icon/", import.meta.url));
const svg = readFileSync(`${dir}tessera.svg`, "utf8");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(`<body style="margin:0;background:transparent">${svg}</body>`);
await page.screenshot({ path: `${dir}tessera-1024.png`, omitBackground: true });
await browser.close();
console.log("wrote assets/icon/tessera-1024.png");
