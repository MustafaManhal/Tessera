import { describe, expect, it } from "vitest";
import { createIdGenerator, sequentialIds, ULID_PATTERN } from "../../src/layout";

describe("createIdGenerator", () => {
  it("makes 26-character Crockford base32 ids", () => {
    const id = createIdGenerator()();
    expect(id).toMatch(ULID_PATTERN);
    expect(id).not.toMatch(/[ILOU]/);
  });

  it("sorts by time and uses the injected clock and randomness", () => {
    let time = 1_700_000_000_000;
    const ids = createIdGenerator({ now: () => time, random: (bytes) => bytes.fill(0) });
    const first = ids();
    time += 1;
    const second = ids();
    expect(first < second).toBe(true);
    expect(first.slice(10)).toBe("0".repeat(16));
    // 1_700_000_000_000 ms in Crockford base32.
    expect(first.slice(0, 10)).toBe("01HF7YAT00");
  });

  it("does not repeat in a large sample", () => {
    const ids = createIdGenerator();
    const sample = new Set(Array.from({ length: 5000 }, () => ids()));
    expect(sample.size).toBe(5000);
  });
});

describe("sequentialIds", () => {
  it("counts with a prefix", () => {
    const ids = sequentialIds("p");
    expect([ids(), ids(), ids()]).toEqual(["p1", "p2", "p3"]);
  });
});
