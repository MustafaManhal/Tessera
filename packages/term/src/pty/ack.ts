// Ack accounting for PTY flow control. Bytes are counted when they arrive and acknowledged once the terminal has
// processed them (xterm's write callback). Acks are batched, so a flood does not send one IPC call per chunk, but a
// trickle is acknowledged at once, so the host never waits on a small remainder.

export interface AckAccounting {
  /** Bytes received and not yet processed. */
  readonly inFlight: number;
  /** Bytes processed and not yet acknowledged. */
  readonly pending: number;
  /** Total acknowledged so far. */
  readonly acked: number;
  received(bytes: number): void;
  /** Call from the write callback; returns how many bytes to ack now (0: keep batching). */
  processed(bytes: number): number;
  /** Returns whatever is pending (e.g. on an idle tick) and clears it. */
  flush(): number;
}

/** Batch size: ack once this much has been processed, or as soon as nothing else is in flight. */
export const ACK_BATCH_BYTES = 64 * 1024;

export function createAckAccounting(batch = ACK_BATCH_BYTES): AckAccounting {
  let inFlight = 0;
  let pending = 0;
  let acked = 0;
  const take = () => {
    const out = pending;
    pending = 0;
    acked += out;
    return out;
  };
  return {
    get inFlight() {
      return inFlight;
    },
    get pending() {
      return pending;
    },
    get acked() {
      return acked;
    },
    received(bytes) {
      if (bytes > 0) inFlight += bytes;
    },
    processed(bytes) {
      if (bytes <= 0) return 0;
      const done = Math.min(bytes, inFlight);
      inFlight -= done;
      pending += done;
      return pending >= batch || inFlight === 0 ? take() : 0;
    },
    flush() {
      return take();
    },
  };
}
