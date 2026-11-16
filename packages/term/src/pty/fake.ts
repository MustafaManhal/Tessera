// FakePtyClient: an in-memory "shell" behind the PtyClient contract, for development in a browser and for tests.
// It is not a real shell. It echoes what you type, edits the line (Backspace, Ctrl+C, Ctrl+L), shows a prompt with
// OSC 7 (cwd), OSC 0 (title) and OSC 133 / 633 shell-integration marks, turns on bracketed paste at the prompt like zsh,
// and knows a few commands: `help`, `echo`, `pwd`, `cd`, `clear`, `colors`, `unicode`, `links`, `osc8`, `title`, `serve`
// (runs until Ctrl+C), `flood [N]` (N lines, streamed), `ok`, `fail [N]`, `sleep N`, `blocks N` (N finished command
// blocks at once), `notify`, `progress`, `osc52`, `image` and `exit [N]`. A line ending in `\` continues on the next
// one behind a `> ` prompt (OSC 133;A;k=s), which makes a multi-line command.
//
// Output is queued and sent in chunks; it stops while more than `highWater` bytes are unacknowledged and resumes as
// acks come in, exactly the flow control the real host applies, so tests can see acks keep the credit moving.
// `log` records every spawn, write, resize, ack and kill.
import { type PtyClient, PtyError, type PtyListener, type SessionId, type SpawnSpec } from "./client";

const ESC = "\x1b";
const BEL = "\x07";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface FakePtyOptions {
  /** Bytes per data event. */
  chunkBytes?: number;
  /** Unacknowledged bytes after which output pauses. */
  highWater?: number;
  /** Lines printed by `unicode` (default: an inline sample). */
  unicodeLines?: readonly string[];
  /** Folders `cd` accepts (default: any absolute path). */
  folders?: readonly string[];
}

export interface FakePtyLog {
  spawns: SpawnSpec[];
  writes: { session: SessionId; bytes: Uint8Array }[];
  resizes: { session: SessionId; cols: number; rows: number }[];
  acks: { session: SessionId; bytes: number }[];
  kills: SessionId[];
}

/** The `unicode` sample when no fixture is given: one line per category FR-04 lists. */
export const UNICODE_SAMPLE: readonly string[] = [
  "ASCII     |0123456789|abcdefghij|",
  "CJK       |漢字テスト|한국어보기|",
  "Emoji     |😀|👍🏽|👩‍💻|👨‍👩‍👧‍👦|🇯🇵|🇺🇦|",
  "Combining |é|ñ|å|ö|",
  "Box       |┌─┬─┐│ ├─┼─┤└─┴─┘|",
  // Verified in SymbolsNerdFontMono-Regular.ttf v3.5.1 (its cmap): U+E0A0 Powerline branch, U+E0B0 Powerline arrow,
  // U+F07C folder open, U+F09B GitHub, U+E718 Node.js, U+E7A8 Rust, U+F489 terminal, U+F0E7 bolt.
  "Nerd      |\ue0a0|\ue0b0|\uf07c|\uf09b|\ue718|\ue7a8|\uf489|\uf0e7|",
  "Ligatures |-> => != === <= >= ::|",
];

const HELP = [
  "Fake shell (development and tests only). Commands:",
  "  echo TEXT    pwd    cd PATH    clear    colors    unicode    links",
  "  title TEXT   osc8 URL TEXT   serve (until Ctrl+C)    flood [N]    exit [N]",
  "  ok    fail [N]    sleep SECONDS    blocks N    (end a line with \\ to continue it)",
  "  notify [9|99|777] TEXT    progress N|error|indeterminate|paused|clear|demo",
  "  osc52 TEXT|--read|--big    image    osc7 URL",
];

/** A 24 × 24 PNG (blue and grey checks) for the iTerm2 inline image in `image`. */
export const SAMPLE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAOklEQVR4nGPQr/kGRx+QAKniDMPYIEo0I4sPZ4MGX6wNPoMo0TzIo59qBg2+WBt8" +
  "BlGieZBHP7UMAgAo7/9dU3sKaAAAAABJRU5ErkJggg==";

/** A 24 × 12 Sixel picture: a red band over a blue one. */
export const SAMPLE_SIXEL = `${ESC}P0;1;0q"1;1;24;12#0;2;80;20;20#1;2;20;45;90#0!24~-#1!24~${ESC}\\`;

const ST = `${ESC}\\`;

function toBase64(text: string): string {
  let binary = "";
  for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** VS Code's OSC 633;E escaping: `\\`, and `\xHH` for `;` and control characters. */
function escapeCommandLine(command: string): string {
  let out = "";
  for (const char of command) {
    const code = char.charCodeAt(0);
    if (char === "\\") out += "\\\\";
    else if (char === ";" || code < 0x20) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += char;
  }
  return out;
}

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]+/);
  return parts.at(-1) || "/";
}

interface FakeSession {
  id: SessionId;
  listener: PtyListener;
  cwd: string;
  cols: number;
  rows: number;
  line: string;
  queue: Uint8Array[];
  history: Uint8Array[];
  historyBytes: number;
  unacked: number;
  alive: boolean;
  /** A foreground "process" holds the prompt. */
  busy: "serve" | "flood" | "sleep" | "progress" | null;
  scheduled: boolean;
  /** Lines of a command continued with `\\`. */
  continued: string[];
  timer: ReturnType<typeof setTimeout> | null;
  /** Set by `title`; the prompt shows the folder while it is null (like a shell's precmd). */
  title: string | null;
}

export class FakePtyClient implements PtyClient {
  readonly log: FakePtyLog = { spawns: [], writes: [], resizes: [], acks: [], kills: [] };
  private readonly sessions = new Map<SessionId, FakeSession>();
  private next = 1;
  private readonly chunkBytes: number;
  private readonly highWater: number;
  private readonly unicodeLines: readonly string[];

  constructor(private readonly options: FakePtyOptions = {}) {
    this.chunkBytes = options.chunkBytes ?? 16 * 1024;
    this.highWater = options.highWater ?? 256 * 1024;
    this.unicodeLines = options.unicodeLines ?? UNICODE_SAMPLE;
  }

  /** Unacknowledged bytes of a session (for tests). */
  unacked(session: SessionId): number {
    return this.sessions.get(session)?.unacked ?? 0;
  }

  async spawn(spec: SpawnSpec, onEvent: PtyListener): Promise<SessionId> {
    this.log.spawns.push(spec);
    if (!spec.cwd.startsWith("/") && spec.cwd !== "~" && !/^[A-Za-z]:[\\/]/.test(spec.cwd) && !/^\\\\/.test(spec.cwd)) {
      throw new PtyError("CwdMissing", `No such folder: ${spec.cwd}`);
    }
    const id = `fake-${this.next++}`;
    const session: FakeSession = {
      id,
      listener: onEvent,
      cwd: spec.cwd === "~" ? "/home/you" : spec.cwd,
      cols: spec.cols,
      rows: spec.rows,
      line: "",
      queue: [],
      history: [],
      historyBytes: 0,
      unacked: 0,
      alive: true,
      busy: null,
      scheduled: false,
      continued: [],
      timer: null,
      title: null,
    };
    this.sessions.set(id, session);
    session.scheduled = true;
    this.print(session, "Tessera fake shell. Type help.\r\n");
    this.prompt(session);
    setTimeout(() => {
      if (!session.alive) return;
      session.scheduled = false;
      this.schedule(session);
    }, 0);
    return id;
  }

  async attach(id: SessionId, listener: PtyListener): Promise<void> {
    const session = this.require(id);
    session.listener = listener;
    session.unacked = 0;
    for (const bytes of session.history) {
      session.unacked += bytes.length;
      listener({ type: "data", bytes: bytes.slice() });
    }
    this.schedule(session);
  }

  async write(id: SessionId, bytes: Uint8Array): Promise<void> {
    const session = this.require(id);
    this.log.writes.push({ session: id, bytes: bytes.slice() });
    if (!session.alive) return;
    // Bracketed paste markers are not input.
    const text = decoder.decode(bytes).replaceAll(`${ESC}[200~`, "").replaceAll(`${ESC}[201~`, "");
    for (const char of text) this.key(session, char);
  }

  async resize(id: SessionId, cols: number, rows: number, _pxWidth = 0, _pxHeight = 0): Promise<void> {
    const session = this.require(id);
    session.cols = cols;
    session.rows = rows;
    this.log.resizes.push({ session: id, cols, rows });
  }

  async ack(id: SessionId, bytes: number): Promise<void> {
    const session = this.sessions.get(id);
    this.log.acks.push({ session: id, bytes });
    if (!session) return;
    session.unacked = Math.max(0, session.unacked - bytes);
    this.pump(session);
  }

  async kill(id: SessionId): Promise<void> {
    this.log.kills.push(id);
    const session = this.sessions.get(id);
    if (!session) return;
    session.alive = false;
    session.queue = [];
    // Like the real host, a kill ends the session with an exit event (code 1: killed by a signal), delivered after
    // the kill returns so a pane that is unmounting can mark itself ended first.
    const listener = session.listener;
    queueMicrotask(() => listener({ type: "exit", code: 1 }));
    this.sessions.delete(id);
  }

  // Line editing ------------------------------------------------------------------------------------------------

  private key(session: FakeSession, char: string): void {
    if (char === "\x03") {
      // Ctrl+C: stop the foreground "process" or drop the line.
      const wasBusy = session.busy !== null;
      session.queue = [];
      session.busy = null;
      session.line = "";
      session.continued = [];
      if (session.timer) clearTimeout(session.timer);
      session.timer = null;
      this.print(session, `^C\r\n${wasBusy ? `${ESC}]133;D;130${BEL}` : ""}`);
      this.prompt(session);
      return;
    }
    if (session.busy) return;
    if (char === "\r" || char === "\n") {
      const line = session.line;
      session.line = "";
      this.print(session, "\r\n");
      if (line.endsWith("\\")) {
        // Continued: a secondary prompt inside the same block.
        session.continued.push(line);
        this.print(session, `${ESC}]133;A;k=s${BEL}> ${ESC}]133;B${BEL}`);
        return;
      }
      const lines = [...session.continued, line];
      session.continued = [];
      this.run(session, lines.join("\n").trim());
    } else if (char === "\x7f" || char === "\b") {
      if (session.line.length > 0) {
        session.line = Array.from(session.line).slice(0, -1).join("");
        this.print(session, "\b \b");
      }
    } else if (char === "\x0c") {
      this.print(session, `${ESC}[H${ESC}[2J`);
      this.prompt(session);
      this.print(session, session.line);
    } else if (char >= " " || char === "\t") {
      session.line += char;
      this.print(session, char);
    }
  }

  private prompt(session: FakeSession): void {
    const folder = basename(session.cwd);
    const cwdUrl = /^[A-Za-z]:[\\/]/.test(session.cwd)
      ? `file:///${encodeURI(session.cwd.replaceAll("\\", "/"))}`
      : session.cwd.startsWith("\\\\")
        ? `file:////${encodeURI(session.cwd.slice(2).replaceAll("\\", "/"))}`
        : `file://localhost${encodeURI(session.cwd)}`;
    this.print(
      session,
      `${ESC}]7;${cwdUrl}${BEL}${ESC}]0;${session.title ?? folder}${BEL}${ESC}]133;A${BEL}` +
        `${ESC}[1;34m${folder}${ESC}[0m $ ${ESC}]133;B${BEL}${ESC}[?2004h`,
    );
    session.listener({ type: "cwd", path: session.cwd });
  }

  private run(session: FakeSession, command: string): void {
    if (command === "") {
      this.prompt(session);
      return;
    }
    const [name = "", ...args] = command.split(/\s+/);
    const rest = command
      .slice(name.length)
      .trim()
      .replace(/\s*\\\n\s*/g, " ");
    this.print(session, `${ESC}[?2004l${ESC}]633;E;${escapeCommandLine(command)}${BEL}${ESC}]133;C${BEL}`);
    const done = (code = 0) => {
      this.print(session, `${ESC}]133;D;${code}${BEL}`);
      this.prompt(session);
    };
    switch (name) {
      case "help":
        this.print(session, `${HELP.join("\r\n")}\r\n`);
        done();
        return;
      case "echo":
        this.print(session, `${rest}\r\n`);
        done();
        return;
      case "pwd":
        this.print(session, `${session.cwd}\r\n`);
        done();
        return;
      case "cd": {
        const target = rest || "/home/you";
        const path = /^[A-Za-z]:[\\/]/.test(target)
          ? target.replaceAll("\\", "/")
          : /^(?:\\\\|\/\/)/.test(target)
            ? `\\\\${target
                .slice(2)
                .split(/[\\/]+/)
                .filter(Boolean)
                .join("\\")}`
            : target.startsWith("/")
              ? target
              : /^[A-Za-z]:[\\/]|^\\\\/.test(session.cwd)
                ? `${session.cwd.replace(/[\\/]+$/, "")}\\${target.replaceAll("/", "\\")}`
                : `${session.cwd.replace(/\/$/, "")}/${target}`;
        const allowed = this.options.folders;
        if (allowed && !allowed.includes(path)) {
          this.print(session, `cd: no such file or directory: ${target}\r\n`);
          done(1);
          return;
        }
        session.cwd = path;
        done();
        return;
      }
      case "clear":
        this.print(session, `${ESC}[H${ESC}[2J${ESC}[3J`);
        done();
        return;
      case "title":
        session.title = rest || null;
        this.print(session, `${ESC}]0;${rest}${BEL}`);
        session.listener({ type: "title", text: rest });
        done();
        return;
      case "colors":
        this.print(session, colorTable());
        done();
        return;
      case "unicode":
        this.print(session, `${this.unicodeLines.join("\r\n")}\r\n`);
        done();
        return;
      case "links":
        this.print(
          session,
          `${[
            "https://example.com/docs?q=1",
            `${ESC}]8;;https://tessera.dev/osc8${BEL}an OSC 8 link${ESC}]8;;${BEL}`,
            "src/main.rs:42:7",
            "./README.md:3",
            "javascript:alert(1)",
          ].join("\r\n")}\r\n`,
        );
        done();
        return;
      case "osc8": {
        // osc8 URL TEXT: prints an OSC 8 hyperlink (to test which schemes open).
        const [target = "", ...words] = args;
        this.print(session, `${ESC}]8;;${target}${BEL}${words.join(" ") || target}${ESC}]8;;${BEL}\r\n`);
        done();
        return;
      }
      case "serve":
        session.busy = "serve";
        this.print(session, "Listening on http://localhost:3000 (Ctrl+C to stop)\r\n");
        return;
      case "flood": {
        const count = Math.max(1, Math.min(1_000_000, Number(args[0] ?? 10_000) || 10_000));
        session.busy = "flood";
        this.flood(session, count, () => {
          session.busy = null;
          done();
        });
        return;
      }
      case "ok":
        this.print(session, `${ESC}[32m✓${ESC}[0m 12 checks passed\r\n`);
        done();
        return;
      case "fail": {
        const code = Math.max(1, Math.min(255, Number(args[0] ?? 1) || 1));
        this.print(session, `${ESC}[31merror${ESC}[0m: the build failed\r\n  --> src/main.rs:3:5\r\n`);
        done(code);
        return;
      }
      case "sleep": {
        const seconds = Math.max(0, Math.min(3600, Number(args[0] ?? 1) || 0));
        session.busy = "sleep";
        session.timer = setTimeout(() => {
          session.timer = null;
          session.busy = null;
          done();
        }, seconds * 1000);
        return;
      }
      case "blocks": {
        // N finished blocks printed at once (performance checks: markers per block).
        const count = Math.max(1, Math.min(100_000, Number(args[0] ?? 100) || 100));
        const folder = basename(session.cwd);
        let out = "";
        for (let i = 1; i <= count; i++) {
          out +=
            `${ESC}]133;D;0${BEL}${ESC}]133;A${BEL}${ESC}[1;34m${folder}${ESC}[0m $ ${ESC}]133;B${BEL}echo ${i}\r\n` +
            `${ESC}]633;E;echo ${i}${BEL}${ESC}]133;C${BEL}${i}\r\n`;
        }
        this.print(session, out);
        done();
        return;
      }
      case "notify": {
        const protocol = args[0] === "99" || args[0] === "777" || args[0] === "9" ? args[0] : "9";
        const text = (protocol === args[0] ? args.slice(1).join(" ") : rest) || "Hello from the fake shell";
        if (protocol === "99") {
          this.print(session, `${ESC}]99;i=1:d=0;${text}${ST}${ESC}]99;i=1:p=body;from the kitty protocol${ST}`);
        } else if (protocol === "777") {
          this.print(session, `${ESC}]777;notify;${text};from OSC 777${ST}`);
        } else {
          this.print(session, `${ESC}]9;${text}${ST}`);
        }
        done();
        return;
      }
      case "progress": {
        const [what = "50", value = ""] = args;
        const states: Record<string, string> = { error: "2", indeterminate: "3", paused: "4", clear: "0" };
        if (what === "demo") {
          session.busy = "progress";
          let percent = 0;
          const step = () => {
            if (session.busy !== "progress") return;
            this.print(session, `${ESC}]9;4;1;${percent}${ST}`);
            percent += 10;
            if (percent <= 100) session.timer = setTimeout(step, 150);
            else {
              session.timer = null;
              session.busy = null;
              this.print(session, `${ESC}]9;4;0${ST}`);
              done();
            }
          };
          step();
          return;
        }
        const state = states[what];
        this.print(session, state ? `${ESC}]9;4;${state};${value}${ST}` : `${ESC}]9;4;1;${what}${ST}`);
        done();
        return;
      }
      case "osc52": {
        if (args[0] === "--read") {
          this.print(session, `${ESC}]52;c;?${ST}`);
        } else if (args[0] === "--big") {
          this.print(session, `${ESC}]52;c;${toBase64("a".repeat(1.5 * 1024 * 1024))}${ST}`);
        } else {
          this.print(session, `${ESC}]52;c;${toBase64(rest || "copied by osc52")}${ST}`);
        }
        done();
        return;
      }
      case "osc7":
        // osc7 URL: prints a raw OSC 7 (what a shell on another machine, over SSH, would send).
        this.print(session, `${ESC}]7;${args[0] ?? ""}${BEL}`);
        done();
        return;
      case "image":
        this.print(
          session,
          `Sixel:\r\n${SAMPLE_SIXEL}\r\niTerm2:\r\n` +
            `${ESC}]1337;File=inline=1;size=${atob(SAMPLE_PNG_BASE64).length};width=24px;height=24px:` +
            `${SAMPLE_PNG_BASE64}${BEL}\r\n`,
        );
        done();
        return;
      case "exit": {
        const code = Number(args[0] ?? 0) || 0;
        this.print(session, `${ESC}]133;D;${code}${BEL}`);
        this.whenDrained(session, () => {
          session.alive = false;
          session.listener({ type: "exit", code });
          this.sessions.delete(session.id);
        });
        return;
      }
      default:
        this.print(session, `fake-sh: command not found: ${name}\r\n`);
        done(127);
        return;
    }
  }

  // Output ------------------------------------------------------------------------------------------------------

  private print(session: FakeSession, text: string): void {
    if (!session.alive || text === "") return;
    session.queue.push(encoder.encode(text));
    this.schedule(session);
  }

  private flood(session: FakeSession, count: number, finished: () => void): void {
    const filler = "the quick brown fox jumps over the lazy dog ".repeat(2);
    let line = 0;
    const step = () => {
      if (session.busy !== "flood" || !session.alive) return;
      // Produce in batches, yielding to the event loop so the page stays responsive.
      let batch = "";
      while (line < count && batch.length < this.chunkBytes * 4) {
        line += 1;
        batch += `${ESC}[32m${String(line).padStart(7)}${ESC}[0m ${filler}\r\n`;
      }
      this.print(session, batch);
      if (line < count) this.whenBelowHighWater(session, step);
      else this.whenDrained(session, finished);
    };
    step();
  }

  private schedule(session: FakeSession): void {
    if (session.scheduled) return;
    session.scheduled = true;
    queueMicrotask(() => {
      session.scheduled = false;
      this.pump(session);
    });
  }

  /** Sends queued output while the unacknowledged total stays under the high-water mark. */
  private pump(session: FakeSession): void {
    while (session.alive && session.queue.length > 0 && session.unacked < this.highWater) {
      const head = session.queue[0] as Uint8Array;
      const chunk = head.length > this.chunkBytes ? head.subarray(0, this.chunkBytes) : head;
      if (chunk === head) session.queue.shift();
      else session.queue[0] = head.subarray(this.chunkBytes);
      session.history.push(chunk);
      session.historyBytes += chunk.length;
      while (session.historyBytes > 2 * 1024 * 1024) {
        session.historyBytes -= session.history.shift()?.length ?? 0;
      }
      session.unacked += chunk.length;
      session.listener({ type: "data", bytes: chunk.slice() });
    }
    this.notify(session);
  }

  private waiters = new Map<SessionId, { drained: (() => void)[]; below: (() => void)[] }>();

  private notify(session: FakeSession): void {
    const waiting = this.waiters.get(session.id);
    if (!waiting) return;
    if (session.queue.length === 0 && session.unacked < this.highWater) {
      const below = waiting.below.splice(0);
      for (const run of below) setTimeout(run, 0);
    }
    if (session.queue.length === 0) {
      const drained = waiting.drained.splice(0);
      for (const run of drained) setTimeout(run, 0);
    }
  }

  private waitersOf(session: FakeSession) {
    let waiting = this.waiters.get(session.id);
    if (!waiting) {
      waiting = { drained: [], below: [] };
      this.waiters.set(session.id, waiting);
    }
    return waiting;
  }

  private whenBelowHighWater(session: FakeSession, run: () => void): void {
    this.waitersOf(session).below.push(run);
    this.notify(session);
  }

  private whenDrained(session: FakeSession, run: () => void): void {
    this.waitersOf(session).drained.push(run);
    this.schedule(session);
  }

  private require(id: SessionId): FakeSession {
    const session = this.sessions.get(id);
    if (!session) throw new PtyError("UnknownSession", `Unknown session ${id}`);
    return session;
  }
}

function colorTable(): string {
  let out = "";
  for (let i = 0; i < 16; i++) out += `${ESC}[48;5;${i}m  ${i.toString().padStart(2)}  `;
  out += `${ESC}[0m\r\n`;
  for (let row = 0; row < 6; row++) {
    for (let i = 0; i < 36; i++) out += `${ESC}[48;5;${16 + row * 36 + i}m `;
    out += `${ESC}[0m\r\n`;
  }
  for (let i = 0; i < 72; i++) {
    const r = Math.round((255 * i) / 71);
    out += `${ESC}[48;2;${r};${255 - r};128m `;
  }
  out += `${ESC}[0m\r\n${ESC}[1mbold${ESC}[0m ${ESC}[3mitalic${ESC}[0m ${ESC}[4munderline${ESC}[0m ${ESC}[7minverse${ESC}[0m\r\n`;
  return out;
}

export function decodeForTests(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}
