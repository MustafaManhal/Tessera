// When a pane holds a WebGL context (NFR-13). Chromium and WebKit keep only about 16 live WebGL contexts per page and
// drop the oldest past that, so a pane that is not on screen (another tab, or hidden by a zoomed pane) gives its
// context back and takes a new one when it is shown again. Pure: `create` makes the context, the result's `dispose`
// releases it; unit-tested with a counting stub.

export interface RendererLease {
  dispose(): void;
}

export interface RendererControllerOptions {
  /** Makes a WebGL renderer; null when WebGL is unavailable (the DOM renderer stays). */
  create: () => RendererLease | null;
}

export class RendererController {
  private lease: RendererLease | null = null;
  private wanted = true;
  private visible = true;
  private lost = false;
  private mounted = false;

  constructor(private readonly options: RendererControllerOptions) {}

  get active(): boolean {
    return this.lease !== null;
  }

  mount(): void {
    this.mounted = true;
    this.update();
  }

  /** The `terminal.renderer` setting: false forces the DOM renderer. */
  setWanted(wanted: boolean): void {
    this.wanted = wanted;
    this.update();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) this.lost = false;
    this.update();
  }

  /** The context was lost: fall back to DOM until the next `retry` (focus) or show. */
  contextLost(lease: RendererLease): void {
    if (this.lease !== lease) return;
    this.lease = null;
    lease.dispose();
    this.lost = true;
  }

  retry(): void {
    if (!this.lost) return;
    this.lost = false;
    this.update();
  }

  /** Recreates the context (the ligatures addon needs the atlas built after it). */
  rebuild(): void {
    this.release();
    this.update();
  }

  dispose(): void {
    this.mounted = false;
    this.release();
  }

  private update(): void {
    const should = this.mounted && this.wanted && this.visible && !this.lost;
    if (should && !this.lease) this.lease = this.options.create();
    else if (!should) this.release();
  }

  private release(): void {
    const lease = this.lease;
    this.lease = null;
    lease?.dispose();
  }
}
