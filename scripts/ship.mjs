#!/usr/bin/env node
// One command from a committed fix to a published release.
//
//   pnpm ship              next patch (0.1.2 -> 0.1.3)
//   pnpm ship minor        next minor (0.1.2 -> 0.2.0)
//   pnpm ship 0.1.7        an exact version
//   pnpm ship --dry        do everything up to the push, change nothing outside this checkout
//
// Steps: raise the version, write the What's new entry from the commit subjects since the last release (when it is
// not written already), `pnpm check`, commit, push the private branches, export to the public repository, run the
// Release workflow, wait for it, check the draft's files and latest.json, publish it as the latest release.
// It stops at the first problem and says what to do; running it again continues (a version that is already raised
// or an entry that already exists is kept, an existing draft is reused).
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_REPO = "MustafaManhal/Tessera";
const PUBLIC_REMOTE = `git@github.com:${PUBLIC_REPO}.git`;
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const skipCheck = args.includes("--skip-check");
const bumpArg = args.find((a) => !a.startsWith("--")) ?? "patch";

const TRAILER = "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"; // scan:allow (commit trailer, not a private address)
const say = (text) => console.log(`\n▶ ${text}`);
const fail = (text) => {
  console.error(`\n✖ ${text}`);
  process.exit(1);
};
const run = (cmd, argv, options = {}) =>
  execFileSync(cmd, argv, {
    cwd: root,
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "pipe", "inherit"] : "inherit",
    ...options,
  });
const out = (cmd, argv) =>
  execFileSync(cmd, argv, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- version ----------------------------------------------------------------------------------------------------

const cargoPath = join(root, "Cargo.toml");
const current = /^version = "(\d+\.\d+\.\d+)"/m.exec(readFileSync(cargoPath, "utf8"))?.[1];
if (!current) fail("Cannot read the version from Cargo.toml.");
const [major, minor, patch] = current.split(".").map(Number);
let next;
if (/^\d+\.\d+\.\d+$/.test(bumpArg)) next = bumpArg;
else if (bumpArg === "minor") next = `${major}.${minor + 1}.0`;
else if (bumpArg === "major") next = `${major + 1}.0.0`;
else if (bumpArg === "patch") next = `${major}.${minor}.${patch + 1}`;
else fail(`Unknown version "${bumpArg}". Use patch, minor, major or X.Y.Z.`);

// `--continue` resumes after a failure: the version is already raised in the files, so it is kept.
const headSubject = out("git", ["log", "-1", "--format=%s"]);
const publishedCurrent = (() => {
  try {
    return (
      out("gh", ["release", "view", `v${current}`, "--repo", PUBLIC_REPO, "--json", "isDraft", "-q", ".isDraft"]) ===
      "false"
    );
  } catch {
    return false;
  }
})();
// A release commit that was never published (a dry run, or a failure after it) is picked up again.
const resumed = args.includes("--continue") || (headSubject === `release: ${current}` && !publishedCurrent);
if (resumed) next = current;
const tag = `v${next}`;
say(`Release ${tag} (was ${current})`);

// --- preconditions ----------------------------------------------------------------------------------------------

const branch = out("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
const dirty = out("git", ["status", "--porcelain"]);
if (dirty && !resumed)
  fail("There are uncommitted changes. Commit them first (git add -A && git commit), then run pnpm ship again.");
try {
  out("gh", ["auth", "status"]);
} catch {
  fail("The GitHub CLI is not signed in. Run: gh auth login");
}
const releasedAlready = (() => {
  try {
    return out("gh", ["release", "view", tag, "--repo", PUBLIC_REPO, "--json", "isDraft", "-q", ".isDraft"]);
  } catch {
    return null;
  }
})();
if (releasedAlready === "false") fail(`${tag} is already published. Pick a higher version.`);

// --- version files and What's new -------------------------------------------------------------------------------

function replaceOnce(file, pattern, replacement) {
  const path = join(root, file);
  const before = readFileSync(path, "utf8");
  const after = before.replace(pattern, replacement);
  if (before === after && !before.match(pattern)) fail(`Could not find the version in ${file}.`);
  writeFileSync(path, after);
}

function lastReleaseCommit() {
  try {
    return out("git", ["log", "--format=%H", "--grep=^release: ", "-1"]);
  } catch {
    return "";
  }
}

function highlightsFromCommits() {
  const since = lastReleaseCommit();
  const range = since ? [`${since}..HEAD`] : ["-30"];
  const subjects = out("git", ["log", ...range, "--format=%s", "--no-merges"])
    .split("\n")
    .filter(Boolean);
  const lines = [];
  for (const subject of subjects) {
    const match = /^(feat|fix|perf)(\([^)]*\))?:\s*(.+)$/.exec(subject);
    if (!match) continue;
    if (/\btests?\b|\bCI\b/i.test(match[3])) continue; // test and CI changes are not release notes
    const text = match[3].replace(/\.$/, "");
    lines.push(text.charAt(0).toUpperCase() + text.slice(1) + ".");
  }
  return lines;
}

const whatsnewPath = join(root, "apps/desktop/src/updates/whatsnew.ts");
let whatsnew = readFileSync(whatsnewPath, "utf8");
let notes;
if (!whatsnew.includes(`version: "${next}"`)) {
  const highlights = highlightsFromCommits();
  if (highlights.length === 0) fail("No fix: or feat: commits since the last release, so there is nothing to release.");
  const date = new Date().toISOString().slice(0, 10);
  const entry = `  {\n    version: "${next}",\n    date: "${date}",\n    highlights: [\n${highlights.map((h) => `      ${JSON.stringify(h)},`).join("\n")}\n    ],\n  },\n`;
  whatsnew = whatsnew.replace(
    "export const RELEASES: ReleaseNotes[] = [\n",
    `export const RELEASES: ReleaseNotes[] = [\n${entry}`,
  );
  writeFileSync(whatsnewPath, whatsnew);
  say(
    `What's new entry written from ${highlights.length} commit(s). Edit apps/desktop/src/updates/whatsnew.ts and run again to reword.`,
  );
  notes = highlights;
} else {
  const block = new RegExp(
    `version: "${next.replaceAll(".", "\\.")}"[\\s\\S]*?highlights: \\[([\\s\\S]*?)\\n    \\]`,
  ).exec(whatsnew);
  notes = [...(block?.[1] ?? "").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
}

if (!resumed) {
  say("Raising the version");
  replaceOnce("Cargo.toml", /^version = "\d+\.\d+\.\d+"/m, `version = "${next}"`);
  replaceOnce("apps/desktop/src-tauri/tauri.conf.json", /"version": "\d+\.\d+\.\d+"/, `"version": "${next}"`);
  replaceOnce("apps/desktop/package.json", /"version": "\d+\.\d+\.\d+"/, `"version": "${next}"`);
  spawnSync("cargo", ["update", "--workspace", "--offline"], { cwd: root, stdio: "inherit" });
}

// --- checks, commit, push ---------------------------------------------------------------------------------------

if (!skipCheck) {
  say("pnpm check");
  const check = spawnSync("pnpm", ["check"], { cwd: root, stdio: "inherit" });
  if (check.status !== 0) fail("pnpm check failed. Fix it, commit, and run pnpm ship --continue.");
}
if (out("git", ["status", "--porcelain"])) {
  run("git", ["add", "-A"]);
  run("git", [
    "commit",
    "-q",
    "-m",
    `release: ${next}

${TRAILER}`,
  ]);
}
if (dry) {
  say(`Dry run: stopped before pushing. Release commit is ready for ${tag}; notes:`);
  for (const line of notes) console.log(`  - ${line}`);
  process.exit(0);
}
say("Pushing the private branches");
run("git", ["push", "-q", "origin", branch, `${branch}:worker-1`, `${branch}:worker-2`]);

say("Exporting to the public repository");
run("node", ["scripts/publish-public.mjs", "--push", PUBLIC_REMOTE]);

// --- the Release workflow ---------------------------------------------------------------------------------------

let runId;
if (releasedAlready === "true") {
  say(`A draft for ${tag} exists; reusing it`);
} else {
  say("Starting the Release workflow (about 30 minutes)");
  const startedAt = Date.now();
  run("gh", ["workflow", "run", "release.yml", "--repo", PUBLIC_REPO, "-f", `version=${tag}`, "-f", "channel=stable"]);
  for (let i = 0; i < 30 && !runId; i++) {
    await sleep(5000);
    const list = JSON.parse(
      out("gh", [
        "run",
        "list",
        "--repo",
        PUBLIC_REPO,
        "--workflow",
        "release.yml",
        "--limit",
        "5",
        "--json",
        "databaseId,createdAt,event",
      ]),
    );
    runId = list.find(
      (r) => r.event === "workflow_dispatch" && Date.parse(r.createdAt) >= startedAt - 60_000,
    )?.databaseId;
  }
  if (!runId) fail("The workflow did not start. Open the Actions tab of the public repository.");
  console.log(`  run ${runId}: https://github.com/${PUBLIC_REPO}/actions/runs/${runId}`);
  for (;;) {
    await sleep(20_000);
    const state = JSON.parse(
      out("gh", ["run", "view", String(runId), "--repo", PUBLIC_REPO, "--json", "status,conclusion"]),
    );
    if (state.status === "completed") {
      if (state.conclusion !== "success")
        fail(
          `The Release workflow ended with ${state.conclusion}. Read the log, fix, commit and run pnpm ship --continue.`,
        );
      break;
    }
  }
}

// --- verify and publish -----------------------------------------------------------------------------------------

say("Checking the draft");
const draft = JSON.parse(out("gh", ["release", "view", tag, "--repo", PUBLIC_REPO, "--json", "isDraft,assets"]));
const names = draft.assets.map((a) => a.name);
const required = [
  "latest.json",
  `Tessera_${next}_universal.dmg`,
  `Tessera_${next}_x64-setup.exe`,
  `Tessera_${next}_arm64-setup.exe`,
  `Tessera_${next}_x64_en-US.msi`,
  "Tessera.app.tar.gz",
  "Tessera.app.tar.gz.sig",
];
const missing = required.filter((name) => !names.includes(name));
if (missing.length) fail(`The draft is missing: ${missing.join(", ")}`);
const tmp = join(root, "target", "ship");
run("gh", ["release", "download", tag, "--repo", PUBLIC_REPO, "-p", "latest.json", "-D", tmp, "--clobber"], {
  quiet: true,
});
const manifest = JSON.parse(readFileSync(join(tmp, "latest.json"), "utf8"));
if (manifest.version !== next) fail(`latest.json says ${manifest.version}, expected ${next}.`);
if (Object.keys(manifest.platforms).length !== 4) fail("latest.json does not list all four platforms.");

say("Publishing");
const sha = runId
  ? JSON.parse(out("gh", ["run", "view", String(runId), "--repo", PUBLIC_REPO, "--json", "headSha"])).headSha
  : out("git", ["ls-remote", PUBLIC_REMOTE, "refs/heads/main"]).split("\t")[0];
const notesFile = join(tmp, "notes.md");
writeFileSync(
  notesFile,
  `## Tessera ${next}\n\n${notes.map((n) => `- ${n}`).join("\n")}\n\nmacOS builds are ad hoc signed, not notarized; Windows builds are unsigned for now. The app updates itself from Settings > Updates.\n`,
);
run("gh", [
  "release",
  "edit",
  tag,
  "--repo",
  PUBLIC_REPO,
  "--notes-file",
  notesFile,
  "--target",
  sha,
  "--title",
  `Tessera ${next}`,
]);
run("gh", ["release", "edit", tag, "--repo", PUBLIC_REPO, "--draft=false", "--latest"]);
const latest = out("gh", ["release", "view", "--repo", PUBLIC_REPO, "--json", "tagName", "-q", ".tagName"]);
if (latest !== tag) fail(`The latest release is ${latest}, not ${tag}.`);
say(`Done: https://github.com/${PUBLIC_REPO}/releases/tag/${tag}`);
