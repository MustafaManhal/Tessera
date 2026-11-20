import { describe, expect, it } from "vitest";
import { createAckAccounting } from "../../src/pty";

describe("ack accounting", () => {
  it("acks a trickle at once, when nothing else is in flight", () => {
    const acks = createAckAccounting(1000);
    acks.received(10);
    expect(acks.processed(10)).toBe(10);
    expect(acks.acked).toBe(10);
    expect(acks.inFlight).toBe(0);
  });

  it("batches while more is in flight, then acks the batch", () => {
    const acks = createAckAccounting(100);
    acks.received(60);
    acks.received(60);
    acks.received(60);
    expect(acks.processed(60)).toBe(0);
    expect(acks.pending).toBe(60);
    expect(acks.processed(60)).toBe(120);
    expect(acks.processed(60)).toBe(60);
    expect(acks.acked).toBe(180);
  });

  it("never acks more than was received", () => {
    const acks = createAckAccounting(10);
    acks.received(5);
    expect(acks.processed(50)).toBe(5);
    expect(acks.processed(5)).toBe(0);
    expect(acks.acked).toBe(5);
  });

  it("ignores zero and negative counts, and flush returns what is pending", () => {
    const acks = createAckAccounting(100);
    acks.received(-3);
    acks.received(0);
    expect(acks.inFlight).toBe(0);
    acks.received(50);
    acks.received(50);
    expect(acks.processed(-1)).toBe(0);
    expect(acks.processed(30)).toBe(0);
    expect(acks.flush()).toBe(30);
    expect(acks.flush()).toBe(0);
  });

  it("the total acked equals the total received once everything is processed", () => {
    const acks = createAckAccounting(4096);
    let sent = 0;
    for (let i = 1; i <= 500; i++) {
      acks.received(i * 7);
      sent += i * 7;
    }
    let acked = 0;
    for (let i = 1; i <= 500; i++) acked += acks.processed(i * 7);
    expect(acked).toBe(sent);
  });
});
