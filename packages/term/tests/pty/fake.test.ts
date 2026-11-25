import { describe, expect, it, vi } from "vitest";
import { decodeForTests, FakePtyClient, type PtyEvent, PtyError } from "../../src/pty";

const enc = new TextEncoder();

async function shell(options?: ConstructorParameters<typeof FakePtyClient>[0], autoAck = true) {
  const client = new FakePtyClient(options);
  const events: PtyEvent[] = [];
  let text = "";
  const id = await client.spawn({ kind: "shell", cwd: "/home/you/shop", cols: 80, rows: 24 }, (event) => {
    events.push(event);
    if (event.type === "data") {
      text += decodeForTests(event.bytes);
      if (autoAck) void client.ack(id, event.bytes.length);
    }
  });
  const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
  const type = async (input: string) => {
    await client.write(id, enc.encode(input));
    await settle();
  };
  await settle();
  return { client, id, events, type, settle, text: () => text };
}

describe("FakePtyClient", () => {
  it("greets with a prompt carrying OSC 7, OSC 0, OSC 133 and bracketed paste on", async () => {
    const { text, events } = await shell();
    expect(text()).toContain("\x1b]7;file://localhost/home/you/shop\x07");
    expect(text()).toContain("\x1b]0;shop\x07");
    expect(text()).toContain("\x1b]133;A\x07");
    expect(text()).toContain("\x1b[?2004h");
    expect(events).toContainEqual({ type: "cwd", path: "/home/you/shop" });
  });

  it("echoes typing, edits with Backspace and runs commands with marks around them", async () => {
    const { type, text } = await shell();
    await type("ecxo\x7f\x7fho hi\r");
    expect(text()).toContain("ecxo\b \b\b \bho hi");
    expect(text()).toContain("\x1b]633;E;echo hi\x07\x1b]133;C\x07");
    expect(text()).toContain("hi\r\n\x1b]133;D;0\x07");
  });

  it("strips bracketed-paste markers and records the raw bytes", async () => {
    const { client, type, text } = await shell();
    await type("\x1b[200~echo pasted\x1b[201~\r");
    expect(text()).toContain("pasted\r\n");
    expect(decodeForTests(client.log.writes[0]?.bytes ?? new Uint8Array())).toBe("\x1b[200~echo pasted\x1b[201~\r");
  });

  it("reports unknown commands with code 127 and changes folder with cd", async () => {
    const { type, text, events } = await shell();
    await type("nope\r");
    expect(text()).toContain("command not found: nope");
    expect(text()).toContain("\x1b]133;D;127\x07");
    await type("cd /tmp\r");
    expect(events).toContainEqual({ type: "cwd", path: "/tmp" });
  });

  it("exit ends the session with the code", async () => {
    const { type, events } = await shell();
    await type("exit 3\r");
    await new Promise((r) => setTimeout(r, 30));
    expect(events.at(-1)).toEqual({ type: "exit", code: 3 });
  });

  it("serve runs until Ctrl+C", async () => {
    const { type, text } = await shell();
    await type("serve\r");
    expect(text()).toContain("Listening on");
    expect(text().endsWith("$ \x1b]133;B\x07\x1b[?2004h")).toBe(false);
    await type("ignored");
    expect(text()).not.toContain("ignored");
    await type("\x03");
    expect(text()).toContain("^C\r\n\x1b]133;D;130\x07");
  });

  it("flood pauses at the high-water mark until acks arrive (flow control)", async () => {
    const { client, id, type, events, settle } = await shell({ highWater: 64 * 1024, chunkBytes: 8 * 1024 }, false);
    await type("flood 20000\r");
    await settle(50);
    const before = events.filter((e) => e.type === "data").length;
    expect(client.unacked(id)).toBeGreaterThanOrEqual(64 * 1024);
    await settle(50);
    expect(events.filter((e) => e.type === "data").length).toBe(before);
    await client.ack(id, client.unacked(id));
    await settle(50);
    expect(events.filter((e) => e.type === "data").length).toBeGreaterThan(before);
  });

  it("delivers all of a flood when acks keep up", async () => {
    const { type, text, settle } = await shell({ highWater: 32 * 1024 });
    await type("flood 3000\r");
    for (let i = 0; i < 100 && !text().includes("\x1b]133;D;0"); i++) await settle(20);
    expect(text()).toContain("   3000\x1b[0m");
    expect(text()).toContain("\x1b]133;D;0\x07");
  });

  it("records resize and kill, and rejects writes to a killed session", async () => {
    const { client, id } = await shell();
    await client.resize(id, 100, 30, 800, 600);
    await client.kill(id);
    expect(client.log.resizes).toEqual([{ session: id, cols: 100, rows: 30 }]);
    expect(client.log.kills).toEqual([id]);
    await expect(client.write(id, enc.encode("x"))).rejects.toBeInstanceOf(PtyError);
  });

  it("refuses a relative cwd like the real host refuses a missing one", async () => {
    const client = new FakePtyClient();
    await expect(client.spawn({ kind: "shell", cwd: "relative", cols: 80, rows: 24 }, () => {})).rejects.toMatchObject({
      kind: "CwdMissing",
    });
  });

  it("accepts absolute Windows drive and UNC cwd paths", async () => {
    const client = new FakePtyClient();
    const paths = ["C:/Users/me/work", "\\\\server\\share\\project"];
    const cwdEvents: string[] = [];

    for (const cwd of paths) {
      await client.spawn({ kind: "shell", cwd, cols: 80, rows: 24 }, (event) => {
        if (event.type === "cwd") cwdEvents.push(event.path);
      });
    }

    expect(client.log.spawns.map((spawn) => spawn.cwd)).toEqual(paths);
    expect(cwdEvents).toEqual(paths);
  });

  it("prints realistic blocks: ok, fail N, sleep N and a continued multi-line command", async () => {
    const { type, text, settle } = await shell();
    await type("ok\r");
    expect(text()).toContain("12 checks passed\r\n\x1b]133;D;0\x07");
    await type("fail 2\r");
    expect(text()).toContain("\x1b]133;D;2\x07");
    await type("sleep 0.05\r");
    expect(text()).not.toContain("633;E;sleep 0.05\x07\x1b]133;C\x07\x1b]133;D");
    await settle(80);
    expect(text()).toContain("633;E;sleep 0.05\x07\x1b]133;C\x07\x1b]133;D;0\x07");
    await type("echo one \\\r");
    expect(text()).toContain("\x1b]133;A;k=s\x07> \x1b]133;B\x07");
    await type("two\r");
    expect(text()).toContain("\x1b]633;E;echo one \\\\\\x0atwo\x07");
    expect(text()).toContain("one two\r\n");
  });

  it("Ctrl+C stops sleep with exit 130", async () => {
    const { type, text, settle } = await shell();
    await type("sleep 5\r");
    await type("\x03");
    await settle();
    expect(text()).toContain("^C\r\n\x1b]133;D;130\x07");
  });

  it("prints notifications, progress, OSC 52, images and many blocks", async () => {
    const { type, text } = await shell();
    await type("notify hi there\r");
    expect(text()).toContain("\x1b]9;hi there\x1b\\");
    await type("notify 777 Build\r");
    expect(text()).toContain("\x1b]777;notify;Build;from OSC 777\x1b\\");
    await type("notify 99 Done\r");
    expect(text()).toContain("\x1b]99;i=1:d=0;Done\x1b\\\x1b]99;i=1:p=body;");
    await type("progress 40\r");
    expect(text()).toContain("\x1b]9;4;1;40\x1b\\");
    await type("progress error\r");
    expect(text()).toContain("\x1b]9;4;2;\x1b\\");
    await type("osc52 hello\r");
    expect(text()).toContain(`\x1b]52;c;${btoa("hello")}\x1b\\`);
    await type("osc52 --read\r");
    expect(text()).toContain("\x1b]52;c;?\x1b\\");
    await type("image\r");
    expect(text()).toContain("\x1bP0;1;0q");
    expect(text()).toContain("\x1b]1337;File=inline=1;");
    await type("blocks 3\r");
    expect(text().split("\x1b]633;E;echo ").length - 1).toBeGreaterThanOrEqual(3);
  });
});

it("replays scrollback on attach before sending later output to the replacement listener", async () => {
  const client = new FakePtyClient();
  const old: string[] = [];
  const next: string[] = [];
  const id = await client.spawn({ kind: "shell", cwd: "/test", cols: 80, rows: 24 }, (event) => {
    if (event.type === "data") old.push(decodeForTests(event.bytes));
  });
  await vi.waitFor(() => expect(old.join("")).toContain("fake shell"));
  await client.attach(id, (event) => {
    if (event.type === "data") next.push(decodeForTests(event.bytes));
  });
  expect(next.join("")).toBe(old.join(""));
  await client.write(id, new TextEncoder().encode("echo after attach\r"));
  await vi.waitFor(() => expect(next.join("")).toContain("\x07after attach\r\n"));
  expect(old.join("")).not.toContain("after attach");
  expect(client.log.kills).toEqual([]);
});
