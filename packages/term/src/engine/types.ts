// The TerminalEngine adapter (TRD §4.2): what a pane needs from a terminal emulator, independent of the emulator, so
// the M1.6 ghostty-web spike can implement the same interface. `XtermEngine` is the default implementation.

export interface Disposable {
  dispose(): void;
}

export type CursorStyle = "block" | "bar" | "underline";
export type Renderer = "webgl" | "dom";

/** The 16 ANSI colours and the surface colours of a terminal theme (CSS colour strings). */
export interface EngineTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface EngineOptions {
  fontFamily: string;
  /** CSS pixels. */
  fontSize: number;
  lineHeight: number;
  fontWeight: number;
  fontWeightBold: number;
  ligatures: boolean;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  /** Lines kept above the screen. */
  scrollback: number;
  theme: EngineTheme;
  /** WebGL by default; "dom" forces the DOM renderer (tests, or a GPU blocklist). */
  renderer: Renderer;
  /** Option sends Meta on macOS (off: Option types accented characters). */
  macOptionIsMeta: boolean;
  screenReaderMode: boolean;
  /** Sixel and iTerm2 inline images (`terminal.images`). */
  images: boolean;
}

/** Limits for inline images (FR-08): a picture can never take more than this much memory. */
export const IMAGE_LIMITS = {
  /** Largest picture in pixels (4096 × 4096). */
  pixelLimit: 16_777_216,
  /** All pictures of one terminal, in MB (the addon evicts the oldest past this). */
  storageLimit: 64,
  /** Largest Sixel or iTerm2 payload in bytes. */
  sixelSizeLimit: 8_000_000,
  iipSizeLimit: 8_000_000,
} as const;

/** A position that moves with the buffer (xterm IMarker); `line` is -1 once its line left the scrollback. */
export interface EngineMarker {
  readonly line: number;
  readonly isDisposed: boolean;
  dispose(): void;
  onDispose(listener: () => void): Disposable;
}

export interface DecorationSpec {
  marker: EngineMarker;
  /** Column (cells). */
  x?: number;
  /** Width and height in cells. */
  width?: number;
  height?: number;
  layer?: "top" | "bottom";
}

/** A DOM element the engine keeps on a buffer line while that line is on screen. */
export interface EngineDecoration extends Disposable {
  readonly isDisposed: boolean;
  /** Called each time the element is placed (the element is reused). */
  onRender(listener: (element: HTMLElement) => void): Disposable;
}

/** A buffer position: 0-based column, absolute buffer line. */
export interface BufferPoint {
  x: number;
  line: number;
}

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface SearchResults {
  /** 0-based index of the active match, -1 when none is active. */
  index: number;
  count: number;
}

export interface EngineSize {
  cols: number;
  rows: number;
  pxWidth: number;
  pxHeight: number;
}

/** A link under the pointer: what it points at and where it came from. */
export interface EngineLink {
  kind: "url" | "osc8" | "path";
  text: string;
}

export interface LinkHandlers {
  /** Called on click; `event` tells whether Cmd/Ctrl was held. */
  activate(link: EngineLink, event: MouseEvent): void;
  hover(link: EngineLink, event: MouseEvent): void;
  leave(): void;
  /** Detects `path:line[:col]` links in a line of text (the app resolves them against the cwd). */
  findPaths(line: string): { start: number; end: number; text: string }[];
}

export interface TerminalEngine {
  readonly cols: number;
  readonly rows: number;
  /** The renderer in use now (WebGL may have fallen back to DOM). */
  readonly renderer: Renderer;
  /** The program asked for bracketed paste (DEC mode 2004). */
  readonly bracketedPaste: boolean;
  /** The alternate screen (full-screen programs) is active. */
  readonly alternateScreen: boolean;
  /** Cursor position in the active buffer. */
  readonly cursor: BufferPoint;
  /** First buffer line on screen. */
  readonly viewportLine: number;
  /** Lines in the buffer (scrollback plus screen). */
  readonly bufferLength: number;
  /** Image addon loaded. */
  readonly imagesActive: boolean;
  /** Attaches to an element and fits it; call after `document.fonts.ready`. */
  mount(element: HTMLElement): void;
  /** Feeds output; `onDone` runs once the emulator has processed it (ack only then). */
  write(bytes: Uint8Array, onDone?: () => void): void;
  /** Fits the grid to the element now (the engine also refits on element resize). */
  fit(): void;
  focus(): void;
  blur(): void;
  setOptions(options: Partial<EngineOptions>): void;
  /** Input from the user (keys, mouse reports) as UTF-8 bytes. */
  onData(listener: (bytes: Uint8Array) => void): Disposable;
  onResize(listener: (size: EngineSize) => void): Disposable;
  onTitle(listener: (title: string) => void): Disposable;
  onBell(listener: () => void): Disposable;
  onFocusChange(listener: (focused: boolean) => void): Disposable;
  /** Registers an OSC handler; return true when handled. */
  onOsc(code: number, handler: (data: string) => boolean): Disposable;
  onSelectionChange(listener: () => void): Disposable;
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  selectAll(): void;
  scrollToBottom(): void;
  /** Pastes like a user would: wraps in bracketed-paste markers when the program asked for them. */
  paste(text: string): void;
  findNext(term: string, options: SearchOptions): boolean;
  findPrevious(term: string, options: SearchOptions): boolean;
  clearSearch(): void;
  onSearchResults(listener: (results: SearchResults) => void): Disposable;
  setLinkHandlers(handlers: LinkHandlers | null): void;
  /** Text of the visible screen, for tests and "copy screen". */
  screenText(): string;
  /** A marker on the cursor's line plus `offset`; undefined in the alternate screen or after dispose. */
  registerMarker(offset?: number): EngineMarker | undefined;
  registerDecoration(spec: DecorationSpec): EngineDecoration | undefined;
  /** Text of one buffer line (trailing blanks trimmed) and whether it continues the line above (soft wrap). */
  line(index: number): { text: string; wrapped: boolean } | null;
  scrollToLine(line: number): void;
  /** Selects whole lines, `start` to `end` inclusive. */
  selectLines(start: number, end: number): void;
  /** Selects `length` cells from a position (can span lines). */
  select(from: BufferPoint, length: number): void;
  /** The selection, or null. `end` is exclusive. */
  selectionRange(): { start: BufferPoint; end: BufferPoint } | null;
  /** Off screen: give the WebGL context back (NFR-13); on screen: take one again. */
  setVisible(visible: boolean): void;
  /** Fires after each render and each scroll (overlays that follow buffer lines reposition here). */
  onViewportChange(listener: () => void): Disposable;
  /** Cell size and where the text grid starts, in CSS px relative to the mounted element; null before mount. */
  grid(): { cellWidth: number; cellHeight: number; left: number; top: number } | null;
  dispose(): void;
}
