import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const artifactDir = resolve(root, "artifacts/windows");
const app = resolve(root, process.env.TESSERA_APP_PATH ?? "target/debug/tessera-desktop.exe");
const debuggerUrl = "http://127.0.0.1:9222";
const appLog = resolve(artifactDir, "app-output.log");
const profileDir = resolve(tmpdir(), `tessera-webview2-${process.pid}`);
const telemetryDir = resolve(artifactDir, "startup-diagnostics");
const telemetryPath = resolve(telemetryDir, "events.jsonl");
const appDataDir = resolve(process.env.APPDATA ?? root, "Tessera Dev");

const output = [];
const steps = [];
const consoleMessages = [];
const pageErrors = [];
let diagnostics;
let terminalVerdict;
let browser;
let page;
let appProcess;
let appError;
let appExit;
let resolveAppExit;
let appExited;
/** A fresh exit promise per launch (the restore check quits and relaunches the app). */
function armExit() {
  appError = undefined;
  appExit = undefined;
  appExited = new Promise((resolve) => {
    resolveAppExit = resolve;
  });
}
armExit();

const record = (name, value = "passed") => {
  const result = value === "passed" || value.startsWith("failed:") ? value : `passed: ${value}`;
  steps.push({ name, result });
  console.log(`[windows-smoke] ${name}: ${result}`);
};

async function waitFor(read, predicate, label, timeout = 30_000, pollMs = 200) {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = await read();
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(latest)}`);
}

async function devtoolsVersion() {
  try {
    const response = await fetch(`${debuggerUrl}/json/version`);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function invoke(command, args = {}) {
  if (!page) throw new Error(`Cannot invoke ${command} before the app page is ready`);
  const result = await page.evaluate(
    async ({ command, args }) => {
      try {
        return await window.__TAURI_INTERNALS__.invoke(command, args);
      } catch (error) {
        return { __tesseraInvokeError: String(error) };
      }
    },
    { command, args },
  );
  if (result?.__tesseraInvokeError) throw new Error(`${command}: ${result.__tesseraInvokeError}`);
  return result;
}

async function runStep(name, action) {
  try {
    const value = await action();
    record(name, typeof value === "string" ? value : "passed");
    return { passed: true, value };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record(name, `failed: ${message}`);
    await failureScreenshot(name);
    return { passed: false, error: message };
  }
}

/** Best effort: a screenshot of the webview when a step fails, so the next run shows what was on screen. */
async function failureScreenshot(name) {
  if (!page) return;
  const slug = name
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  try {
    await page.screenshot({ path: resolve(artifactDir, `failed-${slug}.png`), timeout: 5_000 });
  } catch {
    // the page may be gone (the app quit or crashed)
  }
}

/** The focused pane's screen text (with two panes, the first one is not the one being typed into). */
async function screen() {
  return page
    .locator('[data-pane-id][data-focused="true"] .xterm-rows')
    .evaluateAll((rows) => rows[0]?.innerText ?? "");
}

async function sendKeys(selector, text) {
  const input = page.locator(selector);
  await input.focus();
  if (!(await input.evaluate((element) => document.activeElement === element))) {
    throw new Error(`Could not focus input ${selector}`);
  }
  await page.keyboard.type(text);
}

async function typeCommand(command) {
  await sendKeys('[data-pane-id][data-focused="true"] .xterm-helper-textarea', command);
  await page.keyboard.press("Enter");
}

/** Waits for a quiet PowerShell prompt in the focused pane, then types `command` until `predicate` holds on the screen.
 * PSReadLine drops keys typed while it is still starting, so a fresh shell may lose the first attempt. */
async function typeUntil(command, predicate, label, attempts = 3) {
  await waitFor(screen, (text) => /PS\s+[A-Z]:\\[^>]*>\s*$/i.test(text), `${label}: prompt`, 90_000);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await waitForQuietScreen();
    await typeCommand(command);
    try {
      return await waitFor(screen, predicate, label, 10_000);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Resolves once the focused pane's text has not changed for `quietMs`. */
async function waitForQuietScreen(quietMs = 1_000, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last = await screen();
  let since = Date.now();
  while (Date.now() < deadline && Date.now() - since < quietMs) {
    await new Promise((done) => setTimeout(done, 200));
    const now = await screen();
    if (now !== last) {
      last = now;
      since = Date.now();
    }
  }
}

async function screenshot(name) {
  const path = resolve(artifactDir, name);
  await page.screenshot({ path });
  record("webview screenshot", path);
}

async function setAppearance(theme) {
  await invoke("settings_set", { patch: { appearance: { theme } } });
  await waitFor(
    () => page.locator("html").getAttribute("data-theme"),
    (value) => value === theme,
    `${theme} theme`,
  );
}

async function openAbout() {
  const aboutButton = page.getByRole("button", { name: /about tessera/i });
  if (await aboutButton.count()) {
    await aboutButton.first().click();
  } else {
    await page.keyboard.press("Control+Shift+P");
    const palette = page.locator("[role=combobox]");
    await palette.waitFor();
    await palette.fill("About Tessera");
    const action = page.getByRole("option", { name: /about tessera/i });
    await action.waitFor();
    await action.click();
  }
}

async function checkProcessStopped(pid) {
  const ps = spawn(
    "pwsh",
    [
      "-NoProfile",
      "-Command",
      `(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ''`,
    ],
    { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let result = "";
  ps.stdout.on("data", (chunk) => (result += chunk.toString()));
  await new Promise((done) => ps.once("close", done));
  return result.trim() === "";
}

async function launchApp() {
  const existing = await devtoolsVersion();
  if (existing) {
    throw new Error(`DevTools already responds on 127.0.0.1:9222 (${existing.Browser ?? "unknown browser"})`);
  }

  await mkdir(profileDir, { recursive: true });
  await mkdir(telemetryDir, { recursive: true });
  await rm(telemetryPath, { force: true });
  armExit();
  appProcess = spawn(app, [], {
    cwd: root,
    env: {
      ...process.env,
      RUST_LOG: "debug",
      TESSERA_BENCH_ROOT: telemetryDir,
      TESSERA_BENCH_DATA_ROOT: appDataDir,
      WEBVIEW2_USER_DATA_FOLDER: profileDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222",
    },
    windowsHide: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  appProcess.stdout.on("data", (chunk) => output.push(chunk.toString()));
  appProcess.stderr.on("data", (chunk) => output.push(chunk.toString()));
  appProcess.once("error", (error) => {
    appError = error;
    resolveAppExit();
  });
  appProcess.once("exit", (code, signal) => {
    appExit = { code, signal };
    resolveAppExit();
  });

  await waitFor(
    async () => {
      if (appError) throw new Error(`Failed to start ${app}: ${appError.message}`);
      if (appExit) throw new Error(`The app exited before opening DevTools: ${JSON.stringify(appExit)}`);
      return devtoolsVersion();
    },
    Boolean,
    "WebView2 DevTools endpoint",
    60_000,
  );

  browser = await chromium.connectOverCDP(debuggerUrl);
  page = await waitFor(
    async () => {
      for (const context of browser.contexts()) {
        for (const candidate of context.pages()) {
          if (await candidate.locator("#root").count()) return candidate;
        }
      }
      return null;
    },
    Boolean,
    "Tessera page",
    60_000,
  );

  page.on("console", (message) => {
    consoleMessages.push({ type: message.type(), text: message.text(), location: message.location() });
  });
  page.on("pageerror", (error) => pageErrors.push({ name: error.name, message: error.message, stack: error.stack }));
  const query = new URL(page.url()).searchParams;
  if (!query.has("debug") || query.get("renderer") !== "dom") {
    throw new Error("The smoke needs the generated DevTools config with debug and DOM renderer enabled at startup");
  }
  const webdriver = await page.evaluate(() => navigator.webdriver);
  record("app launched directly and attached over CDP", `navigator.webdriver=${webdriver}`);
  // A first start shows the onboarding over the shell (M12.1); skip it the way a user would.
  const skip = page.getByRole("button", { name: "Skip", exact: true }).first();
  // `isVisible` does not wait, so wait for the button to appear (the first-run state arrives a moment after the shell).
  const onboardingShown = await skip
    .waitFor({ state: "visible", timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (onboardingShown) {
    await skip.click();
    await page
      .locator("[data-onboarding]")
      .waitFor({ state: "detached", timeout: 10_000 })
      .catch(() => {});
    record("first-run onboarding skipped", "Skip pressed");
  }
}

async function resizeWindow(width, height) {
  const ps = spawn(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      resolve(root, "apps/desktop/tests/windows/resize-window.ps1"),
      "-ProcessId",
      String(appProcess.pid),
      "-Width",
      String(width),
      "-Height",
      String(height),
    ],
    { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stdout = [];
  const stderr = [];
  ps.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
  ps.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  const code = await new Promise((done) => ps.once("close", done));
  if (code !== 0) {
    throw new Error(`Could not resize the Tessera window: ${stderr.join("").trim() || stdout.join("").trim()}`);
  }
}

async function collectDiagnostics() {
  diagnostics = {
    date: new Date().toISOString(),
    app,
    debuggerUrl,
    environment: {
      RUST_LOG: "debug",
      TESSERA_BENCH_ROOT: telemetryDir,
      TESSERA_BENCH_DATA_ROOT: appDataDir,
      WEBVIEW2_USER_DATA_FOLDER: profileDir,
      mainWindowVisible: true,
    },
    document: null,
    terminal: null,
    ipc: null,
    consoleMessages,
    pageErrors,
    appOutput: output.join(""),
    screenshot: null,
  };
  diagnostics.document = await page.evaluate(() => ({
    visibilityState: document.visibilityState,
    readyState: document.readyState,
    innerWidth,
    innerHeight,
    outerWidth,
    outerHeight,
    devicePixelRatio,
  }));
  diagnostics.pty = await page.evaluate(() => window.__tessera_diag ?? null);
  diagnostics.terminal = await page.evaluate(() => ({
    panes: [...document.querySelectorAll("[data-terminal-pane]")].map((pane) => ({
      paneId: pane.getAttribute("data-terminal-pane"),
      sessionId: pane.getAttribute("data-session"),
      text: pane.querySelector(".xterm-rows")?.innerText ?? "",
    })),
    xtermBufferText: [...document.querySelectorAll(".xterm-rows")].map((row) => row.innerText).join("\n"),
    ptySpawnState:
      "A non-empty data-session on a terminal pane means its pty_spawn completed; an empty value means it has not.",
  }));
  try {
    diagnostics.ipc = { command: "shell_list", result: await invoke("shell_list") };
  } catch (error) {
    diagnostics.ipc = { command: "shell_list", error: error.message };
  }

  const screenshotPath = resolve(artifactDir, "cdp-diagnostic.png");
  try {
    await page.screenshot({ path: screenshotPath, timeout: 15_000 });
    diagnostics.screenshot = screenshotPath;
  } catch (error) {
    diagnostics.screenshotError = error.message;
  }
  diagnostics.appOutput = output.join("");
  diagnostics.benchmarkEventsPath = telemetryPath;
  await writeFile(resolve(artifactDir, "diagnostics.json"), `${JSON.stringify(diagnostics, null, 2)}\n`);
}

async function collectFinalPageState() {
  if (!diagnostics || !page) return;
  try {
    diagnostics.finalPageState = await page.evaluate(() => ({
      document: {
        visibilityState: document.visibilityState,
        readyState: document.readyState,
        innerWidth,
        innerHeight,
        outerWidth,
        outerHeight,
        devicePixelRatio,
      },
      pty: window.__tessera_diag ?? null,
      panes: [...document.querySelectorAll("[data-terminal-pane]")].map((pane) => ({
        paneId: pane.getAttribute("data-terminal-pane"),
        sessionId: pane.getAttribute("data-session"),
        text: pane.querySelector(".xterm-rows")?.innerText ?? "",
      })),
      xtermBufferText: [...document.querySelectorAll(".xterm-rows")].map((row) => row.innerText).join("\n"),
    }));
  } catch (error) {
    diagnostics.finalPageStateError = error.message;
  }
}

async function reportTerminalVerdict() {
  if (terminalVerdict) return;
  const current = await (page
    ? page.evaluate(() => ({
        bufferHasText: [...document.querySelectorAll(".xterm-rows")].some((row) => row.innerText.trim().length > 0),
        panes: window.__tessera_diag?.panes ?? {},
      }))
    : Promise.resolve({ bufferHasText: false, panes: {} })
  ).catch(() => ({ bufferHasText: false, panes: {} }));
  const marks = (await readFile(telemetryPath, "utf8").catch(() => "")).split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const elapsed = (event) => marks.find((mark) => mark.event === event)?.ms ?? null;
  const firstByteMs = elapsed("first_byte");
  const spawnMs = elapsed("host_spawn_begin");
  terminalVerdict = {
    ...current,
    firstByteMs,
    spawnToFirstByteMs: firstByteMs !== null && spawnMs !== null ? firstByteMs - spawnMs : null,
    firstOutputMs: elapsed("first_output"),
  };
  console.log(`[windows-smoke] terminal buffer has text: ${current.bufferHasText ? "yes" : "no"}`);
  console.log(`[windows-smoke] terminal diagnostics: ${JSON.stringify(terminalVerdict)}`);
}

async function runShellChecks() {
  await runStep("PowerShell prompt", async () => {
    const text = await waitFor(screen, (value) => /PS\s+[A-Z]:\\/i.test(value), "PowerShell prompt", 90_000);
    return text.match(/PS\s+[A-Z]:\\[^>\r\n]*>/i)?.[0] ?? "visible";
  });

  await reportTerminalVerdict();
  const echo = await runStep("typed echo tessera-ok", async () => {
    await typeCommand("echo tessera-ok");
    return waitFor(screen, (text) => /^tessera-ok\s*$/m.test(text), "terminal echo");
  });
  const sizeStart = await runStep("initial console size", async () => {
    if (!echo.passed) throw new Error("Skipped because the PowerShell prompt or echo failed");
    await typeCommand(
      'Write-Output ("TESSERA_SIZE:" + $Host.UI.RawUI.WindowSize.Width + "x" + $Host.UI.RawUI.WindowSize.Height)',
    );
    const text = await waitFor(screen, (value) => /TESSERA_SIZE:\d+x\d+/.test(value), "initial console size");
    const match = text.match(/TESSERA_SIZE:(\d+)x(\d+)/);
    if (!match) throw new Error("Could not parse the initial PowerShell console size");
    return match;
  });
  await runStep("resize changes PowerShell grid", async () => {
    if (!sizeStart.passed) throw new Error("Skipped because the initial console size was unavailable");
    await resizeWindow(720, 500);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await typeCommand(
      'Write-Output ("TESSERA_SIZE:" + $Host.UI.RawUI.WindowSize.Width + "x" + $Host.UI.RawUI.WindowSize.Height)',
    );
    const text = await waitFor(
      screen,
      (value) => {
        const sizes = [...value.matchAll(/TESSERA_SIZE:(\d+)x(\d+)/g)];
        return (
          sizes.length >= 2 &&
          `${sizes.at(-1)?.[1]}x${sizes.at(-1)?.[2]}` !== `${sizeStart.value[1]}x${sizeStart.value[2]}`
        );
      },
      "resized console grid",
    );
    const sizes = [...text.matchAll(/TESSERA_SIZE:(\d+)x(\d+)/g)];
    const after = sizes.at(-1);
    return `${sizeStart.value[1]}x${sizeStart.value[2]} -> ${after?.[1]}x${after?.[2]}`;
  });

  return echo;
}

async function runIndependentChecks() {
  await runStep("taskbar progress states and main-window focus commands", async () => {
    for (const state of ["normal", "error", "paused", "indeterminate", "none"]) {
      await invoke("window_set_progress", { state, value: 42 });
    }
    await invoke("window_focus_main");
  });

  await runStep("secure keyboard entry is absent on Windows", async () => {
    const secureState = await invoke("secure_keyboard_entry_state");
    const secureSet = await invoke("secure_keyboard_entry_set", { enabled: true });
    if (secureState?.status !== "unsupported" || secureSet?.status !== "unsupported") {
      throw new Error(JSON.stringify({ secureState, secureSet }));
    }
    return JSON.stringify({ secureState, secureSet });
  });

  await runStep("About displays real app_info", async () => {
    await openAbout();
    const details = await waitFor(
      () => page.locator("[role=dialog] dd").allInnerTexts(),
      (items) => Array.isArray(items) && items.length >= 5,
      "real About app_info response",
    );
    if (!details.includes("Tessera") || !details.includes("0.1.0")) {
      throw new Error(`About did not display real app_info details: ${JSON.stringify(details)}`);
    }
    await page.keyboard.press("Escape");
    await waitFor(
      () => page.locator("[role=dialog]").count(),
      (count) => count === 0,
      "About dialog close",
    );
    return JSON.stringify(details);
  });

  await runStep("light real-window screenshot", async () => {
    await setAppearance("light");
    await screenshot("real-window-light.png");
  });
  await runStep("dark real-window screenshot", async () => {
    await setAppearance("dark");
    await screenshot("real-window-dark.png");
  });

  const split = await runStep("create second terminal pane", async () => {
    await page.keyboard.press("Control+Shift+D");
    await waitFor(
      () => page.locator(".xterm-rows").count(),
      (count) => count === 2,
      "second terminal pane",
    );
  });
  await runStep("closing a pane terminates its PowerShell session", async () => {
    if (!split.passed) throw new Error("Skipped because the second terminal pane was not created");
    const pidText = await typeUntil(
      'Write-Output ("TESSERA_PID:" + $PID)',
      (text) => /TESSERA_PID:\d+/.test(text),
      "second shell PID",
    );
    const pid = Number(pidText.match(/TESSERA_PID:(\d+)/)?.[1]);
    if (!pid) throw new Error("Could not parse the second shell PID");
    await page.keyboard.press("Control+Shift+W");
    await waitFor(
      () => page.locator(".xterm-rows").count(),
      (count) => count === 1,
      "second pane close",
    );
    await waitFor(() => checkProcessStopped(pid), Boolean, "closed pane process exit", 10_000, 1_000);
    return String(pid);
  });
}

// Owner checks: the four items that used to need a human at the window (M3.4 restore, M4.3 native menu, M5.2 and
// M5.3 project and task lifecycle on the real backend). They run after the shell checks, restore last because it
// quits and relaunches the app.
function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function count(locator, expected, label, timeout = 30_000) {
  await waitFor(
    () => locator.count(),
    (n) => n === expected,
    `${label} (count ${expected})`,
    timeout,
  );
}

async function closeAnyExitedOverlay() {
  // "exit 7" left the first pane exited; Enter respawns it so the layout is a normal two-pane one for restore.
  // Panes of other workspaces stay mounted but hidden: click only the visible buttons.
  const restart = page.getByRole("button", { name: /restart/i });
  for (const button of await restart.all()) {
    // A toast (task deleted, shell stopped) may sit over the button and swallow a pointer click.
    if (await button.isVisible()) await button.dispatchEvent("click");
  }
}

async function runOwnerChecks() {
  await runStep("native menu is built from the action registry (menu_list)", async () => {
    const ids = await waitFor(
      () => invoke("menu_list"),
      (list) => Array.isArray(list) && list.length > 10,
      "menu ids",
    );
    for (const id of ["tab.new", "pane.splitRight", "tab.close"]) {
      if (!ids.includes(id)) throw new Error(`menu is missing ${id}; has ${ids.length} items`);
    }
    return `${ids.length} actions in the native menu`;
  });

  const repo = resolve(tmpdir(), `tessera-smoke-repo-${process.pid}`);
  let worktree = null;
  const tree = page.getByRole("tree", { name: "Projects and tasks" });
  const taskRow = (name) => tree.getByRole("treeitem", { name: new RegExp(`^${name},`) });

  const project = await runStep("add a real git repository as a project", async () => {
    await rm(repo, { recursive: true, force: true });
    await mkdir(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "smoke@example.com");
    git(repo, "config", "user.name", "Smoke");
    await writeFile(resolve(repo, "README.md"), "smoke\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-q", "-m", "first");
    // A window narrower than 760 px keeps the sidebar closed: open it first.
    if ((await page.getByRole("button", { name: "Add project" }).count()) === 0) {
      await page
        .getByRole("button", { name: /toggle sidebar/i })
        .first()
        .click();
    }
    await page.getByRole("button", { name: "Add project" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add project" });
    await dialog.getByRole("textbox", { name: "Folder path" }).fill(repo);
    await dialog.getByRole("button", { name: "Add project" }).click();
    await count(dialog, 0, "add-project dialog closes");
    await count(tree.getByRole("treeitem", { name: /^tessera-smoke-repo/, level: 1 }), 1, "project row");
    return repo;
  });

  const created = await runStep("create a task: worktree and branch appear on disk, task tab opens", async () => {
    if (!project.passed) throw new Error("Skipped because the project was not added");
    await page.keyboard.press("Control+Alt+Shift+N");
    const dialog = page.getByRole("dialog", { name: "New task" });
    await count(dialog, 1, "new-task dialog");
    await dialog.getByRole("textbox", { name: "Task name" }).fill("Smoke task");
    await dialog.getByRole("combobox", { name: "Base branch" }).fill("main");
    await dialog.getByRole("button", { name: "Create task" }).click();
    await count(dialog, 0, "new-task dialog closes", 60_000);
    await count(taskRow("Smoke task"), 1, "task row");
    // The backend chooses the worktree folder (app data, per project): read it back from git itself.
    const list = await waitFor(
      () => git(repo, "worktree", "list", "--porcelain"),
      (text) => /branch refs\/heads\/tessera\/smoke-task/.test(text),
      "worktree listed by git",
      60_000,
      500,
    );
    const block = list.split(/\n\n/).find((entry) => entry.includes("tessera/smoke-task")) ?? "";
    worktree = block.match(/^worktree (.+)$/m)?.[1] ?? null;
    if (!worktree) throw new Error(`worktree path missing in: ${list}`);
    await waitFor(() => exists(worktree), Boolean, "worktree folder", 30_000, 500);
    await count(page.getByRole("tab", { name: /Smoke task/ }), 1, "task tab");
    return worktree;
  });

  await runStep("archive, restore and delete the task (worktree removed)", async () => {
    if (!created.passed) throw new Error("Skipped because the task was not created");
    await taskRow("Smoke task").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Archive task" }).click();
    await count(taskRow("Smoke task"), 0, "task archived");
    const archived = tree.getByRole("treeitem", { name: /^Archived/ });
    await count(archived, 1, "archived section");
    await archived.click();
    await count(taskRow("Smoke task"), 1, "task in archived section");
    await taskRow("Smoke task").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Restore task" }).click();
    await count(tree.getByRole("treeitem", { name: /^Archived/ }), 0, "archived section gone");
    await taskRow("Smoke task").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete task" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete task" }).click();
    await count(taskRow("Smoke task"), 0, "task deleted");
    await waitFor(async () => !(await exists(worktree)), Boolean, "worktree removed", 30_000, 500);
    const list = git(repo, "worktree", "list", "--porcelain");
    if (/smoke-task/.test(list)) throw new Error(`worktree still listed: ${list}`);
  });

  // M3.5: the global hotkey cannot be pressed over CDP (it never reaches the OS), so the step checks that it was
  // registered and drives the same toggle the hotkey calls.
  await runStep("quick terminal: full-width top window with a shell, toggles shut", async () => {
    const log = output.join("");
    if (!/quick terminal hotkey registered/.test(log)) throw new Error("the quick terminal hotkey was not registered");
    await invoke("quick_terminal_toggle");
    await waitFor(() => invoke("quick_terminal_visible"), Boolean, "quick terminal visible", 30_000, 250);
    const label = (candidate) =>
      candidate.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null);
    const quick = await waitFor(
      async () => {
        for (const candidate of browser.contexts().flatMap((context) => context.pages())) {
          if ((await label(candidate)) === "quick") return candidate;
        }
        return null;
      },
      Boolean,
      "quick terminal page over CDP",
      60_000,
      500,
    );
    const geometry = await waitFor(
      () =>
        quick.evaluate(() => ({
          y: window.screenY,
          width: window.outerWidth,
          height: window.outerHeight,
          screenWidth: screen.availWidth,
          screenHeight: screen.availHeight,
          screenTop: screen.availTop ?? 0,
        })),
      (g) =>
        Math.abs(g.width - g.screenWidth) <= 2 &&
        Math.abs(g.y - g.screenTop) <= 2 &&
        Math.abs(g.height / g.screenHeight - 0.4) < 0.05,
      "quick terminal at the top, full width, 40% high",
      10_000,
      250,
    );
    await waitFor(
      () => quick.locator(".xterm-rows").evaluateAll((rows) => rows.map((row) => row.innerText).join("\n")),
      (text) => /PS\s+[A-Z]:\\/i.test(text),
      "quick terminal PowerShell prompt",
      90_000,
    );
    // Focus settles after a show; hide-on-blur must not throw the window away at once.
    await new Promise((done) => setTimeout(done, 1_500));
    if (!(await invoke("quick_terminal_visible"))) throw new Error("the quick terminal hid itself right after showing");
    await invoke("quick_terminal_toggle");
    await waitFor(
      () => invoke("quick_terminal_visible"),
      (visible) => visible === false,
      "quick terminal hidden",
      10_000,
      250,
    );
    return JSON.stringify(geometry);
  });

  await runStep("restore after restart: shells survive the quit and re-attach (session daemon)", async () => {
    await closeAnyExitedOverlay();
    await page.keyboard.press("Escape"); // closes the narrow window's sidebar overlay if the project steps left it open
    const splitRight = page.getByRole("button", { name: "Split right" });
    if (await splitRight.isDisabled()) {
      // The selected workspace has no tab (the deleted task's): open one first.
      await page.keyboard.press("Control+Shift+T");
      await waitFor(
        () => splitRight.isDisabled(),
        (disabled) => !disabled,
        "a tab to split",
      );
    }
    const panes = page.locator("[data-pane-id]");
    const before = await panes.count();
    await splitRight.click();
    await count(panes, before + 1, "one more pane after the split");
    await typeUntil(
      "echo mk7",
      (text) => (text.replace(/\s+/g, "").match(/mk7/g) || []).length >= 2,
      "echo before quit",
    );
    // M8: with the session daemon this shell must outlive the app.
    const pidText = await typeUntil(
      'Write-Output ("TESSERA_PID:" + $PID)',
      (text) => /TESSERA_PID:\d+/.test(text),
      "shell PID before quit",
    );
    const shellPid = Number(pidText.match(/TESSERA_PID:(\d+)/)?.[1]);
    await new Promise((done) => setTimeout(done, 1_500)); // layout autosave (500 ms debounce)
    await invoke("window_close", { id: "main" });
    await Promise.race([
      appExited,
      new Promise((_, reject) => setTimeout(() => reject(new Error("app did not quit")), 20_000)),
    ]);
    try {
      await browser?.close();
    } catch {
      // the browser went away with the app
    }
    await new Promise((done) => setTimeout(done, 1_000));
    if (!shellPid || (await checkProcessStopped(shellPid))) {
      throw new Error(`the shell (PID ${shellPid}) ended with the app; the session daemon did not keep it`);
    }
    await launchApp();
    await waitFor(
      () => page.locator(".xterm-helper-textarea").count(),
      (n) => n >= 1,
      "terminal after relaunch",
      60_000,
    );
    await count(page.locator("[data-pane-id]"), before + 1, "panes restored", 30_000);
    const all = await page.locator(".xterm-rows").evaluateAll((rows) => rows.map((r) => r.innerText).join("\n"));
    if (!all.replace(/\s+/g, "").includes("mk7")) throw new Error("restored scrollback does not show the marker");
    if (!all.includes(`TESSERA_PID:${shellPid}`))
      throw new Error("the re-attached pane did not replay its shell's output");
    if (await checkProcessStopped(shellPid)) throw new Error("the re-attached shell is gone");
    return `${before + 1} panes restored; PowerShell ${shellPid} survived the quit and was re-attached`;
  });
}

async function run() {
  const attached = await runStep("launch and attach to Tessera", async () => {
    await launchApp();
    return "CDP attached; visible-window overlay requested";
  });
  if (!attached.passed) {
    for (const name of [
      "navigator.webdriver is false",
      "collect CDP startup diagnostics",
      "window appears",
      "PowerShell prompt",
      "typed echo tessera-ok",
      "initial console size",
      "resize changes PowerShell grid",
      "exit 7 shows the exit overlay",
      "taskbar progress states and main-window focus commands",
      "secure keyboard entry is absent on Windows",
      "About displays real app_info",
      "light real-window screenshot",
      "dark real-window screenshot",
      "create second terminal pane",
      "closing a pane terminates its PowerShell session",
    ]) {
      record(name, `failed: prerequisite failed: ${attached.error}`);
    }
    return;
  }

  await runStep("navigator.webdriver is false", async () => {
    const webdriver = await page.evaluate(() => navigator.webdriver);
    if (webdriver) throw new Error("Native adapters would be disabled");
  });
  await runStep("collect CDP startup diagnostics", async () => collectDiagnostics());
  await runStep("window appears", async () => {
    await waitFor(() => page.locator(".xterm-helper-textarea").count(), Boolean, "terminal window");
    await invoke("window_focus_main");
  });
  const shell = await runShellChecks();
  await runIndependentChecks();
  await runStep("exit 7 shows the exit overlay", async () => {
    if (!shell.passed) throw new Error("Skipped because the PowerShell prompt or echo failed");
    await typeCommand("exit 7");
    await waitFor(
      () => page.locator("body").innerText(),
      (text) => text.includes("Process exited with code 7."),
      "exit code overlay",
    );
  });
  await runOwnerChecks();
}

/** The session daemon outlives the app by design; stop it so the runner is clean and nothing holds our pipes. */
async function stopSessionDaemon() {
  if (process.platform !== "win32") return;
  const killer = spawn("taskkill.exe", ["/IM", "tesserad.exe", "/T", "/F"], {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
  });
  await Promise.race([
    new Promise((done) => killer.once("close", done)),
    new Promise((done) => setTimeout(done, 10_000)),
  ]);
}

async function stopApp() {
  if (appProcess && process.platform === "win32") {
    try {
      const killer = spawn("taskkill.exe", ["/PID", String(appProcess.pid), "/T", "/F"], {
        cwd: root,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const killOutput = [];
      killer.stdout.on("data", (chunk) => killOutput.push(chunk.toString()));
      killer.stderr.on("data", (chunk) => killOutput.push(chunk.toString()));
      const code = await new Promise((done) => {
        killer.once("error", (error) => {
          killOutput.push(error.message);
          done(1);
        });
        killer.once("close", done);
      });
      output.push(`taskkill exit=${code}: ${killOutput.join("").trim()}\n`);
      await Promise.race([appExited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    } catch (error) {
      output.push(`taskkill cleanup failed (ignored): ${error.message}\n`);
    }
  } else if (page && appProcess && appProcess.exitCode === null && appProcess.signalCode === null) {
    try {
      await invoke("window_close", { id: "main" });
    } catch (error) {
      output.push(`graceful app close: ${error.message}\n`);
    }
  }

  if (appProcess && appProcess.exitCode === null && appProcess.signalCode === null) {
    try {
      appProcess.kill();
      await Promise.race([appExited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    } catch (error) {
      output.push(`app process cleanup: ${error.message}\n`);
    }
  }

  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      output.push(`CDP disconnect: ${error.message}\n`);
    }
  }

  await stopSessionDaemon();

  try {
    await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (error) {
    output.push(`profile cleanup failed (ignored): ${error.message}\n`);
  }
}

async function main() {
  try {
    await mkdir(artifactDir, { recursive: true });
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record("smoke harness", `failed: ${message}`);
  } finally {
    await reportTerminalVerdict();
    await collectFinalPageState();
    try {
      await stopApp();
    } catch (error) {
      output.push(`cleanup failed (ignored): ${error instanceof Error ? error.message : String(error)}\n`);
    }
    const finalOutput = output.join("");
    try {
      await writeFile(appLog, finalOutput);
      if (diagnostics) {
        diagnostics.terminalVerdict = terminalVerdict;
        diagnostics.consoleMessages = consoleMessages;
        diagnostics.pageErrors = pageErrors;
        diagnostics.appOutput = finalOutput;
        try {
          diagnostics.benchmarkEvents = await readFile(telemetryPath, "utf8");
        } catch (error) {
          diagnostics.benchmarkEventsError = error.message;
        }
        await writeFile(resolve(artifactDir, "diagnostics.json"), `${JSON.stringify(diagnostics, null, 2)}\n`);
      }
      const failed = steps.some((step) => step.result.startsWith("failed:"));
      await writeFile(
        resolve(artifactDir, "smoke-results.json"),
        `${JSON.stringify(
          {
            date: new Date().toISOString(),
            app,
            debuggerUrl,
            completed: !failed,
            terminalVerdict,
            steps,
            diagnostics: diagnostics ? "artifacts/windows/diagnostics.json" : null,
            appLog: "artifacts/windows/app-output.log",
          },
          null,
          2,
        )}\n`,
      );
      if (failed) process.exitCode = 1;
    } catch (error) {
      console.error(`[windows-smoke] failed to write results: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    }
  }
}

await main();
// Child processes the app started (the session daemon) inherit its output pipes on Windows and would keep this script
// alive after the results are written: exit explicitly.
process.exit(process.exitCode ?? 0);
