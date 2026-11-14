// TauriPtyClient: the PtyClient over the Rust PTY host (05-backend-schema §4.1). A thin adapter, nothing else.
//
//   spawn  → `commands.ptySpawn(spec, channel)`; the channel delivers binary frames (tag byte + payload, decoded by
//            `decodeFrame` in @tessera/ipc, layout in src-tauri/src/pty_commands.rs), never JSON.
//   write  → `ptyWrite`: raw bytes as the request body, session in the `x-session-id` header.
//   resize, ack, kill → typed commands.
import { Channel } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { commands, decodeFrame, IpcError, ptyWrite, unwrap } from "@tessera/ipc";
import { type PtyClient, PtyError, type PtyListener, type SessionId, type SpawnSpec } from "@tessera/term";
import { updatePtyDiagnostics } from "./ptyDiagnostics";

/** `~` is a UI convention; the host needs a real folder. */
async function resolveCwd(cwd: string): Promise<string> {
  if (cwd === "~" || cwd === "") return homeDir();
  if (cwd.startsWith("~/") || cwd.startsWith("~\\"))
    return `${(await homeDir()).replace(/[\\/]$/, "")}/${cwd.slice(2)}`;
  return cwd;
}

/** Maps a Rust error code (`pty.cwd_missing`, ...) to the PtyError kinds the pane understands. */
function toPtyError(cause: unknown): PtyError {
  if (cause instanceof IpcError) {
    const kind =
      cause.code === "pty.cwd_missing"
        ? "CwdMissing"
        : cause.code === "pty.program_not_found"
          ? "ProgramNotFound"
          : cause.code === "pty.unknown_session"
            ? "UnknownSession"
            : "SpawnFailed";
    return new PtyError(kind, cause.message);
  }
  return new PtyError("SpawnFailed", cause instanceof Error ? cause.message : String(cause));
}

function describeFrame(message: unknown): string {
  if (message instanceof ArrayBuffer) return `ArrayBuffer(${message.byteLength})`;
  if (ArrayBuffer.isView(message)) {
    return `${message.constructor.name}(byteLength=${message.byteLength}, byteOffset=${message.byteOffset})`;
  }
  if (Array.isArray(message)) return `Array(${message.length})`;
  return `${typeof message}: ${String(message).slice(0, 160)}`;
}

export class TauriPtyClient implements PtyClient {
  private channel(onEvent: PtyListener, diagnosticId?: string): Channel<never> {
    const channel = new Channel<never>();
    (channel as unknown as { onmessage: (message: unknown) => void }).onmessage = (message) => {
      const frame = decodeFrame(message);
      if (!frame) {
        if (diagnosticId) {
          updatePtyDiagnostics(diagnosticId, (current) => ({
            decodeErrors: current.decodeErrors + 1,
            lastDecodeError: describeFrame(message),
          }));
        }
        return;
      }
      if (diagnosticId) {
        updatePtyDiagnostics(diagnosticId, (current) => ({
          framesDecoded: current.framesDecoded + 1,
          bytesReceived: current.bytesReceived + (frame.kind === "data" ? frame.bytes.byteLength : 0),
        }));
      }
      if (frame.kind === "data") onEvent({ type: "data", bytes: frame.bytes });
      else onEvent({ type: "exit", code: frame.code });
    };
    return channel;
  }

  async attach(session: SessionId, onEvent: PtyListener): Promise<void> {
    try {
      unwrap(await commands.ptyAttach(session, this.channel(onEvent) as never));
    } catch (cause) {
      throw toPtyError(cause);
    }
  }

  async liveSession(paneId: string): Promise<SessionId | null> {
    try {
      return unwrap(await commands.ptyLiveSession(paneId));
    } catch {
      return null;
    }
  }

  async spawn(spec: SpawnSpec, onEvent: PtyListener): Promise<SessionId> {
    const channel = this.channel(onEvent, spec.diagnosticId);
    try {
      const cwd = await resolveCwd(spec.cwd);
      return unwrap(
        await commands.ptySpawn(
          {
            cwd,
            program: spec.program ?? null,
            args: spec.args ?? null,
            env: spec.env ?? null,
            cols: spec.cols,
            rows: spec.rows,
            task_id: spec.taskId ?? null,
            pane_id: spec.paneId ?? null,
          },
          channel as never,
        ),
      );
    } catch (cause) {
      throw toPtyError(cause);
    }
  }

  async write(session: SessionId, bytes: Uint8Array): Promise<void> {
    await ptyWrite(session, bytes);
  }

  async resize(session: SessionId, cols: number, rows: number, pxWidth: number, pxHeight: number): Promise<void> {
    unwrap(await commands.ptyResize(session, cols, rows, pxWidth, pxHeight));
  }

  async ack(session: SessionId, bytes: number): Promise<void> {
    unwrap(await commands.ptyAck(session, bytes));
  }

  async kill(session: SessionId): Promise<void> {
    unwrap(await commands.ptyKill(session));
  }
}
