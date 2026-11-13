import { SearchAddon } from "@xterm/addon-search";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

const report = document.querySelector("#report");
const xtermReport = document.querySelector("#xterm-report");
const startedAt = performance.now();

try {
  const { init, Terminal } = await import("https://cdn.jsdelivr.net/npm/ghostty-web@0.4.0/dist/ghostty-web.js");
  await init();

  const terminal = new Terminal({
    cols: 100,
    rows: 24,
    fontFamily: "ui-monospace, monospace",
    fontSize: 14,
    scrollback: 1000,
    theme: { background: "#17191f", foreground: "#ddd" },
  });
  terminal.open(document.querySelector("#terminal"));
  terminal.write("Ghostty Web 0.4.0\r\nUnicode: ⚙️ 👩‍💻 🇺🇸 नमस्ते\r\n");

  const firstPaintMs = await new Promise((resolve) => {
    terminal.write("\x1b]7;file://localhost/tmp\x07\x1b]133;A\x07");
    requestAnimationFrame(() => resolve(performance.now() - startedAt));
  });
  const unicodeLine = terminal.buffer.active.getLine(1)?.translateToString(true) ?? "";
  terminal.select(0, 0, 7);
  const selectionWorks = terminal.getSelection().length > 0;
  terminal.clearSelection();
  const hooks = {
    findNext: typeof terminal.findNext === "function",
    registerOscHandler: typeof terminal.parser?.registerOscHandler === "function",
  };

  const ghosttyResults = {
    firstPaintMs,
    unicodeLine,
    selectionWorks,
    hooks,
    floodMs: "not run",
  };
  globalThis.__ghosttySpike = { terminal, results: ghosttyResults };
  report.textContent = JSON.stringify(ghosttyResults, null, 2);

  const xtermStartedAt = performance.now();
  const xterm = new Xterm({ cols: 100, rows: 24, scrollback: 1000, allowProposedApi: true });
  const search = new SearchAddon();
  xterm.loadAddon(search);
  xterm.loadAddon(new UnicodeGraphemesAddon());
  xterm.unicode.activeVersion = "15-graphemes";
  xterm.open(document.querySelector("#xterm-terminal"));
  const xtermFirstPaintMs = await new Promise((resolve) => {
    xterm.write("xterm.js 6.0.0\r\nUnicode: ⚙️ 👩‍💻 🇺🇸 नमस्ते\r\n", () => {
      requestAnimationFrame(() => resolve(performance.now() - xtermStartedAt));
    });
  });
  const xtermResults = {
    firstPaintMs: xtermFirstPaintMs,
    unicodeLine: xterm.buffer.active.getLine(1)?.translateToString(true) ?? "",
    selectionWorks: (() => {
      xterm.select(0, 0, 7);
      const works = xterm.getSelection().length > 0;
      xterm.clearSelection();
      return works;
    })(),
    hooks: {
      findNext: typeof search.findNext === "function",
      registerOscHandler: typeof xterm.parser?.registerOscHandler === "function",
    },
    floodMs: "not run",
  };
  globalThis.__ghosttySpike.xterm = xterm;
  globalThis.__ghosttySpike.xtermResults = xtermResults;
  xtermReport.textContent = JSON.stringify(xtermResults, null, 2);

  const button = document.querySelector("#flood");
  button.disabled = false;
  button.addEventListener("click", async () => {
    button.disabled = true;
    const chunk = "0123456789abcdef".repeat(4096);
    const bytes = 100 * 1024 * 1024;
    const flood = async (target) => {
      const started = performance.now();
      try {
        const chunks = bytes / chunk.length;
        for (let i = 0; i < chunks; i += 1) {
          target.write(chunk);
          if (i % 8 === 7) await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return performance.now() - started;
      } catch (error) {
        return `failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    };
    ghosttyResults.floodMs = await flood(terminal);
    xtermResults.floodMs = await flood(xterm);
    report.textContent = JSON.stringify(ghosttyResults, null, 2);
    xtermReport.textContent = JSON.stringify(xtermResults, null, 2);
    button.disabled = false;
  });
} catch (error) {
  report.textContent = `Spike failed: ${error instanceof Error ? error.message : String(error)}`;
  throw error;
}
