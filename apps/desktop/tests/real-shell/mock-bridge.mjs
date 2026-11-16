import { createHash } from "node:crypto";
import { createServer } from "node:http";

const args = new Map(
  process.argv.slice(2).reduce((entries, value, index, list) => {
    if (value.startsWith("--")) entries.push([value.slice(2), list[index + 1]]);
    return entries;
  }, []),
);
const port = Number(args.get("port") ?? process.env.TESSERA_BRIDGE_PORT ?? 0);
const token = args.get("token") ?? process.env.TESSERA_BRIDGE_TOKEN;
if (!Number.isInteger(port) || port < 1 || port > 65_535 || !token) {
  throw new Error("Usage: node mock-bridge.mjs --port PORT --token TOKEN");
}

const connections = new Set();
const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  if (request.url === "/stats") {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ connections: connections.size }));
    return;
  }
  response.writeHead(404).end();
});

server.on("upgrade", (request, socket) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  const key = request.headers["sec-websocket-key"];
  if (url.searchParams.get("token") !== token || typeof key !== "string") {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const connection = { socket, buffer: Buffer.alloc(0), session: null };
  connections.add(connection);
  socket.on("data", (chunk) => receive(connection, chunk));
  socket.on("close", () => connections.delete(connection));
  socket.on("error", () => connections.delete(connection));
});

function frame(opcode, payload = Buffer.alloc(0)) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (bytes.length < 126) {
    header = Buffer.from([0x80 | opcode, bytes.length]);
  } else if (bytes.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(bytes.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(bytes.length), 2);
  }
  return Buffer.concat([header, bytes]);
}

function send(connection, opcode, payload) {
  if (!connection.socket.destroyed) connection.socket.write(frame(opcode, payload));
}

function data(connection, text) {
  const payload = Buffer.concat([Buffer.from([0]), Buffer.from(text)]);
  send(connection, 2, payload);
}

function exit(connection, code) {
  const payload = Buffer.alloc(5);
  payload[0] = 1;
  payload.writeUInt32LE(code >>> 0, 1);
  send(connection, 2, payload);
}

function receive(connection, chunk) {
  connection.buffer = Buffer.concat([connection.buffer, chunk]);
  while (connection.buffer.length >= 2) {
    const first = connection.buffer[0];
    const second = connection.buffer[1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (connection.buffer.length < 4) return;
      length = connection.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (connection.buffer.length < 10) return;
      const wide = connection.buffer.readBigUInt64BE(2);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) {
        connection.socket.destroy();
        return;
      }
      length = Number(wide);
      offset = 10;
    }
    const maskOffset = offset;
    if (masked) offset += 4;
    if (connection.buffer.length < offset + length) return;
    const payload = Buffer.from(connection.buffer.subarray(offset, offset + length));
    if (masked) {
      const mask = connection.buffer.subarray(maskOffset, maskOffset + 4);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    }
    connection.buffer = connection.buffer.subarray(offset + length);

    if (opcode === 8) {
      send(connection, 8, payload);
      connection.socket.end();
    } else if (opcode === 9) {
      send(connection, 10, payload);
    } else if (opcode === 1) {
      try {
        message(connection, JSON.parse(payload.toString("utf8")));
      } catch {
        connection.socket.destroy();
      }
    } else if (opcode === 2) {
      input(connection, payload);
    } else if (opcode !== 10 && opcode !== 0) {
      connection.socket.destroy();
    }
  }
}

function message(connection, value) {
  if (!connection.session) {
    if (
      !value ||
      typeof value !== "object" ||
      !Number.isInteger(value.cols) ||
      !Number.isInteger(value.rows) ||
      typeof value.cwd !== "string" ||
      value.integration !== true
    ) {
      connection.socket.destroy();
      return;
    }
    connection.session = {
      cwd: value.cwd === "~" ? "/Users/test" : value.cwd,
      cols: value.cols,
      rows: value.rows,
      input: "",
      ended: false,
    };
    data(
      connection,
      `\x1b]0;Tessera Mock Shell\x07\x1b]7;file://localhost${encodeURI(connection.session.cwd)}\x07\x1b]133;A\x07mock$ \x1b]133;B\x07`,
    );
    return;
  }
  if (value?.type === "resize" && Number.isInteger(value.cols) && Number.isInteger(value.rows)) {
    connection.session.cols = value.cols;
    connection.session.rows = value.rows;
  } else if (value?.type === "kill") {
    connection.session.ended = true;
    exit(connection, 0);
    connection.socket.end();
  }
}

function input(connection, bytes) {
  const session = connection.session;
  if (!session || session.ended) return;
  for (const byte of bytes) {
    if (byte === 13 || byte === 10) {
      data(connection, "\r\n");
      const command = session.input;
      session.input = "";
      void runCommand(connection, command);
    } else if (byte === 127 || byte === 8) {
      session.input = session.input.slice(0, -1);
      data(connection, "\b \b");
    } else if (byte >= 32) {
      const char = Buffer.from([byte]).toString("utf8");
      session.input += char;
      data(connection, char);
    }
  }
}

function oscCommand(command) {
  return command.replaceAll("\\", "\\\\").replaceAll(";", "\\x3b");
}

async function runCommand(connection, command) {
  const session = connection.session;
  if (!session || session.ended) return;
  data(connection, `\x1b]633;E;${oscCommand(command)}\x07\x1b]133;C\x07`);

  if (command.startsWith("cd ")) {
    const target = command
      .slice(3)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
    session.cwd = target === "~" ? "/Users/test" : target === "$env:TEMP" ? (process.env.TEMP ?? "C:\\Temp") : target;
  } else if (/^(?:sleep|Start-Sleep)/i.test(command)) {
    const duration = Number(command.match(/[\d.]+/)?.[0] ?? 0);
    await new Promise((resolve) => setTimeout(resolve, Math.min(duration * 1000, 3_000)));
  } else if (/^(?:seq 1 100000|1\.\.100000)/.test(command)) {
    data(connection, "1\r\n2\r\n3\r\n...\r\n100000\r\n");
  } else {
    const title = command.match(/tessera-title(?:(?:\\a)|(?:\\x07)|(?:\[char\]7))?/i);
    if (title) data(connection, "\x1b]0;tessera-title\x07");
    if (/^(?:false|cmd \/c exit 1|throw )/i.test(command)) {
      data(connection, "command failed\r\n");
    } else if (/^echo(?:\s|$)/i.test(command)) {
      data(connection, `${command.replace(/^echo\s*/i, "")}\r\n`);
    } else if (/^(?:pwd|Get-Location)$/i.test(command)) {
      data(connection, `${session.cwd}\r\n`);
    } else if (/^(?:stty size|.*WindowSize.*)$/i.test(command)) {
      data(connection, `${session.rows} ${session.cols}\r\n`);
    } else if (command.startsWith("printf ")) {
      const output = command.match(/printf\s+['"]([^'"]*)['"]/)?.[1] ?? "";
      data(connection, `${output.replaceAll("\\n", "\r\n")}\r\n`);
    } else if (command) {
      data(connection, "mock command completed\r\n");
    }
  }

  if (/^(?:cd|Set-Location)\b/.test(command)) {
    const path = session.cwd.startsWith("/") ? `file://localhost${encodeURI(session.cwd)}` : `file://${session.cwd}`;
    data(connection, `\x1b]7;${path}\x07`);
  }
  const code = /^(?:false|cmd \/c exit 1|throw )/i.test(command) ? 1 : 0;
  data(connection, `\x1b]133;D;${code}\x07`);
  data(connection, `\x1b]7;file://localhost${encodeURI(session.cwd)}\x07\x1b]133;A\x07mock$ \x1b]133;B\x07`);
}

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`listening ${port}\n`);
});

function shutdown() {
  for (const connection of connections) connection.socket.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
