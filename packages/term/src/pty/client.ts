// The contract between a terminal pane and the process behind it (05-backend-schema §4.1, TRD §4.1).
//
// A pane calls `spawn` once with the size it measured and a listener; everything the session does comes back through
// that listener as `PtyEvent`s, in order. Keystrokes go out with `write` as raw bytes (`Uint8Array`), never JSON or
// strings, so nothing is re-encoded on the hot path (NFR-01). Output comes in as `data` events of raw bytes.
//
// Flow control: the host stops sending once a session has too many unacknowledged bytes in flight. The pane calls
// `ack(session, n)` only after xterm has *processed* `n` bytes (its `write` callback ran), so a slow renderer slows the
// shell down instead of growing an unbounded queue (NFR-02). Acks can be batched; the sum must match what was received.
//
// `resize` follows every change of the pane's grid; `kill` ends the session (closing a pane kills its session).
// Implementations: `FakePtyClient` (in-memory shell for development and tests) and the app's `TauriPtyClient`.

export type SessionId = string;

export type SessionKind = "shell" | "agent" | "run" | "setup" | "ssh";

export interface SpawnSpec {
  kind: SessionKind;
  /** Starting folder; the host reports `CwdMissing` if it does not exist. */
  cwd: string;
  /** Default: the user's login shell. */
  program?: string;
  args?: string[];
  env?: Record<string, string>;
  cols: number;
  rows: number;
  /** The layout pane the session runs in; the host saves its history under this id for restore after restart. */
  paneId?: string;
  /** The task the session belongs to; the host exports it as `TESSERA_TASK_ID` and ends it with the task. */
  taskId?: string;
  /** Debug diagnostics only; never forwarded to the process. */
  diagnosticId?: string;
}

export type PtyEvent =
  /** Output bytes, possibly coalesced from several reads. */
  | { type: "data"; bytes: Uint8Array }
  /** The process ended; no more events follow. */
  | { type: "exit"; code: number }
  /** A title the host parsed (OSC 0/2); the pane also parses titles itself. */
  | { type: "title"; text: string }
  /** A cwd the host learned (OSC 7 or the process table). */
  | { type: "cwd"; path: string };

export type PtyListener = (event: PtyEvent) => void;

/** Errors a spawn can fail with (the names the Rust side uses). */
export type SpawnErrorKind = "CwdMissing" | "ProgramNotFound" | "SpawnFailed";

export class PtyError extends Error {
  constructor(
    readonly kind: SpawnErrorKind | "UnknownSession",
    message: string,
  ) {
    super(message);
    this.name = "PtyError";
  }
}

export interface PtyClient {
  /** Starts a session; `onEvent` receives its events until `exit`. */
  spawn(spec: SpawnSpec, onEvent: PtyListener): Promise<SessionId>;
  /** Replaces the live subscriber and replays buffered output. */
  attach(session: SessionId, onEvent: PtyListener): Promise<void>;
  /**
   * A session from an earlier run of the app that still runs for this pane (the session daemon keeps sessions when the
   * app quits). Hosts without one omit this or resolve null.
   */
  liveSession?(paneId: string): Promise<SessionId | null>;
  /** Raw input bytes (keys, paste, dropped paths). */
  write(session: SessionId, bytes: Uint8Array): Promise<void>;
  /** The pane's new grid; pixel size helps programs that draw images. */
  resize(session: SessionId, cols: number, rows: number, pxWidth: number, pxHeight: number): Promise<void>;
  /** `bytes` more output bytes were processed by the terminal. */
  ack(session: SessionId, bytes: number): Promise<void>;
  /** Ends the session (SIGHUP by default). */
  kill(session: SessionId, signal?: string): Promise<void>;
}
