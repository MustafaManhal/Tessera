import { PtyError, type PtyClient, type PtyEvent, type PtyListener, type SessionId, type SpawnSpec } from "./client";

export interface PtyWebSocket {
  binaryType: BinaryType;
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

export type PtyWebSocketFactory = (url: string) => PtyWebSocket;

interface Connection {
  socket: PtyWebSocket;
  listener: PtyListener;
  ended: boolean;
  history: Uint8Array[];
  historyBytes: number;
  unacked: number;
  replayCredit: number;
}

/** Development client for the loopback PTY bridge used by real-shell browser tests. */
export class WebSocketPtyClient implements PtyClient {
  private readonly connections = new Map<SessionId, Connection>();
  private nextSession = 1;
  private readonly url: string;

  constructor(
    url: string,
    token: string,
    private readonly createSocket: PtyWebSocketFactory = (address) => new WebSocket(address),
    private readonly defaultShell?: string,
  ) {
    const bridge = new URL(url);
    if (bridge.protocol !== "ws:" || bridge.hostname !== "127.0.0.1") {
      throw new Error("The PTY test bridge must use ws://127.0.0.1");
    }
    if (!token) throw new Error("The PTY test bridge token is required");
    bridge.searchParams.set("token", token);
    this.url = bridge.toString();
  }

  async spawn(spec: SpawnSpec, onEvent: PtyListener): Promise<SessionId> {
    const socket = this.createSocket(this.url);
    socket.binaryType = "arraybuffer";
    const id = `ws-${this.nextSession++}`;
    const connection: Connection = {
      socket,
      listener: onEvent,
      ended: false,
      history: [],
      historyBytes: 0,
      unacked: 0,
      replayCredit: 0,
    };
    this.connections.set(id, connection);

    try {
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new PtyError("SpawnFailed", "Could not connect to the PTY test bridge"));
        socket.onclose = () => reject(new PtyError("SpawnFailed", "The PTY test bridge closed before starting"));
      });
      socket.onmessage = (event) => this.receive(id, event.data);
      socket.onerror = () => this.finish(id, -1);
      socket.onclose = () => this.finish(id, -1);
      socket.send(
        JSON.stringify({
          cols: spec.cols,
          rows: spec.rows,
          cwd: spec.cwd,
          shell: spec.program ?? this.defaultShell,
          integration: true,
        }),
      );
      return id;
    } catch (cause) {
      this.connections.delete(id);
      socket.close();
      if (cause instanceof PtyError) throw cause;
      throw new PtyError("SpawnFailed", cause instanceof Error ? cause.message : String(cause));
    }
  }

  /** The dev bridge connection belongs to this client and can replace its local listener. */
  async attach(session: SessionId, onEvent: PtyListener): Promise<void> {
    const connection = this.requireOpen(session);
    connection.listener = onEvent;
    connection.replayCredit = Math.max(0, connection.historyBytes - connection.unacked);
    for (const bytes of connection.history) onEvent({ type: "data", bytes: bytes.slice() });
  }

  async write(session: SessionId, bytes: Uint8Array): Promise<void> {
    this.requireOpen(session).socket.send(bytes);
  }

  async resize(session: SessionId, cols: number, rows: number, _pxWidth: number, _pxHeight: number): Promise<void> {
    this.sendControl(session, { type: "resize", cols, rows });
  }

  async ack(session: SessionId, bytes: number): Promise<void> {
    const connection = this.requireOpen(session);
    const replay = Math.min(connection.replayCredit, bytes);
    connection.replayCredit -= replay;
    const live = Math.min(connection.unacked, bytes - replay);
    if (live > 0) {
      this.sendControl(session, { type: "ack", bytes: live });
      connection.unacked -= live;
    }
  }

  async kill(session: SessionId): Promise<void> {
    const connection = this.connections.get(session);
    if (!connection || connection.ended) return;
    connection.socket.send(JSON.stringify({ type: "kill" }));
    connection.ended = true;
    connection.socket.close();
    this.connections.delete(session);
  }

  private sendControl(session: SessionId, message: object): void {
    this.requireOpen(session).socket.send(JSON.stringify(message));
  }

  private requireOpen(session: SessionId): Connection {
    const connection = this.connections.get(session);
    if (!connection || connection.ended || connection.socket.readyState !== WebSocket.OPEN) {
      throw new PtyError("UnknownSession", `PTY bridge session ${session} is not open`);
    }
    return connection;
  }

  private receive(session: SessionId, payload: unknown): void {
    const connection = this.connections.get(session);
    if (!connection || connection.ended) return;
    const frame = decodeBridgeFrame(payload);
    if (!frame) {
      connection.socket.close(1003, "Invalid PTY frame");
      this.finish(session, -1);
      return;
    }
    if (frame.type === "data") {
      connection.unacked += frame.bytes.length;
      connection.history.push(frame.bytes.slice());
      connection.historyBytes += frame.bytes.length;
      while (connection.historyBytes > 2 * 1024 * 1024) {
        connection.historyBytes -= connection.history.shift()?.length ?? 0;
      }
    }
    connection.listener(frame);
    if (frame.type === "exit") {
      connection.ended = true;
      this.connections.delete(session);
    }
  }

  private finish(session: SessionId, code: number): void {
    const connection = this.connections.get(session);
    if (!connection || connection.ended) return;
    connection.ended = true;
    this.connections.delete(session);
    connection.listener({ type: "exit", code });
  }
}

export function decodeBridgeFrame(payload: unknown): PtyEvent | undefined {
  let bytes: Uint8Array;
  if (payload instanceof ArrayBuffer) bytes = new Uint8Array(payload);
  else if (ArrayBuffer.isView(payload)) bytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  else return undefined;
  if (bytes.length === 0) return undefined;
  if (bytes[0] === 0) return { type: "data", bytes: bytes.subarray(1) };
  if (bytes[0] === 1 && bytes.length === 5) {
    return { type: "exit", code: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, true) };
  }
  return undefined;
}
