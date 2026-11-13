import { describe, expect, it, vi } from "vitest";
import { WebSocketPtyClient, decodeBridgeFrame, type PtyWebSocket } from "../../src/pty/websocket";

class FakeSocket implements PtyWebSocket {
  binaryType: BinaryType = "blob";
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: (string | ArrayBufferLike | Blob | ArrayBufferView)[] = [];

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  message(data: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.(new Event("close") as CloseEvent);
  }
}

describe("WebSocket PTY bridge", () => {
  it("sends the shell configuration, raw input, controls, and decodes output frames", async () => {
    const socket = new FakeSocket();
    const createSocket = vi.fn(() => socket);
    const client = new WebSocketPtyClient("ws://127.0.0.1:9412", "test-token", createSocket);
    const events: unknown[] = [];
    const starting = client.spawn({ kind: "shell", cwd: "/tmp", program: "zsh", cols: 80, rows: 24 }, (event) =>
      events.push(event),
    );

    expect(createSocket).toHaveBeenCalledWith("ws://127.0.0.1:9412/?token=test-token");
    expect(socket.binaryType).toBe("arraybuffer");
    socket.open();
    const session = await starting;
    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      cols: 80,
      rows: 24,
      cwd: "/tmp",
      shell: "zsh",
      integration: true,
    });

    await client.write(session, Uint8Array.from([101, 99, 104, 111]));
    await client.resize(session, 100, 30, 800, 600);
    socket.message(Uint8Array.from([0, 111, 107]).buffer);
    await client.ack(session, 2);
    expect(socket.sent.slice(1)).toEqual([
      Uint8Array.from([101, 99, 104, 111]),
      JSON.stringify({ type: "resize", cols: 100, rows: 30 }),
      JSON.stringify({ type: "ack", bytes: 2 }),
    ]);

    socket.message(Uint8Array.from([1, 7, 0, 0, 0]).buffer);
    expect(events).toEqual([
      { type: "data", bytes: Uint8Array.from([111, 107]) },
      { type: "exit", code: 7 },
    ]);
  });

  it("rejects non-loopback bridge URLs and malformed frames", () => {
    expect(() => new WebSocketPtyClient("wss://example.com", "token")).toThrow("ws://127.0.0.1");
    expect(decodeBridgeFrame(new ArrayBuffer(0))).toBeUndefined();
    expect(decodeBridgeFrame(new TextEncoder().encode("not binary"))).toBeUndefined();
    expect(decodeBridgeFrame(Uint8Array.from([1, 7]).buffer)).toBeUndefined();
  });

  it("decodes a typed view with an offset and sends an explicit kill", async () => {
    const backing = Uint8Array.from([99, 0, 65, 66, 99]);
    expect(decodeBridgeFrame(new Uint8Array(backing.buffer, 1, 3))).toEqual({
      type: "data",
      bytes: Uint8Array.from([65, 66]),
    });

    const socket = new FakeSocket();
    const client = new WebSocketPtyClient("ws://127.0.0.1:9412", "test-token", () => socket);
    const starting = client.spawn({ kind: "shell", cwd: "~", cols: 80, rows: 24 }, () => {});
    socket.open();
    const session = await starting;
    await client.kill(session);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "kill" }));
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("uses the dev shell override only when the spawn spec has no program", async () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    let nextSocket = 0;
    const client = new WebSocketPtyClient(
      "ws://127.0.0.1:9412",
      "test-token",
      () => sockets[nextSocket++] as FakeSocket,
      "bash",
    );
    const defaultStarting = client.spawn({ kind: "shell", cwd: "~", cols: 80, rows: 24 }, () => {});
    sockets[0]?.open();
    await defaultStarting;
    expect(JSON.parse(sockets[0]?.sent[0] as string).shell).toBe("bash");

    const explicitStarting = client.spawn({ kind: "shell", cwd: "~", program: "zsh", cols: 80, rows: 24 }, () => {});
    sockets[1]?.open();
    await explicitStarting;
    expect(JSON.parse(sockets[1]?.sent[0] as string).shell).toBe("zsh");
  });
});
