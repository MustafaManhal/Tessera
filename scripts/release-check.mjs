// `node scripts/release-check.mjs [--full]`: runs the mechanical rows of the v1 release check (docs/release-check.md)
// and prints a table of pass, fail and manual. Quick by default (versions, notes, licences, network audit, updater
// key, size of existing installers); `--full` also runs `pnpm check` and `pnpm test:ui`.
// Exit code 1 when a mechanical row fails; manual rows never fail the run.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installers, oversized } from "./release-lib.mjs";
import { scan } from "./network-audit.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const json = (path) => JSON.parse(read(path));

/** The version in each place that carries one. Exported for the test. */
export function versions(files) {
  const cargo = /^version\s*=\s*"([^"]+)"/m.exec(files.cargo)?.[1];
  return { tauri: JSON.parse(files.tauri).version, cargo, package: JSON.parse(files.package).version };
}

export function notesEntryFor(version, whatsnew) {
  return new RegExp(`version:\\s*"${version.replace(/\./g, "\\.")}"`).test(whatsnew);
}

function sh(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  return result.status === 0;
}

export function rows({ full = false } = {}) {
  const out = [];
  const add = (id, text, status, detail = "") => out.push({ id, text, status, detail });
  const v = versions({
    cargo: read("Cargo.toml"),
    tauri: read("apps/desktop/src-tauri/tauri.conf.json"),
    package: read("apps/desktop/package.json"),
  });
  const same = v.tauri === v.cargo && v.cargo === v.package;
  add(
    "version",
    "One version in tauri.conf.json, Cargo.toml and the desktop package.json",
    same ? "pass" : "fail",
    JSON.stringify(v),
  );
  add(
    "notes",
    "What's new has an entry for this version",
    notesEntryFor(v.tauri, read("apps/desktop/src/updates/whatsnew.ts")) ? "pass" : "fail",
    v.tauri,
  );
  const licenses = existsSync(join(root, "apps/desktop/src/about/licenses.json"))
    ? json("apps/desktop/src/about/licenses.json")
    : [];
  add(
    "licenses",
    "Licence list generated (node scripts/licenses.mjs)",
    licenses.length > 100 ? "pass" : "fail",
    `${licenses.length} packages`,
  );
  const violations = scan(root);
  add(
    "network",
    "Network audit: only update, integration and sync traffic (NFR-08)",
    violations.length === 0 ? "pass" : "fail",
    violations[0] ?? "",
  );
  const updater = json("apps/desktop/src-tauri/tauri.conf.json").plugins?.updater;
  add(
    "updater",
    "Updater public key and endpoint are set",
    updater?.pubkey && updater?.endpoints?.length > 0 ? "pass" : "fail",
    updater?.endpoints?.[0] ?? "",
  );
  const bundle = join(root, "target/release/bundle");
  if (existsSync(bundle)) {
    const files = installers(bundle);
    add(
      "size",
      "Installers built here are at most 25 MB (NFR-05)",
      files.length > 0 && oversized(files).length === 0 ? "pass" : files.length === 0 ? "manual" : "fail",
      `${files.length} installers`,
    );
  } else
    add(
      "size",
      "Installers are at most 25 MB (NFR-05)",
      "manual",
      "run pnpm release:dry-run or the Package check workflow",
    );
  if (full) {
    add(
      "check",
      "pnpm check (format, lint, types, unit tests, Rust fmt, clippy, release lint, Rust tests)",
      sh("pnpm", ["check"]) ? "pass" : "fail",
    );
    add("ui", "pnpm test:ui (browser UI tests with the fakes)", sh("pnpm", ["test:ui"]) ? "pass" : "fail");
  } else {
    add("check", "pnpm check", "manual", "run with --full");
    add("ui", "pnpm test:ui", "manual", "run with --full");
  }
  // Rows that need a person, a Windows machine or a published release.
  add(
    "bench-mac",
    "NFR-01 to NFR-04, NFR-06, NFR-13 measured on macOS (docs/performance.md)",
    "manual",
    "pnpm bench:*, numbers in docs/performance.md",
  );
  add("bench-win", "The same on Windows (Windows 5 workflow run)", "manual", "see the run summary");
  add(
    "win-proof",
    "Every Must FR works on Windows in the running app (Windows 1, 3, 4, 6 workflows green)",
    "manual",
    "latest runs",
  );
  add("a11y-ear", "Screen reader checks by ear (docs/accessibility.md)", "manual", "VoiceOver and NVDA");
  add(
    "installers",
    "Installers build for macOS universal and Windows x64 and arm64 (Package check workflow)",
    "manual",
    "latest run",
  );
  add(
    "update",
    "An update from the previous build installs and the app restarts into it",
    "manual",
    "see docs/release-check.md, update test",
  );
  add("week", "One week of daily use as the main terminal, at least 5 agents a day", "manual", "the owner");
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = rows({ full: process.argv.includes("--full") });
  const mark = { pass: "PASS  ", fail: "FAIL  ", manual: "manual" };
  for (const row of result) console.log(`${mark[row.status]}  ${row.text}${row.detail ? `  (${row.detail})` : ""}`);
  const failed = result.filter((row) => row.status === "fail");
  console.log(
    `\n${result.filter((r) => r.status === "pass").length} pass, ${failed.length} fail, ${result.filter((r) => r.status === "manual").length} manual`,
  );
  process.exit(failed.length > 0 ? 1 : 0);
}
