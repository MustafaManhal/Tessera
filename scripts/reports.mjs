// Read the automatic error reports and usage data the apps send (owner only: it uses your own Cloudflare login through
// wrangler, like scripts/feedback.mjs). Stored by the sync Worker (services/sync) in its D1 database `tessera-sync`.
//
//   node scripts/reports.mjs summary [--days 7]          crashes and errors grouped, newest first, with counts
//   node scripts/reports.mjs errors [--days 7] [--kind crash|error|warning] [--version 0.1.20] [--os windows]
//   node scripts/reports.mjs show R-1a2b3c4d5e6f-1         one event with its data, the batch's system and log tail
//   node scripts/reports.mjs install <install hash> [--limit 200]   everything one install sent, oldest first
//   node scripts/reports.mjs usage [--days 7]             the most used app actions and how many installs started
//   node scripts/reports.mjs done R-1a2b3c4d5e6f-1        mark an event handled (and every event like it)
import { query, when } from "./feedback.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const since = () => Date.now() - Number(opt("--days", "7")) * 86_400_000;
/** A value for SQL text: only the characters these filters can contain. */
const literal = (value) => `'${String(value).replace(/[^A-Za-z0-9._:-]/g, "")}'`;
const short = (text, max = 110) => {
  const one = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

function summary() {
  const rows = query(
    `SELECT kind, name, message, COUNT(*) AS n, COUNT(DISTINCT install_hash) AS installs, MAX(at) AS last,
       MIN(id) AS example, GROUP_CONCAT(DISTINCT app_version) AS versions, GROUP_CONCAT(DISTINCT os) AS systems
     FROM report_events WHERE kind IN ('crash','error') AND status = 'new' AND at >= ${since()}
     GROUP BY kind, name, substr(message, 1, 160) ORDER BY last DESC LIMIT 100`,
  );
  if (rows.length === 0) return console.log("No new crashes or errors.");
  for (const r of rows) {
    console.log(
      `${r.kind.padEnd(5)} ${String(r.n).padStart(4)}x ${String(r.installs).padStart(3)} installs  ${when(r.last)}  ` +
        `${r.name}: ${short(r.message)}\n      ${r.versions} on ${r.systems}  e.g. ${r.example}`,
    );
  }
}

function errors() {
  const filters = [`at >= ${since()}`];
  const kind = opt("--kind");
  filters.push(kind ? `kind = ${literal(kind)}` : "kind IN ('crash','error','warning')");
  if (opt("--version")) filters.push(`app_version = ${literal(opt("--version"))}`);
  if (opt("--os")) filters.push(`os = ${literal(opt("--os"))}`);
  const rows = query(
    `SELECT id, at, kind, name, message, app_version, os FROM report_events WHERE ${filters.join(" AND ")}
     ORDER BY at DESC LIMIT ${Number(opt("--limit", "100"))}`,
  );
  for (const r of rows) {
    console.log(`${r.id}  ${when(r.at)}  ${r.kind}  ${r.app_version} ${r.os}  ${r.name}: ${short(r.message, 140)}`);
  }
}

function show(id) {
  const [event] = query(`SELECT * FROM report_events WHERE id = ${literal(id)}`);
  if (!event) return console.log(`No event ${id}.`);
  const [batch] = query(`SELECT * FROM report_batches WHERE id = ${literal(event.batch_id)}`);
  console.log(`${event.id}  ${event.kind}  ${when(event.at)}\n${event.name}\n\n${event.message}\n`);
  try {
    console.log(JSON.stringify(JSON.parse(event.data), null, 2));
  } catch {
    console.log(event.data);
  }
  if (batch) {
    console.log(
      `\nTessera ${batch.app_version} (${batch.build}) on ${batch.os} ${batch.os_version} ${batch.arch}` +
        `\ninstall ${batch.install_hash}  session ${batch.session}`,
    );
    if (batch.log_tail) console.log(`\n--- log tail ---\n${batch.log_tail}`);
  }
}

function install(hash) {
  const rows = query(
    `SELECT id, at, kind, name, message, app_version FROM report_events WHERE install_hash = ${literal(hash)}
     ORDER BY at DESC LIMIT ${Number(opt("--limit", "200"))}`,
  ).reverse();
  for (const r of rows) {
    console.log(`${when(r.at)}  ${r.kind.padEnd(7)} ${r.app_version}  ${r.name}: ${short(r.message, 120)}  (${r.id})`);
  }
}

function usage() {
  const rows = query(`SELECT data FROM report_events WHERE kind = 'usage' AND at >= ${since()} LIMIT 5000`);
  const totals = new Map();
  for (const row of rows) {
    try {
      for (const [action, n] of Object.entries(JSON.parse(row.data))) {
        totals.set(action, (totals.get(action) ?? 0) + Number(n));
      }
    } catch {}
  }
  const [started] = query(
    `SELECT COUNT(*) AS runs, COUNT(DISTINCT install_hash) AS installs FROM report_events
     WHERE name = 'app_started' AND at >= ${since()}`,
  );
  console.log(`${started?.runs ?? 0} app starts from ${started?.installs ?? 0} installs\n`);
  for (const [action, n] of [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60)) {
    console.log(`${String(n).padStart(8)}  ${action}`);
  }
}

function done(id) {
  const [event] = query(`SELECT name, message FROM report_events WHERE id = ${literal(id)}`);
  if (!event) return console.log(`No event ${id}.`);
  const message = String(event.message).slice(0, 160).replace(/'/g, "''");
  const name = String(event.name).replace(/'/g, "''");
  query(`UPDATE report_events SET status = 'done' WHERE name = '${name}' AND substr(message, 1, 160) = '${message}'`);
  console.log(`Marked every "${short(event.name)}: ${short(event.message, 60)}" as done.`);
}

const [command, value] = args;
if (command === "summary" || command === undefined) summary();
else if (command === "errors") errors();
else if (command === "show" && value) show(value);
else if (command === "install" && value) install(value);
else if (command === "usage") usage();
else if (command === "done" && value) done(value);
else {
  console.error("usage: reports.mjs summary|errors|show <id>|install <hash>|usage|done <id>");
  process.exit(2);
}
