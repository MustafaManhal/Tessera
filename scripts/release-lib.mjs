// Release helpers (M12.3): the installer size check and the update manifest. Pure functions so they are tested.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** NFR-05: an installer is at most 25 MB (decimal, as stores and download pages count). */
export const MAX_INSTALLER_BYTES = 25 * 1000 * 1000;

const INSTALLER = /\.(dmg|msi|exe)$/i;
/** The macOS bundler leaves `rw.<pid>.<name>.dmg` working images behind when it is interrupted; they are not installers. */
const WORKING_IMAGE = /^rw\.\d+\./;

/** Files under `dir` (recursive) that count as installers. */
export function installers(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) found.push(...installers(path));
    else if (INSTALLER.test(name) && !WORKING_IMAGE.test(name)) found.push({ path, bytes: stat.size });
  }
  return found;
}

/** The rows that are over the limit; an empty list when every installer is within NFR-05. */
export function oversized(files, limit = MAX_INSTALLER_BYTES) {
  return files.filter((file) => file.bytes > limit);
}

/**
 * Update manifest (`latest.json`) for tauri-plugin-updater from the signed update bundles of a release.
 * `assets` are `{ name, signature }` where `signature` is the content of the `.sig` file next to the bundle.
 * macOS: the universal `.app.tar.gz` answers for both Mac architectures. Windows: the NSIS setup for each architecture.
 */
export function updateManifest({ version, notes, date, baseUrl, assets }) {
  const platforms = {};
  const url = (name) => `${baseUrl}/${encodeURIComponent(name)}`;
  for (const { name, signature } of assets) {
    const entry = { signature: signature.trim(), url: url(name) };
    if (/\.app\.tar\.gz$/i.test(name)) {
      if (/aarch64|arm64/i.test(name)) platforms["darwin-aarch64"] = entry;
      else if (/x64|x86_64/i.test(name)) platforms["darwin-x86_64"] = entry;
      else {
        platforms["darwin-aarch64"] = entry;
        platforms["darwin-x86_64"] = entry;
      }
    } else if (/-setup\.exe$/i.test(name)) {
      if (/arm64|aarch64/i.test(name)) platforms["windows-aarch64"] = entry;
      else platforms["windows-x86_64"] = entry;
    }
  }
  if (Object.keys(platforms).length === 0) throw new Error("no update bundles among the assets");
  return { version, notes, pub_date: date, platforms };
}

/** Reads `<file>.sig` next to each update bundle in `dir` (recursive). */
export function signedAssets(dir) {
  const assets = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".sig")) assets.push({ name: name.slice(0, -4), signature: readFileSync(path, "utf8") });
    }
  };
  walk(dir);
  return assets;
}

/** How many releases the update manifest's notes cover: apps older than 0.1.18 show all of them as plain text. */
export const UPDATE_NOTES_RELEASES = 5;

/** The releases in `apps/desktop/src/updates/whatsnew.ts`, newest first, as `{ version, date, highlights }`. */
export function whatsNewReleases(source) {
  const releases = [];
  const block = /version: "([^"]+)",\s*date: "([^"]+)",\s*highlights: \[([\s\S]*?)\n\s*\],/g;
  for (const match of source.matchAll(block)) {
    const highlights = [...match[3].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
    releases.push({ version: match[1], date: match[2], highlights });
  }
  return releases;
}

/**
 * The notes in the update manifest: one section per release, newest first, from `version` back over `count`
 * releases. Plain text, because apps before 0.1.18 show the notes as they are; newer apps parse the sections
 * (`parseUpdateNotes` in whatsnew.ts) and show only the releases after the installed one.
 */
export function updateNotes(releases, version, count = UPDATE_NOTES_RELEASES) {
  const at = releases.findIndex((release) => release.version === version);
  if (at === -1) return `Tessera ${version}`;
  return releases
    .slice(at, at + count)
    .map(
      (release) =>
        `Tessera ${release.version} (${release.date})\n${release.highlights.map((line) => `- ${line}`).join("\n")}`,
    )
    .join("\n\n");
}
