// BlockController (M2.2, FR-15): one per terminal pane. It feeds OSC 133 / 633 to the BlockTracker, draws the gutter
// (one xterm decoration per block on its prompt line: the status dot in the column left of the text, a separator,
// the duration for blocks over 1 s) and the collapsed-output covers, and does the block actions.
//
// - Nothing is stored but markers and metadata; copying reads the buffer when asked.
// - Collapse cannot remove rows from xterm's buffer, so a collapsed block's output rows are covered by an opaque layer
//   ("N lines hidden", Expand). The text stays in the buffer, so Find still matches it; a match inside a collapsed
//   block expands that block.
// - Copying output reads the buffer in chunks of 5,000 lines and yields between them, so a 50,000-line block never
//   blocks the UI for long.
import {
  type Block,
  BlockTracker,
  blockDuration,
  type EngineDecoration,
  formatDuration,
  isFinished,
  outputLineCount,
  type TerminalEngine,
} from "@tessera/term";
import { t } from "@tessera/ui";
import { createCommandTracker } from "../osc";

/** Blocks that ran longer than this show their duration in the gutter row. */
export const SHOW_DURATION_MS = 1000;
/** Re-running asks first after a block ran this long. */
export const RERUN_CONFIRM_MS = 60_000;
const COPY_CHUNK_LINES = 5000;

export interface BlockControllerDeps {
  cwd(): string | null;
  /** Bytes to the PTY as typed. */
  write(text: string): void;
  onRunningProcessChange(process: string | null): void;
  /** A block reached D (success or failure). */
  onFinished(block: Block): void;
  trimTrailingWhitespace(): boolean;
  now?: () => number;
}

export type BlockUiEvent =
  | { type: "change" }
  | { type: "hover"; id: number | null; rect: DOMRect | null }
  | { type: "menu"; id: number; x: number; y: number };

export interface CopyResult {
  lines: number;
  chars: number;
  /** Time spent reading the buffer (ms) and the longest single chunk (ms). */
  readMs: number;
  longestChunkMs: number;
}

interface GutterItem {
  decoration: EngineDecoration;
  element: HTMLElement | null;
}

declare global {
  interface Window {
    /** Dev builds only: measurements for the brief 08 performance notes. */
    __tesseraPerf?: { markMs: number; marks: number; lastCopy?: CopyResult };
  }
}

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export class BlockController {
  readonly tracker: BlockTracker;
  private readonly running = createCommandTracker();
  private readonly items = new Map<number, GutterItem>();
  private readonly listeners = new Set<(event: BlockUiEvent) => void>();
  private readonly subscriptions: { dispose(): void }[] = [];
  private gutter = false;
  private selectedId: number | null = null;
  /** Collapsed block ids (covers are repositioned on every render, so this stays small and cheap). */
  private readonly collapsed = new Set<number>();
  private readonly layer: HTMLDivElement;
  private readonly now: () => number;
  private markMs = 0;
  private marks = 0;

  constructor(
    private readonly engine: TerminalEngine,
    private readonly host: HTMLElement,
    private readonly deps: BlockControllerDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.tracker = new BlockTracker({
      marker: () => engine.registerMarker(0),
      cursorX: () => engine.cursor.x,
      now: this.now,
      cwd: deps.cwd,
    });
    this.layer = document.createElement("div");
    this.layer.className = "block-cover-layer";
    this.layer.setAttribute("aria-hidden", "true");
    host.appendChild(this.layer);

    this.subscriptions.push(
      // One handler per code: xterm stops at the first handler that returns true.
      engine.onOsc(133, (data) => {
        const start = performance.now();
        this.tracker.mark(data);
        const change = this.running.osc133(data);
        if (change !== undefined) deps.onRunningProcessChange(change);
        this.markMs += performance.now() - start;
        this.marks += 1;
        if (import.meta.env.DEV)
          window.__tesseraPerf = { ...window.__tesseraPerf, markMs: this.markMs, marks: this.marks };
        return true;
      }),
      engine.onOsc(633, (data) => {
        this.tracker.vscode(data);
        this.running.osc633(data);
        return true;
      }),
      this.tracker.onEvent((event) => {
        if (event.type === "added") this.addItem(event.block);
        else if (event.type === "removed") this.removeItem(event.id);
        else {
          if (event.block.status === "running" && !event.block.command) {
            // Our shell scripts send only the 133 marks: take the command text from the buffer now, while the
            // typed line is still on screen, so the dot, the alert and re-run can name the command.
            const text = this.commandText(event.block.id);
            if (text) this.tracker.adoptCommand(event.block.id, text);
          }
          this.refreshItem(event.block.id);
          if (event.block.status === "success" || event.block.status === "failure") {
            deps.onFinished(this.tracker.block(event.block.id) ?? event.block);
          }
        }
        this.emit({ type: "change" });
      }),
      engine.onViewportChange(() => this.positionCovers()),
      // The search addon selects the match after it reports the results: look once it has.
      engine.onSearchResults(() => setTimeout(() => this.expandAtSelection(), 0)),
    );

    // The gutter dots: hover shows the controls, a right click the block menu, a click makes the block current.
    const dotOf = (event: Event) => (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-block-dot]");
    const onOver = (event: PointerEvent) => {
      const dot = dotOf(event);
      if (dot) this.emit({ type: "hover", id: Number(dot.dataset.blockDot), rect: dot.getBoundingClientRect() });
    };
    const onOut = (event: PointerEvent) => {
      if (dotOf(event)) this.emit({ type: "hover", id: null, rect: null });
    };
    const onMenu = (event: MouseEvent) => {
      const dot = dotOf(event);
      if (!dot) return;
      // Our menu, not the pane's: stop the event before React's root listener sees it.
      event.preventDefault();
      event.stopPropagation();
      this.emit({ type: "menu", id: Number(dot.dataset.blockDot), x: event.clientX, y: event.clientY });
    };
    const onClick = (event: MouseEvent) => {
      const dot = dotOf(event);
      if (!dot) return;
      event.preventDefault();
      this.select(Number(dot.dataset.blockDot));
    };
    const onCover = (event: MouseEvent) => {
      const button = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-block-expand]");
      if (button) this.setCollapsed(Number(button.dataset.blockExpand), false);
    };
    host.addEventListener("pointerover", onOver);
    host.addEventListener("pointerout", onOut);
    host.addEventListener("contextmenu", onMenu, { capture: true });
    host.addEventListener("click", onClick);
    this.layer.addEventListener("click", onCover);
    this.subscriptions.push({
      dispose: () => {
        host.removeEventListener("pointerover", onOver);
        host.removeEventListener("pointerout", onOut);
        host.removeEventListener("contextmenu", onMenu, { capture: true });
        host.removeEventListener("click", onClick);
        this.layer.removeEventListener("click", onCover);
      },
    });
  }

  onEvent(listener: (event: BlockUiEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    for (const item of this.items.values()) item.decoration.dispose();
    this.items.clear();
    this.tracker.dispose();
    this.layer.remove();
    this.listeners.clear();
  }

  // Gutter --------------------------------------------------------------------------------------------------------

  get gutterVisible(): boolean {
    return this.gutter;
  }

  setGutter(visible: boolean): void {
    if (visible === this.gutter) return;
    this.gutter = visible;
    this.host.dataset.blockGutter = visible ? "on" : "off";
    if (visible) for (const block of this.tracker.blocks()) this.addItem(block);
    else {
      for (const item of this.items.values()) item.decoration.dispose();
      this.items.clear();
    }
    this.emit({ type: "change" });
  }

  private addItem(block: Block): void {
    if (!this.gutter || this.items.has(block.id)) return;
    const markers = this.tracker.markers(block.id);
    if (!markers) return;
    const decoration = this.engine.registerDecoration({ marker: markers.prompt, layer: "top" });
    if (!decoration) return;
    const item: GutterItem = { decoration, element: null };
    this.items.set(block.id, item);
    decoration.onRender((element) => {
      element.style.width = "100%";
      if (item.element !== element) {
        item.element = element;
        element.classList.add("block-row");
        element.innerHTML =
          '<span class="block-sep"></span><span class="block-dot" data-block-dot></span><span class="block-duration"></span>';
        this.paint(block.id);
      }
    });
  }

  private removeItem(id: number): void {
    this.items.get(id)?.decoration.dispose();
    this.items.delete(id);
    this.collapsed.delete(id);
    if (this.selectedId === id) this.selectedId = null;
  }

  private refreshItem(id: number): void {
    this.paint(id);
    this.positionCovers();
  }

  /** Writes a block's state into its gutter row (only when the row has been placed on screen once). */
  private paint(id: number): void {
    const element = this.items.get(id)?.element;
    const block = this.tracker.block(id);
    if (!element || !block) return;
    const dot = element.querySelector<HTMLElement>(".block-dot");
    const duration = element.querySelector<HTMLElement>(".block-duration");
    element.dataset.first = String(this.tracker.firstId === id);
    element.dataset.status = block.status;
    element.dataset.selected = String(this.selectedId === id);
    if (dot) {
      dot.dataset.blockDot = String(id);
      dot.title = describeBlock(block);
    }
    const ms = blockDuration(block);
    if (duration)
      duration.textContent = ms !== null && isFinished(block) && ms > SHOW_DURATION_MS ? formatDuration(ms) : "";
  }

  // Covers for collapsed output -----------------------------------------------------------------------------------

  private positionCovers(): void {
    if (this.collapsed.size === 0) {
      if (this.layer.childElementCount > 0) this.layer.replaceChildren();
      return;
    }
    const grid = this.engine.grid();
    if (!grid) return;
    const top = this.engine.viewportLine;
    const rows = this.engine.rows;
    const covers: HTMLElement[] = [];
    for (const id of this.collapsed) {
      const block = this.tracker.block(id);
      if (!block || block.outputStartLine === null || block.endLine === null) continue;
      const first = Math.max(block.outputStartLine, top);
      const last = Math.min(block.endLine, top + rows - 1);
      if (last < first) continue;
      const cover = document.createElement("div");
      cover.className = "block-cover";
      cover.dataset.blockCover = String(block.id);
      cover.style.top = `${grid.top + (first - top) * grid.cellHeight}px`;
      cover.style.left = `${grid.left}px`;
      cover.style.width = `${grid.cellWidth * this.engine.cols}px`;
      cover.style.height = `${(last - first + 1) * grid.cellHeight}px`;
      const bar = document.createElement("button");
      bar.type = "button";
      bar.className = "block-cover-bar";
      bar.dataset.blockExpand = String(block.id);
      bar.tabIndex = -1;
      bar.textContent = `${t("block.hidden", { count: outputLineCount(block).toLocaleString() })} · ${t("block.expand")}`;
      cover.appendChild(bar);
      covers.push(cover);
    }
    this.layer.replaceChildren(...covers);
  }

  private expandAtSelection(): void {
    const range = this.engine.selectionRange();
    if (!range) return;
    const block = this.tracker.blockAt(range.start.line);
    if (block?.collapsed) this.setCollapsed(block.id, false);
  }

  // Current block -------------------------------------------------------------------------------------------------

  blocks(): Block[] {
    return this.tracker.blocks();
  }

  block(id: number): Block | null {
    return this.tracker.block(id);
  }

  /** The block actions work on: the one picked (jump, click), else the last one that ran a command. */
  current(): Block | null {
    if (this.selectedId !== null) {
      const selected = this.tracker.block(this.selectedId);
      if (selected) return selected;
    }
    const blocks = this.tracker.blocks();
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i] as Block;
      if (block.status !== "prompt" && block.status !== "input") return block;
    }
    return null;
  }

  select(id: number | null): void {
    const previous = this.selectedId;
    this.selectedId = id;
    if (previous !== null) this.paint(previous);
    if (id !== null) this.paint(id);
    this.emit({ type: "change" });
  }

  private jumpTarget(direction: "previous" | "next"): Block | null {
    // The prompt being typed at is where "next" past the last block lands anyway (the bottom).
    const blocks = this.tracker.blocks().filter((block) => block.status !== "prompt" && block.status !== "input");
    const selected = this.selectedId !== null ? this.tracker.block(this.selectedId) : null;
    const atBottom = this.engine.viewportLine + this.engine.rows >= this.engine.bufferLength;
    const reference = selected?.promptLine ?? (atBottom ? this.engine.bufferLength : this.engine.viewportLine);
    if (direction === "previous") {
      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i] as Block;
        if (block.promptLine < reference) return block;
      }
      return null;
    }
    return blocks.find((block) => block.promptLine > reference) ?? null;
  }

  canJump(direction: "previous" | "next"): boolean {
    if (direction === "next" && this.selectedId !== null) return true; // past the last one: back to the bottom
    return this.jumpTarget(direction) !== null;
  }

  /** Scrolls to the previous or next prompt and makes that block current. */
  jump(direction: "previous" | "next"): Block | null {
    const target = this.jumpTarget(direction);
    if (!target) {
      if (direction === "next") {
        this.select(null);
        this.engine.scrollToBottom();
      }
      return null;
    }
    this.engine.scrollToLine(target.promptLine);
    this.select(target.id);
    return target;
  }

  // Actions -------------------------------------------------------------------------------------------------------

  /** The command text: from OSC 633;E, else read from the buffer between B and C. */
  commandText(id: number): string | null {
    const block = this.tracker.block(id);
    if (!block) return null;
    if (block.command) return block.command;
    if (block.commandLine === null || block.commandColumn === null) return null;
    const last = (block.outputStartLine ?? block.commandLine + 1) - 1;
    const lines: string[] = [];
    for (let line = block.commandLine; line <= Math.max(block.commandLine, last); line++) {
      const text = this.engine.line(line)?.text ?? "";
      lines.push(line === block.commandLine ? text.slice(block.commandColumn) : text);
    }
    const text = lines.join("\n").trim();
    return text === "" ? null : text;
  }

  selectCommand(id: number): boolean {
    const block = this.tracker.block(id);
    if (!block || block.commandLine === null || block.commandColumn === null) return false;
    const last = Math.max(block.commandLine, (block.outputStartLine ?? block.commandLine + 1) - 1);
    const lastLength = this.engine.line(last)?.text.length ?? 0;
    const length = (last - block.commandLine) * this.engine.cols + lastLength - block.commandColumn;
    if (length <= 0) return false;
    this.engine.select({ x: block.commandColumn, line: block.commandLine }, length);
    return true;
  }

  selectOutput(id: number): boolean {
    const block = this.tracker.block(id);
    if (!block || outputLineCount(block) === 0 || block.outputStartLine === null || block.endLine === null)
      return false;
    this.engine.selectLines(block.outputStartLine, block.endLine);
    return true;
  }

  /** The output as text (soft-wrapped lines joined), read in chunks so a huge block does not block the UI. */
  async outputText(id: number): Promise<{ text: string; result: CopyResult } | null> {
    const block = this.tracker.block(id);
    if (!block || block.outputStartLine === null || block.endLine === null || outputLineCount(block) === 0) return null;
    const trim = this.deps.trimTrailingWhitespace();
    const parts: string[] = [];
    let readMs = 0;
    let longestChunkMs = 0;
    let lines = 0;
    for (let start = block.outputStartLine; start <= block.endLine; start += COPY_CHUNK_LINES) {
      const began = performance.now();
      const end = Math.min(block.endLine, start + COPY_CHUNK_LINES - 1);
      for (let index = start; index <= end; index++) {
        const line = this.engine.line(index);
        if (!line) continue;
        const text = trim ? line.text.replace(/\s+$/, "") : line.text;
        if (line.wrapped && parts.length > 0) parts[parts.length - 1] += text;
        else {
          parts.push(text);
          lines += 1;
        }
      }
      const spent = performance.now() - began;
      readMs += spent;
      longestChunkMs = Math.max(longestChunkMs, spent);
      if (end < block.endLine) await yieldToUi();
    }
    const text = parts.join("\n");
    const result = { lines, chars: text.length, readMs, longestChunkMs };
    if (import.meta.env.DEV) window.__tesseraPerf = { markMs: this.markMs, marks: this.marks, lastCopy: result };
    return { text, result };
  }

  /** Why re-running asks first, or null when it can run at once. */
  rerunQuestion(id: number): { long: string | null; lines: number } | null {
    const block = this.tracker.block(id);
    const command = this.commandText(id);
    if (!block || !command) return null;
    const ms = blockDuration(block);
    const lines = command.split("\n").length;
    const long = ms !== null && ms > RERUN_CONFIRM_MS ? formatDuration(ms) : null;
    return long || lines > 1 ? { long, lines } : null;
  }

  /** Types the command again and presses Enter (bracketed when the shell asked for it, so lines stay one command). */
  rerun(id: number): boolean {
    const command = this.commandText(id);
    if (!command) return false;
    if (this.engine.bracketedPaste && command.includes("\n")) {
      this.engine.paste(command);
      this.deps.write("\r");
    } else this.deps.write(`${command}\r`);
    this.engine.scrollToBottom();
    this.select(null);
    return true;
  }

  setCollapsed(id: number, collapsed: boolean): void {
    const block = this.tracker.block(id);
    if (!block || (collapsed && (!isFinished(block) || outputLineCount(block) === 0))) return;
    this.tracker.setCollapsed(id, collapsed);
    if (collapsed) this.collapsed.add(id);
    else this.collapsed.delete(id);
    this.positionCovers();
  }

  toggleCollapsed(id: number): void {
    const block = this.tracker.block(id);
    if (block) this.setCollapsed(id, !block.collapsed);
  }

  private emit(event: BlockUiEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** "npm test: Failed with exit code 1, took 3.2s" (the dot's tooltip and accessible text). */
export function describeBlock(block: Block): string {
  const command = (block.command ?? t("alert.unnamed")).replace(/\s*\n\s*/g, " ");
  const status =
    block.status === "failure"
      ? t("block.status.failure", { code: block.exitCode ?? "?" })
      : block.status === "success"
        ? t("block.status.success")
        : block.status === "aborted"
          ? t("block.status.aborted")
          : t("block.status.running");
  const ms = blockDuration(block);
  return ms !== null && isFinished(block)
    ? t("block.labelDuration", { command, status, duration: formatDuration(ms) })
    : t("block.label", { command, status });
}
