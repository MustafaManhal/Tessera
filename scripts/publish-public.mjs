#!/usr/bin/env node
// One-way export of this private workspace to the public open-source repo, with a fresh history.
//
//   node scripts/publish-public.mjs                      dry run: build the export, scan it, print the report
//   node scripts/publish-public.mjs --keep               dry run, keep the temp folder and print its path
//   node scripts/publish-public.mjs --push <git-url>     export, scan, commit once, force-push to <git-url> (branch main)
//
// Why not just make this repo public: its history holds the planning folder (`.ai/`), the agent playbooks and the
// early commits. The public repo gets only the current files, one commit, and a noreply identity.
//
// Left out: `.ai/`, `CLAUDE.md`, `AGENTS.md`, `.claude/`, `.agent-lead/`, `.env`, and anything git ignores (the export
// starts from `git ls-files`, so ignored files never enter). The scan fails the export when it finds a personal path,
// an e-mail address that is not a noreply address, or a secret-looking token.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const pushAt = args.includes("--push") ? args[args.indexOf("--push") + 1] : null;
if (args.includes("--push") && !pushAt) throw new Error("--push needs a git URL");

/** Path prefixes and names that never go public. */
export const EXCLUDED = [".ai/", ".claude/", ".agent-lead/", "CLAUDE.md", "AGENTS.md", ".env"];

/** The local account name is read at run time, so no personal string is written into this file. */
const USER = userInfo().username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Strings that must not appear in public files. Each entry: [label, RegExp]. */
export const FORBIDDEN = [
  ["personal home path", new RegExp(`/Users/${USER}|C:\\\\Users\\\\${USER}`, "i")],
  ["personal account name", new RegExp(`(?<!github\\.com/)(?<!\\d\\+)(?<!@)${USER}(?!/Tessera)`, "i")],
  [
    "private email",
    // `git@github.com` is the SSH user, and `user:secret@host` is URL credentials: neither is an e-mail address.
    /(?!git@github\.com)(?<![\w.+:-])[\w.+-]+@(?!users\.noreply\.github\.com|example\.(com|org)|noreply\.)[\w-]+\.(com|net|org|io)\b/i,
  ],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  [
    "token",
    /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[bp]-[A-Za-z0-9-]{10,})\b/,
  ],
];

/** Files whose content is data, not ours: skipped by the scan (theme collection, lock files). */
const SCAN_SKIP = [
  /pnpm-lock\.yaml$/,
  /Cargo\.lock$/,
  /iterm2-schemes\.json$/,
  /\.(png|ico|icns|ttf|woff2?|mp3|svg)$/i,
];

/** The allowed e-mail-like strings in tests and docs (fixtures such as `me@example.com` are fine). */
export function isExcluded(path) {
  return EXCLUDED.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
}

export function scanText(path, text) {
  const hits = [];
  text.split("\n").forEach((line, index) => {
    // A line marked `scan:allow` holds a fake secret on purpose (a redaction test fixture).
    if (line.includes("scan:allow")) return;
    for (const [label, pattern] of FORBIDDEN) {
      if (pattern.test(line)) hits.push({ path, line: index + 1, label, text: line.trim().slice(0, 100) });
    }
  });
  return hits;
}

function git(cwd, ...gitArgs) {
  return execFileSync("git", gitArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function main() {
  const files = git(root, "ls-files", "-z").split("\0").filter(Boolean);
  const included = files.filter((file) => !isExcluded(file) && existsSync(join(root, file)));
  const skipped = files.length - included.length;

  const out = mkdtempSync(join(tmpdir(), "tessera-public-"));
  const hits = [];
  for (const file of included) {
    const from = join(root, file);
    if (statSync(from).isDirectory()) continue;
    const to = join(out, file);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
    if (SCAN_SKIP.some((pattern) => pattern.test(file))) continue;
    const buffer = readFileSync(from);
    if (buffer.includes(0)) continue; // binary
    hits.push(...scanText(file, buffer.toString("utf8")));
  }

  console.log(`export: ${included.length} files copied, ${skipped} left out (${EXCLUDED.join(", ")})`);
  if (hits.length > 0) {
    console.log(`\nFAILED: ${hits.length} forbidden string(s) in the export:`);
    for (const hit of hits.slice(0, 40)) console.log(`  ${hit.path}:${hit.line} [${hit.label}] ${hit.text}`);
    rmSync(out, { recursive: true, force: true });
    process.exit(1);
  }
  console.log("scan: clean (no personal paths, private e-mails, keys or tokens)");

  if (!pushAt) {
    if (keep) console.log(`kept at ${out}`);
    else rmSync(out, { recursive: true, force: true });
    console.log("dry run only: nothing was pushed. Use --push <git-url> to publish.");
    return;
  }

  // A fresh repository: one commit, noreply identity taken from the first commit of this repo's author line.
  git(out, "init", "-q", "-b", "main");
  const noreply = git(root, "log", "-1", "--format=%ae").trim();
  if (!/@users\.noreply\.github\.com$/.test(noreply))
    throw new Error(`author e-mail is not a noreply address: ${noreply}`);
  const name = git(root, "log", "-1", "--format=%an").trim();
  git(out, "config", "user.name", name);
  git(out, "config", "user.email", noreply);
  git(out, "add", "-A");
  git(out, "commit", "-q", "-m", "Tessera: first public release");
  git(out, "remote", "add", "origin", pushAt);
  git(out, "push", "--force", "origin", "main");
  rmSync(out, { recursive: true, force: true });
  console.log(`pushed one commit to ${pushAt} (main)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
