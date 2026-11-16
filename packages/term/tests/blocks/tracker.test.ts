import { describe, expect, it } from "vitest";
import {
  type BlockEvent,
  type BlockHost,
  type BlockMarker,
  BlockTracker,
  blockDuration,
  decodeCommandLine,
  formatDuration,
  outputLineCount,
} from "../../src/blocks";

/** A buffer stand-in: markers on lines that move when the scrollback is trimmed or the text reflows. */
class FakeTerminal implements BlockHost {
  cursorLine = 0;
  column = 0;
  time = 1000;
  folder: string | null = "/home/you";
  alternate = false;
  readonly markers = new Set<FakeMarker>();

  marker(): BlockMarker | undefined {
    if (this.alternate) return undefined;
    const marker = new FakeMarker(this, this.cursorLine);
    this.markers.add(marker);
    return marker;
  }
  cursorX(): number {
    return this.column;
  }
  now(): number {
    return this.time;
  }
  cwd(): string | null {
    return this.folder;
  }
  /** Prints `count` lines: the cursor ends at column 0 of the next line. */
  print(count: number): void {
    this.cursorLine += count;
    this.column = 0;
  }
  /** Drops the first `count` lines of the scrollback. */
  trim(count: number): void {
    for (const marker of [...this.markers]) {
      if (marker.line < count) marker.dispose();
      else marker.line -= count;
    }
    this.cursorLine -= count;
  }
  /** A narrower window: every line at or after `from` moves down `by`. */
  reflow(from: number, by: number): void {
    for (const marker of this.markers) if (marker.line >= from) marker.line += by;
    this.cursorLine += by;
  }
}

class FakeMarker implements BlockMarker {
  isDisposed = false;
  private listeners = new Set<() => void>();
  constructor(
    private readonly owner: FakeTerminal,
    public line: number,
  ) {}
  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.line = -1;
    this.owner.markers.delete(this);
    for (const listener of [...this.listeners]) listener();
  }
  onDispose(listener: () => void) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
}

function setup() {
  const term = new FakeTerminal();
  const tracker = new BlockTracker(term);
  const events: BlockEvent[] = [];
  tracker.onEvent((event) => events.push(event));
  /** A whole command: prompt on the current line, `output` lines, exit code. */
  const command = (text: string, output: number, exit = 0, seconds = 0.5) => {
    tracker.mark("A");
    term.column = 8;
    tracker.mark("B");
    tracker.vscode(`E;${text}`);
    term.print(1);
    tracker.mark("C");
    term.time += seconds * 1000;
    term.print(output);
    tracker.mark(`D;${exit}`);
  };
  return { term, tracker, events, command };
}

describe("BlockTracker", () => {
  it("adoptCommand names a block that has no OSC 633;E, and never replaces a name the shell sent", () => {
    const { term, tracker } = setup();
    tracker.mark("A");
    tracker.mark("B");
    term.print(1);
    tracker.mark("C");
    const [running] = tracker.blocks();
    expect(running?.command).toBeNull();
    tracker.adoptCommand(running?.id ?? 0, "echo hi");
    expect(tracker.block(running?.id ?? 0)?.command).toBe("echo hi");
    tracker.adoptCommand(running?.id ?? 0, "something else");
    expect(tracker.block(running?.id ?? 0)?.command).toBe("echo hi");
    tracker.adoptCommand(999, "unknown block");
    tracker.adoptCommand(running?.id ?? 0, "   ");
    expect(tracker.block(running?.id ?? 0)?.command).toBe("echo hi");
  });

  it("builds a block from A, B, C, D with lines, column, command, times, cwd and exit", () => {
    const { tracker, command } = setup();
    command("npm test", 3, 1, 2);
    const [block] = tracker.blocks();
    expect(block).toMatchObject({
      id: 1,
      status: "failure",
      promptLine: 0,
      commandLine: 0,
      commandColumn: 8,
      outputStartLine: 1,
      endLine: 3,
      exitCode: 1,
      command: "npm test",
      startedAt: 1000,
      endedAt: 3000,
      cwd: "/home/you",
      collapsed: false,
    });
    if (!block) throw new Error("no block");
    expect(outputLineCount(block)).toBe(3);
    expect(blockDuration(block)).toBe(2000);
  });

  it("reports added and updated events, and success for exit 0 or a missing code", () => {
    const { tracker, term, events, command } = setup();
    command("ok", 1, 0);
    tracker.mark("A");
    tracker.mark("B");
    tracker.mark("C");
    term.print(1);
    tracker.mark("D");
    expect(events.map((event) => event.type)).toEqual(["added", "updated", "updated", "added", "updated", "updated"]);
    expect(tracker.blocks().map((block) => block.status)).toEqual(["success", "success"]);
    expect(tracker.blocks()[1]?.exitCode).toBeNull();
  });

  it("makes no blocks without marks, and ignores garbage and out-of-order marks", () => {
    const { tracker, term } = setup();
    for (const mark of ["", "Z", "B", "C", "D;0", "D;abc", "133", ";;;"]) expect(tracker.mark(mark), mark).toBe(false);
    expect(tracker.size).toBe(0);
    tracker.mark("A");
    expect(tracker.mark("D;0")).toBe(false); // D without C: nothing ran
    tracker.mark("C");
    expect(tracker.mark("B")).toBe(false); // B after C
    term.print(2);
    tracker.mark("D;oops");
    expect(tracker.blocks()[0]).toMatchObject({ status: "success", exitCode: null, endLine: 1 });
    expect(tracker.mark("D;1")).toBe(false); // a second D
    expect(tracker.blocks()[0]?.exitCode).toBeNull();
  });

  it("drops a prompt that never ran a command when the next prompt starts", () => {
    const { tracker, term, events } = setup();
    tracker.mark("A");
    tracker.mark("B");
    term.print(1);
    tracker.mark("D;0");
    tracker.mark("A");
    expect(tracker.size).toBe(1);
    expect(events.filter((event) => event.type === "removed")).toHaveLength(1);
  });

  it("closes a running block as aborted when A comes again without D", () => {
    const { tracker, term } = setup();
    tracker.mark("A");
    tracker.mark("B");
    tracker.vscode("E;vim");
    term.print(1);
    tracker.mark("C");
    term.print(4);
    term.time += 500;
    tracker.mark("A");
    const [aborted, next] = tracker.blocks();
    expect(aborted).toMatchObject({ status: "aborted", endedAt: 1500, endLine: 4, command: "vim" });
    expect(next).toMatchObject({ status: "prompt", promptLine: 5 });
  });

  it("keeps continuation and right prompts in the same block", () => {
    const { tracker, term } = setup();
    tracker.mark("A");
    tracker.mark("B");
    term.print(1);
    expect(tracker.mark("A;k=s")).toBe(false);
    expect(tracker.mark("A;k=c;aid=12")).toBe(false);
    expect(tracker.mark("A;k=r")).toBe(false);
    tracker.mark("B");
    tracker.vscode("E;for i in 1 2\\x0a  do echo $i\\x3b done");
    term.print(1);
    tracker.mark("C");
    term.print(2);
    tracker.mark("D;0;aid=12");
    expect(tracker.size).toBe(1);
    expect(tracker.blocks()[0]).toMatchObject({ promptLine: 0, command: "for i in 1 2\n  do echo $i; done" });
  });

  it("drops blocks whose markers left the scrollback and keeps the rest in place", () => {
    const { tracker, term, events, command } = setup();
    command("one", 10);
    command("two", 10);
    command("three", 10);
    term.trim(15);
    const left = tracker.blocks();
    expect(left.map((block) => block.command)).toEqual(["three"]);
    expect(left[0]).toMatchObject({ promptLine: 7, outputStartLine: 8, endLine: 17 });
    expect(events.filter((event) => event.type === "removed")).toHaveLength(2);
    // A trim that cuts through a block (its prompt line goes) drops it too.
    term.trim(8);
    expect(tracker.size).toBe(0);
  });

  it("follows resize reflow through the markers", () => {
    const { tracker, term, command } = setup();
    command("ls", 4);
    command("pwd", 1);
    term.reflow(3, 2);
    const [first, second] = tracker.blocks();
    expect(first).toMatchObject({ promptLine: 0, outputStartLine: 1, endLine: 6 });
    expect(second).toMatchObject({ promptLine: 7, endLine: 8 });
  });

  it("places no block in the alternate screen", () => {
    const { tracker, term } = setup();
    term.alternate = true;
    expect(tracker.mark("A")).toBe(false);
    expect(tracker.size).toBe(0);
  });

  it("finds the block at a line, collapses it, and disposes all markers", () => {
    const { tracker, term, command } = setup();
    command("a", 3);
    command("b", 3);
    expect(tracker.blockAt(2)?.command).toBe("a");
    expect(tracker.blockAt(4)?.command).toBe("b");
    expect(tracker.blockAt(99)).toBeNull();
    expect(tracker.setCollapsed(1, true)?.collapsed).toBe(true);
    expect(tracker.block(1)?.collapsed).toBe(true);
    expect(tracker.setCollapsed(42, true)).toBeNull();
    tracker.dispose();
    expect(term.markers.size).toBe(0);
    expect(tracker.size).toBe(0);
  });

  it("keeps at most maxBlocks", () => {
    const term = new FakeTerminal();
    const tracker = new BlockTracker(term, { maxBlocks: 3 });
    for (let i = 0; i < 10; i++) {
      tracker.mark("A");
      tracker.mark("C");
      term.print(1);
      tracker.mark("D;0");
    }
    expect(tracker.blocks().map((block) => block.id)).toEqual([8, 9, 10]);
  });

  it("survives 10,000 random marks without throwing", () => {
    const { tracker, term } = setup();
    const marks = ["A", "B", "C", "D;0", "D;1", "A;k=s", "X", "D", ""];
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 10_000; i++) {
      tracker.mark(marks[Math.floor(random() * marks.length)] as string);
      if (random() < 0.3) term.print(1);
      if (random() < 0.01) term.trim(Math.min(term.cursorLine, 5));
    }
    for (const block of tracker.blocks()) {
      expect(block.promptLine).toBeGreaterThanOrEqual(0);
      if (block.endLine !== null && block.outputStartLine !== null)
        expect(block.endLine).toBeGreaterThanOrEqual(block.outputStartLine - 1);
    }
  });
});

describe("block helpers", () => {
  it("decodes VS Code's escaped command line", () => {
    expect(decodeCommandLine("E;echo a\\x3b b;nonce")).toBe("echo a; b");
    expect(decodeCommandLine("E;C:\\\\Users")).toBe("C:\\Users");
    expect(decodeCommandLine("E;  ")).toBeNull();
    expect(decodeCommandLine("P;Cwd=/x")).toBeNull();
  });

  it("formats durations", () => {
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(3240)).toBe("3.2s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(7_500_000)).toBe("2h 5m");
  });
});
