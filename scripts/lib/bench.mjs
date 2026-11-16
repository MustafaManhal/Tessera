/** Nearest-rank percentile, matching the Rust latency example. */
export function percentile(values, fraction) {
  if (
    !values.length ||
    !Number.isFinite(fraction) ||
    fraction < 0 ||
    fraction > 1 ||
    values.some((v) => !Number.isFinite(v))
  ) {
    throw new Error("Invalid percentile input");
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
/** Parse the documented throughput example output; reject missing/truncated/zero results. */
export function parseThroughput(output) {
  const match = output.match(/(\d+) bytes in ([\d.]+) s: ([\d.]+) MiB\/s \(exit (\d+)\)/);
  if (!match || Number(match[1]) < 100 * 1024 * 1024 || Number(match[4]) !== 0 || Number(match[3]) <= 0) {
    throw new Error("Invalid throughput result");
  }
  return { bytes: Number(match[1]), seconds: Number(match[2]), mibps: Number(match[3]) };
}
/** Parse ps rows (KiB RSS) or PowerShell JSON rows (byte working set) into a common shape. */
export function parseProcesses(output, windows = false) {
  if (windows) {
    const rows = JSON.parse(output);
    return (Array.isArray(rows) ? rows : [rows]).map((r) => ({
      pid: Number(r.ProcessId),
      parent: Number(r.ParentProcessId),
      bytes: Number(r.WorkingSetSize),
      name: String(r.Name ?? ""),
    }));
  }
  return output
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [pid, parent, kib, ...rest] = line.trim().split(/\s+/);
      const numbers = [pid, parent, kib].map(Number);
      if (!numbers.every(Number.isFinite)) throw new Error("Invalid ps row");
      return { pid: numbers[0], parent: numbers[1], bytes: numbers[2] * 1024, name: rest.join(" ") };
    });
}
/** Inclusive descendant process tree, independent of row ordering. */
export function processTree(rows, root) {
  const selected = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows)
      if (selected.has(row.parent) && !selected.has(row.pid)) {
        selected.add(row.pid);
        changed = true;
      }
  }
  return rows.filter((row) => selected.has(row.pid));
}
/** The user's shells and the console hosts around them. A terminal's own memory is not a shell's: PowerShell alone
 * holds 60 to 120 MB per pane on Windows, and what the user runs in a pane is theirs (NFR-04, D-18). */
const SHELL_NAME = /(^|[\\/])-?(powershell|pwsh|cmd|conhost|openconsole|zsh|bash|sh|fish|login)(\.exe)?$/i;

/** The rows without shell processes and without anything that runs below one. Rows without a name are kept. */
export function withoutShells(rows) {
  const shells = new Set(rows.filter((row) => row.name && SHELL_NAME.test(row.name.trim())).map((row) => row.pid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows)
      if (shells.has(row.parent) && !shells.has(row.pid)) {
        shells.add(row.pid);
        changed = true;
      }
  }
  return rows.filter((row) => !shells.has(row.pid));
}
/** Parse complete JSONL telemetry only, tolerating the final write still in progress. */
export function parseEvents(text) {
  return text
    .split("\n")
    .slice(0, -1)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Attribute the critical path without subtracting an unrelated shell timing sample.
 * Child-exec to complete prompt is reported separately, including shell startup/integration and output delivery.
 */
export function coldStartBreakdown(events) {
  const marks = {};
  for (const event of events) {
    if (!Number.isFinite(event.ms) || event.ms < 0) throw Error("Invalid startup timestamp");
    marks[event.event] ??= event.ms;
  }
  for (const name of [
    "run_entry",
    "setup_begin",
    "pty_spawn",
    "shell_started",
    "host_spawn_complete",
    "first_byte",
    "first_output",
    "prompt_read",
    "prompt",
  ]) {
    if (marks[name] === undefined) throw Error(`Missing startup mark ${name}`);
  }
  if (
    marks.shell_started > marks.prompt_read ||
    marks.prompt_read > marks.prompt ||
    marks.first_byte < marks.shell_started ||
    marks.pty_spawn > marks.shell_started
  )
    throw Error("Out-of-order startup marks");
  return {
    marks,
    launch_to_prompt_ms: marks.prompt,
    our_to_shell_ms: marks.shell_started,
    post_spawn_host_ms: Math.max(0, marks.host_spawn_complete - marks.shell_started),
    delivery_ms: Math.max(0, marks.prompt - marks.prompt_read),
    our_total_ms:
      marks.shell_started +
      Math.max(0, marks.host_spawn_complete - marks.shell_started) +
      Math.max(0, marks.prompt - marks.prompt_read),
    shell_to_prompt_ms: marks.prompt_read - marks.shell_started,
  };
}
