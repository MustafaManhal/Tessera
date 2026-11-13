// Terminal wire helpers: the binary frames the Rust PTY host sends and the raw write call.
// The frame layout is the contract with apps/desktop/src-tauri/src/pty_commands.rs:
//   tag 0 = output data (rest of the frame is the bytes), tag 1 = exit (u32 little endian code).
import { invoke } from "@tauri-apps/api/core";

export const FRAME_DATA = 0;
export const FRAME_EXIT = 1;

/** One decoded frame from the terminal channel. */
export type PtyFrameEvent = { kind: "data"; bytes: Uint8Array } | { kind: "exit"; code: number };

/**
 * Decodes a frame. Tauri delivers raw channel messages as an `ArrayBuffer`; a plain array of numbers
 * (the JSON fallback) is accepted too. Returns `undefined` for an empty or unknown frame, never throws.
 */
export function decodeFrame(message: unknown): PtyFrameEvent | undefined {
  const bytes =
    message instanceof ArrayBuffer
      ? new Uint8Array(message)
      : ArrayBuffer.isView(message)
        ? new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
        : Array.isArray(message)
          ? Uint8Array.from(message as number[])
          : undefined;
  if (!bytes || bytes.length === 0) return undefined;
  if (bytes[0] === FRAME_DATA) return { kind: "data", bytes: bytes.subarray(1) };
  if (bytes[0] === FRAME_EXIT && bytes.length >= 5) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + 1, 4);
    return { kind: "exit", code: view.getUint32(0, true) };
  }
  return undefined;
}

/** Sends keystroke bytes to a session as the raw request body (no JSON encoding). */
export function ptyWrite(sessionId: string, bytes: Uint8Array): Promise<void> {
  return invoke<void>("pty_write", bytes, { headers: { "x-session-id": sessionId } });
}
