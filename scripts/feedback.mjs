// Read what people sent from the app's feedback form (owner only: it uses your own Cloudflare login through wrangler).
//   node scripts/feedback.mjs list [--all]        new reports (all with --all)
//   node scripts/feedback.mjs show F-1a2b3c4d     the whole report; screenshots are saved to .ai/feedback/<id>/
//   node scripts/feedback.mjs done F-1a2b3c4d     mark it handled
// Reports are stored by the sync Worker (services/sync) in its D1 database `tessera-sync`.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const WRANGLER = "wrangler@4.154.0";
export const ID = /^F-[0-9a-f]{8}$/;

export function query(sql) {
  const out = execFileSync(
    "npx",
    ["--yes", WRANGLER, "d1", "execute", "tessera-sync", "--remote", "--json", "--command", sql],
    { cwd: join(root, "services/sync"), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  return parsed[0]?.results ?? [];
}

export function when(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}

function list(all) {
  const rows = query(
    `SELECT f.id, f.created_at, f.kind, f.title, f.status, f.app_version, f.os, (SELECT COUNT(*) FROM feedback_attachments a WHERE a.feedback_id = f.id) AS shots FROM feedback f ${all ? "" : "WHERE f.status = 'new'"} ORDER BY f.created_at DESC LIMIT 100`,
  );
  if (rows.length === 0) return console.log(all ? "no feedback yet" : "no new feedback");
  for (const r of rows)
    console.log(
      `${r.id}  ${when(r.created_at)}  ${r.kind.padEnd(6)} ${r.status.padEnd(5)} v${r.app_version} ${r.os}  ${r.shots} shot(s)  ${r.title}`,
    );
}

function show(id) {
  if (!ID.test(id)) throw new Error("the id looks like F-1a2b3c4d");
  const [f] = query(`SELECT * FROM feedback WHERE id = '${id}'`);
  if (!f) throw new Error(`no feedback ${id}`);
  const dir = join(root, ".ai/feedback", id);
  mkdirSync(dir, { recursive: true });
  const shots = query(
    `SELECT id, name, mime, data_base64 FROM feedback_attachments WHERE feedback_id = '${id}' ORDER BY id`,
  );
  const saved = shots.map((s, i) => {
    const ext = s.mime === "image/png" ? "png" : s.mime === "image/webp" ? "webp" : "jpg";
    const file = join(
      dir,
      `${i + 1}-${s.name.replace(/[^\w.-]/g, "_")}.${ext}`.replace(new RegExp(`\\.${ext}\\.${ext}$`), `.${ext}`),
    );
    writeFileSync(file, Buffer.from(s.data_base64, "base64"));
    return file;
  });
  const text = `# ${f.title}\n\n${id} · ${f.kind} · ${when(f.created_at)} · Tessera ${f.app_version} on ${f.os}\n${f.contact ? `Contact: ${f.contact}\n` : ""}\n${f.body}\n\n${saved.length ? `Screenshots:\n${saved.map((s) => `- ${s}`).join("\n")}\n\n` : ""}${f.report ? `## Technical details\n\n\`\`\`\n${f.report}\n\`\`\`\n` : ""}`;
  writeFileSync(join(dir, "report.md"), text);
  console.log(text);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, arg] = process.argv.slice(2);
  if (command === "list") list(arg === "--all");
  else if (command === "show") show(arg ?? "");
  else if (command === "done") {
    if (!ID.test(arg ?? "")) throw new Error("the id looks like F-1a2b3c4d");
    query(`UPDATE feedback SET status = 'done' WHERE id = '${arg}'`);
    console.log(`${arg} marked done`);
  } else console.log("usage: node scripts/feedback.mjs list [--all] | show <id> | done <id>");
}
