// Writes the third-party licence list shown in About (apps/desktop/src/about/licenses.json): every Rust crate the
// desktop app depends on (`cargo metadata`, resolved for the app only) and every production npm package of the front
// end (`pnpm licenses list`). Run it before a release: `node scripts/licenses.mjs`. No network needed.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
};

export function rustPackages(metadata) {
  const resolved = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const app = metadata.packages.find((p) => p.name === "tessera-desktop");
  const seen = new Set();
  const queue = [app.id];
  while (queue.length > 0) {
    const id = queue.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of resolved.get(id)?.deps ?? []) {
      // Normal (not dev or build-only) dependencies are what ships.
      if (dep.dep_kinds.some((kind) => kind.kind === null)) queue.push(dep.pkg);
    }
  }
  return metadata.packages
    .filter((p) => seen.has(p.id) && p.source !== null)
    .map((p) => ({ name: p.name, version: p.version, license: p.license ?? "See the crate", source: "rust" }));
}

export function npmPackages(listing) {
  const out = [];
  for (const [license, packages] of Object.entries(listing)) {
    for (const p of packages)
      for (const version of p.versions ?? [p.version]) out.push({ name: p.name, version, license, source: "npm" });
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const metadata = JSON.parse(run("cargo", ["metadata", "--format-version", "1", "--locked"]));
  const npm = JSON.parse(run("pnpm", ["licenses", "list", "--prod", "--json"], `${root}apps/desktop`));
  const all = [...rustPackages(metadata), ...npmPackages(npm)];
  all.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const unique = all.filter(
    (p, i) =>
      i === 0 || p.name !== all[i - 1].name || p.version !== all[i - 1].version || p.source !== all[i - 1].source,
  );
  writeFileSync(`${root}apps/desktop/src/about/licenses.json`, `${JSON.stringify(unique)}\n`);
  console.log(`${unique.length} packages written`);
}
