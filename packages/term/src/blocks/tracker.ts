// BlockTracker (M2.2, FR-15): command blocks from shell-integration marks, with no output stored.
//
// Marks (OSC 133, FinalTerm; see .ai/research/osc-blocks.md):
//   A  prompt start      → a new block (an open block without D is closed first: "aborted")
//   B  prompt end        → the command line starts here (line and column)
//   C  output start      → the command runs (`startedAt`); OSC 633;E before it names the command
//   D[;exit]  finished   → `endedAt`, exit code
// `A;k=s` / `A;k=c` (continuation prompts), `k=r` (right prompt), unknown marks and marks out of order are ignored.
//
// Positions are markers (xterm IMarker), not line numbers: they move with scrolling and resize reflow, and when a
// marker is disposed (its line left the scrollback) the block is dropped. A shell without integration prints no marks,
// so there are no blocks and nothing else changes.

export interface BlockMarker {
  /** Buffer line, or -1 once disposed. */
  readonly line: number;
  readonly isDisposed: boolean;
  dispose(): void;
  onDispose(listener: () => void): { dispose(): void };
}

/** What the tracker needs from the terminal at the moment a mark is parsed. */
export interface BlockHost {
  /** A marker on the cursor's line (undefined when it cannot place one, e.g. in the alternate screen). */
  marker(): BlockMarker | undefined;
  /** Cursor column (0-based) right now. */
  cursorX(): number;
  /** Milliseconds; injectable for tests. */
  now(): number;
  /** The pane's cwd when the command starts. */
  cwd(): string | null;
}

export type BlockStatus = "prompt" | "input" | "running" | "success" | "failure" | "aborted";

/** A block as the UI sees it; line numbers are read from the markers when the snapshot is taken. */
export interface Block {
  id: number;
  status: BlockStatus;
  promptLine: number;
  commandLine: number | null;
  /** Column where the command text starts on `commandLine`. */
  commandColumn: number | null;
  outputStartLine: number | null;
  /** Last line of output (inclusive), null while running. */
  endLine: number | null;
  exitCode: number | null;
  /** From OSC 633;E, or null when the shell did not name it. */
  command: string | null;
  startedAt: number | null;
  endedAt: number | null;
  cwd: string | null;
  collapsed: boolean;
}

interface Entry {
  id: number;
  status: BlockStatus;
  prompt: BlockMarker;
  command: BlockMarker | null;
  commandColumn: number | null;
  output: BlockMarker | null;
  end: BlockMarker | null;
  /** The D mark came with the cursor at column 0: output ended on the line before. */
  endBefore: boolean;
  exitCode: number | null;
  commandText: string | null;
  startedAt: number | null;
  endedAt: number | null;
  cwd: string | null;
  collapsed: boolean;
  subscriptions: { dispose(): void }[];
}

export type BlockEvent =
  | { type: "added"; block: Block }
  | { type: "updated"; block: Block }
  | { type: "removed"; id: number };

export interface BlockTrackerOptions {
  /** Oldest blocks are dropped past this (scrollback trimming normally drops them first). */
  maxBlocks?: number;
}

const FINISHED: ReadonlySet<BlockStatus> = new Set(["success", "failure", "aborted"]);

export function isFinished(block: Pick<Block, "status">): boolean {
  return FINISHED.has(block.status);
}

/** Parses `key=value` options after the mark letter. */
function options(fields: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const field of fields) {
    const eq = field.indexOf("=");
    if (eq > 0) out.set(field.slice(0, eq), field.slice(eq + 1));
  }
  return out;
}

export class BlockTracker {
  private readonly entries: Entry[] = [];
  private readonly byId = new Map<number, Entry>();
  private readonly listeners = new Set<(event: BlockEvent) => void>();
  private pendingCommand: string | null = null;
  private nextId = 1;
  private readonly maxBlocks: number;

  constructor(
    private readonly host: BlockHost,
    { maxBlocks = 50_000 }: BlockTrackerOptions = {},
  ) {
    this.maxBlocks = maxBlocks;
  }

  onEvent(listener: (event: BlockEvent) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Feeds an OSC 133 payload ("A", "B", "C", "D;0", "A;k=s", …). Returns whether it changed anything. */
  mark(data: string): boolean {
    const [letter = "", ...rest] = data.split(";");
    switch (letter) {
      case "A":
      case "P":
        return this.promptStart(options(rest));
      case "B":
        return this.promptEnd();
      case "C":
        return this.outputStart();
      case "D":
        return this.finished(rest[0]);
      default:
        return false;
    }
  }

  /** Feeds an OSC 633 payload; `E;<command>` names the next command (VS Code escapes `;` as `\x3b`). */
  vscode(data: string): void {
    if (!data.startsWith("E;")) return;
    this.pendingCommand = decodeCommandLine(data);
  }

  /**
   * Names a block whose shell sent no `OSC 633;E` (zsh, bash, fish and PowerShell with our integration only send
   * the 133 marks): the pane reads the command text from the buffer when the block starts running. Never replaces a
   * name the shell sent.
   */
  adoptCommand(id: number, text: string): void {
    const entry = this.byId.get(id);
    if (!entry || entry.commandText || text.trim() === "") return;
    entry.commandText = text;
  }

  /** Snapshot of the live blocks, oldest first. */
  blocks(): Block[] {
    return this.entries.map((entry) => this.snapshot(entry));
  }

  get size(): number {
    return this.entries.length;
  }

  /** Id of the oldest live block (it has no separator above it). */
  get firstId(): number | null {
    return this.entries[0]?.id ?? null;
  }

  block(id: number): Block | null {
    const entry = this.byId.get(id);
    return entry ? this.snapshot(entry) : null;
  }

  /** The block holding a buffer line (prompt through end), or null. */
  blockAt(line: number): Block | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i] as Entry;
      if (entry.prompt.line <= line) {
        const block = this.snapshot(entry);
        const last = block.endLine ?? Number.POSITIVE_INFINITY;
        return line <= Math.max(last, block.commandLine ?? block.promptLine) ? block : null;
      }
    }
    return null;
  }

  /** The block's markers, for decorations placed on its lines (owned by the tracker: never dispose them). */
  markers(id: number): { prompt: BlockMarker; output: BlockMarker | null } | null {
    const entry = this.byId.get(id);
    return entry ? { prompt: entry.prompt, output: entry.output } : null;
  }

  setCollapsed(id: number, collapsed: boolean): Block | null {
    const entry = this.byId.get(id);
    if (!entry || entry.collapsed === collapsed) return entry ? this.snapshot(entry) : null;
    entry.collapsed = collapsed;
    this.emit({ type: "updated", block: this.snapshot(entry) });
    return this.snapshot(entry);
  }

  /** Disposes every marker and forgets all blocks. */
  dispose(): void {
    for (const entry of this.entries.splice(0)) this.release(entry);
    this.byId.clear();
    this.listeners.clear();
  }

  // Marks -------------------------------------------------------------------------------------------------------

  private get open(): Entry | undefined {
    const last = this.entries.at(-1);
    return last && !FINISHED.has(last.status) ? last : undefined;
  }

  private promptStart(opts: Map<string, string>): boolean {
    const kind = opts.get("k");
    // Continuation (PS2) and right prompts belong to the block being typed.
    if (kind === "s" || kind === "c" || kind === "r") return false;
    const open = this.open;
    if (open) {
      if (open.status === "running") {
        // A new prompt without D: the command was interrupted or the shell lost track of it.
        open.status = "aborted";
        open.endedAt = this.host.now();
        open.end = this.host.marker() ?? null;
        open.endBefore = true;
        this.watch(open, open.end);
        this.emit({ type: "updated", block: this.snapshot(open) });
      } else {
        // A prompt that never ran a command (empty Enter, Ctrl+C at the prompt): it is not a block.
        this.remove(open);
      }
    }
    const marker = this.host.marker();
    if (!marker) return open !== undefined;
    this.pendingCommand = null;
    const entry: Entry = {
      id: this.nextId++,
      status: "prompt",
      prompt: marker,
      command: null,
      commandColumn: null,
      output: null,
      end: null,
      endBefore: false,
      exitCode: null,
      commandText: null,
      startedAt: null,
      endedAt: null,
      cwd: null,
      collapsed: false,
      subscriptions: [],
    };
    this.watch(entry, marker);
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    while (this.entries.length > this.maxBlocks) this.remove(this.entries[0] as Entry);
    this.emit({ type: "added", block: this.snapshot(entry) });
    return true;
  }

  private promptEnd(): boolean {
    const open = this.open;
    if (open?.status !== "prompt") return false;
    open.command = this.host.marker() ?? null;
    open.commandColumn = this.host.cursorX();
    this.watch(open, open.command);
    open.status = "input";
    return true;
  }

  private outputStart(): boolean {
    const open = this.open;
    if (!open || (open.status !== "prompt" && open.status !== "input")) return false;
    open.output = this.host.marker() ?? null;
    this.watch(open, open.output);
    open.status = "running";
    open.startedAt = this.host.now();
    open.cwd = this.host.cwd();
    open.commandText = this.pendingCommand;
    this.pendingCommand = null;
    this.emit({ type: "updated", block: this.snapshot(open) });
    return true;
  }

  private finished(codeText: string | undefined): boolean {
    const open = this.open;
    if (!open) return false;
    if (open.status !== "running") {
      // D without C: the prompt ran nothing (zsh prints D before every prompt). Drop the empty prompt.
      return false;
    }
    const code = codeText !== undefined && /^-?\d{1,10}$/.test(codeText) ? Number(codeText) : null;
    open.exitCode = code;
    open.status = code === null || code === 0 ? "success" : "failure";
    open.endedAt = this.host.now();
    open.end = this.host.marker() ?? null;
    open.endBefore = this.host.cursorX() === 0;
    this.watch(open, open.end);
    this.emit({ type: "updated", block: this.snapshot(open) });
    return true;
  }

  // Bookkeeping -------------------------------------------------------------------------------------------------

  private watch(entry: Entry, marker: BlockMarker | null): void {
    if (!marker) return;
    entry.subscriptions.push(marker.onDispose(() => this.remove(entry)));
  }

  private remove(entry: Entry): void {
    const index = this.entries.indexOf(entry);
    if (index < 0) return;
    this.entries.splice(index, 1);
    this.byId.delete(entry.id);
    this.release(entry);
    this.emit({ type: "removed", id: entry.id });
  }

  private release(entry: Entry): void {
    for (const subscription of entry.subscriptions.splice(0)) subscription.dispose();
    for (const marker of [entry.prompt, entry.command, entry.output, entry.end]) {
      if (marker && !marker.isDisposed) marker.dispose();
    }
  }

  private snapshot(entry: Entry): Block {
    const outputStart = entry.output?.line ?? null;
    let endLine: number | null = null;
    if (entry.end && outputStart !== null) {
      endLine = entry.endBefore ? entry.end.line - 1 : entry.end.line;
      if (endLine < outputStart) endLine = outputStart - 1; // no output lines
    }
    return {
      id: entry.id,
      status: entry.status,
      promptLine: entry.prompt.line,
      commandLine: entry.command?.line ?? null,
      commandColumn: entry.commandColumn,
      outputStartLine: outputStart,
      endLine,
      exitCode: entry.exitCode,
      command: entry.commandText,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      cwd: entry.cwd,
      collapsed: entry.collapsed,
    };
  }

  private emit(event: BlockEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** The command line of an OSC 633 `E;<command>[;nonce]` payload, unescaped; null for anything else or an empty one. */
export function decodeCommandLine(data: string): string | null {
  if (!data.startsWith("E;")) return null;
  const [raw = ""] = data.slice(2).split(";");
  const text = raw.replace(/\\x([0-9a-fA-F]{2})|\\\\/g, (_match, hex: string | undefined) =>
    hex ? String.fromCharCode(Number.parseInt(hex, 16)) : "\\",
  );
  return text.trim() === "" ? null : text;
}

/** Output lines of a block (0 when it printed nothing or is still running). */
export function outputLineCount(block: Block): number {
  if (block.outputStartLine === null || block.endLine === null) return 0;
  return Math.max(0, block.endLine - block.outputStartLine + 1);
}

/** Duration in ms, or null before it finished. */
export function blockDuration(block: Pick<Block, "startedAt" | "endedAt">, now?: number): number | null {
  if (block.startedAt === null) return null;
  const end = block.endedAt ?? now;
  return end === undefined ? null : Math.max(0, end - block.startedAt);
}

/** "850ms", "3.2s", "1m 12s", "2h 5m". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${rest}s`;
}
