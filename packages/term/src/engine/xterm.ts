// XtermEngine: the TerminalEngine over xterm.js 6 (D-02, TRD §4.2).
// - Renderer: WebGL by default. On `webglcontextlost` the WebGL addon is disposed (xterm falls back to its DOM
//   renderer) and WebGL is tried again the next time the terminal gets focus. `renderer: "dom"` never loads WebGL.
// - Size: a ResizeObserver on the element refits on the next animation frame, at most once per frame, and never
//   because of output.
// - Unicode: the grapheme addon ("15-graphemes") so emoji ZWJ sequences, flags, skin tones and combining marks take
//   the cells they should; CJK is wide.
// - Ligatures: the ligatures addon is loaded only while enabled (it costs performance). In a WebView it cannot read
//   the font file, so it uses its fallback ligature list with `font-feature-settings: "calt"`.
// - Input leaves as UTF-8 bytes; output is written as bytes and acknowledged from xterm's write callback.
/// <reference path="./modules.d.ts" />
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import type { LigaturesAddon } from "@xterm/addon-ligatures";
import { SearchAddon } from "@xterm/addon-search";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { type IDisposable, type ILink, type ILinkProvider, type IMarker, Terminal } from "@xterm/xterm";
import { LIGATURE_FEATURES, toXtermOptions } from "./options";
import { type RendererLease, RendererController } from "./renderer";
import {
  type BufferPoint,
  type DecorationSpec,
  type Disposable,
  type EngineDecoration,
  type EngineMarker,
  IMAGE_LIMITS,
  type EngineOptions,
  type EngineSize,
  type LinkHandlers,
  type Renderer,
  type SearchOptions,
  type SearchResults,
  type TerminalEngine,
} from "./types";

const encoder = new TextEncoder();

function binaryToBytes(data: string): Uint8Array {
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
  return bytes;
}

type Listener<T> = (value: T) => void;

class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  on(listener: Listener<T>): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }
  clear(): void {
    this.listeners.clear();
  }
}

export class XtermEngine implements TerminalEngine {
  private readonly term: Terminal;
  private readonly fitAddon = new FitAddon();
  private readonly searchAddon = new SearchAddon({ highlightLimit: 2000 });
  private webgl: WebglAddon | null = null;
  private readonly renderers: RendererController;
  private ligatures: LigaturesAddon | null = null;
  private images: ImageAddon | null = null;
  private options: EngineOptions;
  private element: HTMLElement | null = null;
  private observer: ResizeObserver | null = null;
  private frame = 0;
  private disposed = false;
  private readonly subscriptions: IDisposable[] = [];
  private linkHandlers: LinkHandlers | null = null;
  private pathProvider: IDisposable | null = null;
  private readonly resize = new Emitter<EngineSize>();
  private readonly focusChange = new Emitter<boolean>();
  private readonly searchResults = new Emitter<SearchResults>();

  constructor(options: EngineOptions) {
    this.options = options;
    this.renderers = new RendererController({ create: () => this.createWebgl() });
    this.renderers.setWanted(options.renderer === "webgl");
    this.term = new Terminal({
      ...toXtermOptions(options),
      allowProposedApi: true,
      allowTransparency: false,
      drawBoldTextInBrightColors: false,
      rightClickSelectsWord: false,
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (event, text) => this.linkHandlers?.activate({ kind: "osc8", text }, event),
        hover: (event, text) => this.linkHandlers?.hover({ kind: "osc8", text }, event),
        leave: () => this.linkHandlers?.leave(),
      },
    });
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(this.searchAddon);
    this.term.loadAddon(new UnicodeGraphemesAddon());
    this.term.unicode.activeVersion = "15-graphemes";
    this.setImages(options.images);
    this.term.loadAddon(
      new WebLinksAddon((event, uri) => this.linkHandlers?.activate({ kind: "url", text: uri }, event), {
        hover: (event, text) => this.linkHandlers?.hover({ kind: "url", text }, event),
        leave: () => this.linkHandlers?.leave(),
      }),
    );
    this.subscriptions.push(
      this.searchAddon.onDidChangeResults(({ resultIndex, resultCount }) =>
        this.searchResults.fire({ index: resultIndex, count: resultCount }),
      ),
      this.term.onResize(() => this.resize.fire(this.size())),
    );
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  get renderer(): Renderer {
    return this.webgl ? "webgl" : "dom";
  }

  get bracketedPaste(): boolean {
    return this.term.modes.bracketedPasteMode;
  }

  get alternateScreen(): boolean {
    return this.term.buffer.active.type === "alternate";
  }

  get cursor(): BufferPoint {
    const buffer = this.term.buffer.active;
    return { x: buffer.cursorX, line: buffer.baseY + buffer.cursorY };
  }

  get viewportLine(): number {
    return this.term.buffer.active.viewportY;
  }

  get bufferLength(): number {
    return this.term.buffer.active.length;
  }

  get imagesActive(): boolean {
    return this.images !== null;
  }

  /** The xterm instance, for tests and for addons the app may add later. */
  get xterm(): Terminal {
    return this.term;
  }

  mount(element: HTMLElement): void {
    this.element = element;
    this.term.open(element);
    this.renderers.mount();
    if (this.options.ligatures) this.setLigatures(true);
    this.fit();
    const textarea = this.term.textarea;
    if (textarea) {
      const onFocus = () => {
        this.focusChange.fire(true);
        this.renderers.retry();
      };
      const onBlur = () => this.focusChange.fire(false);
      textarea.addEventListener("focus", onFocus);
      textarea.addEventListener("blur", onBlur);
      this.subscriptions.push({
        dispose: () => {
          textarea.removeEventListener("focus", onFocus);
          textarea.removeEventListener("blur", onBlur);
        },
      });
    }
    this.observer = new ResizeObserver(() => {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.fit();
      });
    });
    this.observer.observe(element);
  }

  /** Called by the RendererController when the pane should hold a WebGL context. */
  private createWebgl(): RendererLease | null {
    if (this.disposed || !this.element) return null;
    try {
      const addon = new WebglAddon();
      const lease: RendererLease = {
        dispose: () => {
          if (this.webgl === addon) this.webgl = null;
          addon.dispose();
        },
      };
      // Fall back to the DOM renderer now; try WebGL again on the next focus.
      addon.onContextLoss(() => this.renderers.contextLost(lease));
      this.term.loadAddon(addon);
      this.webgl = addon;
      return lease;
    } catch {
      // No WebGL2 (blocklisted GPU, headless without GL): stay on the DOM renderer.
      this.webgl = null;
      return null;
    }
  }

  /** Loads or unloads the image addon (Sixel, iTerm2 inline images) with the memory limits. */
  private setImages(enabled: boolean): void {
    if (enabled && !this.images) {
      const addon = new ImageAddon({
        enableSizeReports: true,
        pixelLimit: IMAGE_LIMITS.pixelLimit,
        storageLimit: IMAGE_LIMITS.storageLimit,
        sixelSupport: true,
        sixelScrolling: true,
        sixelSizeLimit: IMAGE_LIMITS.sixelSizeLimit,
        iipSupport: true,
        iipSizeLimit: IMAGE_LIMITS.iipSizeLimit,
        showPlaceholder: true,
      });
      try {
        this.term.loadAddon(addon);
        this.images = addon;
      } catch (error) {
        // The addon compiles WebAssembly; a policy or runtime that refuses it must not take the terminal down.
        addon.dispose();
        console.warn("Inline images are unavailable:", error);
      }
    } else if (!enabled && this.images) {
      this.images.dispose();
      this.images = null;
    }
  }

  setVisible(visible: boolean): void {
    this.renderers.setVisible(visible);
  }

  onViewportChange(listener: () => void): Disposable {
    const render = this.term.onRender(() => listener());
    const scroll = this.term.onScroll(() => listener());
    return {
      dispose: () => {
        render.dispose();
        scroll.dispose();
      },
    };
  }

  grid(): { cellWidth: number; cellHeight: number; left: number; top: number } | null {
    const screen = this.element?.querySelector<HTMLElement>(".xterm-screen");
    if (!this.element || !screen || this.term.rows === 0) return null;
    const box = this.element.getBoundingClientRect();
    const rect = screen.getBoundingClientRect();
    return {
      cellWidth: rect.width / this.term.cols,
      cellHeight: rect.height / this.term.rows,
      left: rect.left - box.left,
      top: rect.top - box.top,
    };
  }

  private ligaturesWanted = false;

  /** Loads the ligatures addon on demand (its 200 KB load only when the setting is on). */
  private setLigatures(enabled: boolean): void {
    this.ligaturesWanted = enabled;
    if (enabled && !this.ligatures && this.element) {
      void import("@xterm/addon-ligatures/lib/addon-ligatures.mjs").then(({ LigaturesAddon: Addon }) => {
        if (this.disposed || !this.ligaturesWanted || this.ligatures) return;
        const addon = new Addon({ fontFeatureSettings: LIGATURE_FEATURES });
        this.term.loadAddon(addon);
        this.ligatures = addon;
        // The WebGL atlas picks up font features only when (re)activated after the ligatures addon.
        if (this.webgl) this.renderers.rebuild();
        this.term.refresh(0, this.term.rows - 1);
      });
    } else if (!enabled && this.ligatures) {
      this.ligatures.dispose();
      this.ligatures = null;
      this.term.refresh(0, this.term.rows - 1);
    }
  }

  /** Whether the ligatures addon is active (tests). */
  get ligaturesActive(): boolean {
    return this.ligatures !== null;
  }

  write(bytes: Uint8Array, onDone?: () => void): void {
    if (this.disposed) return;
    this.term.write(bytes, onDone);
  }

  fit(): void {
    if (this.disposed || !this.element || this.element.clientWidth === 0 || this.element.clientHeight === 0) return;
    const proposed = this.fitAddon.proposeDimensions();
    if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return;
    const cols = Math.max(2, proposed.cols);
    const rows = Math.max(1, proposed.rows);
    if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows);
  }

  private size(): EngineSize {
    const screen = this.element?.querySelector<HTMLElement>(".xterm-screen");
    return {
      cols: this.term.cols,
      rows: this.term.rows,
      pxWidth: Math.round(screen?.clientWidth ?? 0),
      pxHeight: Math.round(screen?.clientHeight ?? 0),
    };
  }

  focus(): void {
    this.term.focus();
  }

  blur(): void {
    this.term.blur();
  }

  setOptions(options: Partial<EngineOptions>): void {
    this.options = { ...this.options, ...options };
    Object.assign(this.term.options, toXtermOptions(options));
    if (options.ligatures !== undefined) this.setLigatures(options.ligatures);
    if (options.images !== undefined) this.setImages(options.images);
    if (options.renderer !== undefined) this.renderers.setWanted(options.renderer === "webgl");
    const geometry =
      options.fontFamily !== undefined || options.fontSize !== undefined || options.lineHeight !== undefined;
    if (geometry) this.fit();
  }

  onData(listener: (bytes: Uint8Array) => void): Disposable {
    const data = this.term.onData((text) => listener(encoder.encode(text)));
    const binary = this.term.onBinary((text) => listener(binaryToBytes(text)));
    return {
      dispose: () => {
        data.dispose();
        binary.dispose();
      },
    };
  }

  onResize(listener: (size: EngineSize) => void): Disposable {
    return this.resize.on(listener);
  }

  onTitle(listener: (title: string) => void): Disposable {
    return this.term.onTitleChange(listener);
  }

  onBell(listener: () => void): Disposable {
    return this.term.onBell(listener);
  }

  onFocusChange(listener: (focused: boolean) => void): Disposable {
    return this.focusChange.on(listener);
  }

  onOsc(code: number, handler: (data: string) => boolean): Disposable {
    return this.term.parser.registerOscHandler(code, handler);
  }

  onSelectionChange(listener: () => void): Disposable {
    return this.term.onSelectionChange(listener);
  }

  hasSelection(): boolean {
    return this.term.hasSelection();
  }

  getSelection(): string {
    return this.term.getSelection();
  }

  clearSelection(): void {
    this.term.clearSelection();
  }

  selectAll(): void {
    this.term.selectAll();
  }

  scrollToBottom(): void {
    this.term.scrollToBottom();
  }

  paste(text: string): void {
    this.term.paste(text);
  }

  findNext(term: string, options: SearchOptions): boolean {
    return this.searchAddon.findNext(term, { ...options, decorations: this.decorations() });
  }

  findPrevious(term: string, options: SearchOptions): boolean {
    return this.searchAddon.findPrevious(term, { ...options, decorations: this.decorations() });
  }

  private decorations() {
    const theme = this.options.theme;
    return {
      matchBackground: theme.selectionBackground.startsWith("#") ? theme.selectionBackground : undefined,
      matchOverviewRuler: theme.brightYellow,
      activeMatchBackground: theme.brightYellow,
      activeMatchColorOverviewRuler: theme.brightYellow,
      matchBorder: theme.yellow,
      activeMatchBorder: theme.foreground,
    };
  }

  clearSearch(): void {
    this.searchAddon.clearDecorations();
    this.term.clearSelection();
  }

  onSearchResults(listener: (results: SearchResults) => void): Disposable {
    return this.searchResults.on(listener);
  }

  setLinkHandlers(handlers: LinkHandlers | null): void {
    this.linkHandlers = handlers;
    this.pathProvider?.dispose();
    this.pathProvider = null;
    if (!handlers) return;
    const provider: ILinkProvider = {
      provideLinks: (y, callback) => {
        const line = this.term.buffer.active.getLine(y - 1);
        if (!line) return callback(undefined);
        const text = line.translateToString(true);
        const links: ILink[] = handlers.findPaths(text).map((match) => ({
          text: match.text,
          range: { start: { x: match.start + 1, y }, end: { x: match.end, y } },
          decorations: { underline: true, pointerCursor: true },
          activate: (event) => handlers.activate({ kind: "path", text: match.text }, event),
          hover: (event) => handlers.hover({ kind: "path", text: match.text }, event),
          leave: () => handlers.leave(),
        }));
        callback(links.length > 0 ? links : undefined);
      },
    };
    this.pathProvider = this.term.registerLinkProvider(provider);
  }

  screenText(): string {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  }

  registerMarker(offset = 0): EngineMarker | undefined {
    if (this.disposed || this.alternateScreen) return undefined;
    try {
      return this.term.registerMarker(offset);
    } catch {
      return undefined;
    }
  }

  registerDecoration(spec: DecorationSpec): EngineDecoration | undefined {
    if (this.disposed) return undefined;
    const decoration = this.term.registerDecoration({
      marker: spec.marker as IMarker,
      x: spec.x,
      width: spec.width,
      height: spec.height,
      layer: spec.layer,
    });
    if (!decoration) return undefined;
    return {
      get isDisposed() {
        return decoration.isDisposed;
      },
      onRender: (listener) => decoration.onRender(listener),
      dispose: () => decoration.dispose(),
    };
  }

  line(index: number): { text: string; wrapped: boolean } | null {
    const line = this.term.buffer.active.getLine(index);
    return line ? { text: line.translateToString(true), wrapped: line.isWrapped } : null;
  }

  scrollToLine(line: number): void {
    this.term.scrollToLine(Math.max(0, line));
  }

  selectLines(start: number, end: number): void {
    this.term.selectLines(Math.max(0, start), Math.max(0, end));
  }

  select(from: BufferPoint, length: number): void {
    this.term.select(from.x, from.line, length);
  }

  selectionRange(): { start: BufferPoint; end: BufferPoint } | null {
    const range = this.term.getSelectionPosition();
    if (!range) return null;
    // xterm reports 0-based columns and lines here.
    return { start: { x: range.start.x, line: range.start.y }, end: { x: range.end.x, line: range.end.y } };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderers.dispose();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    this.pathProvider?.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.resize.clear();
    this.focusChange.clear();
    this.searchResults.clear();
    this.term.dispose();
  }
}

/** Creates the default engine (TRD §4.2 `createTerminal`). */
export function createEngine(options: EngineOptions): TerminalEngine {
  return new XtermEngine(options);
}
