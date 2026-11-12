import { describe, expect, it } from "vitest";
import { summarizeLatency } from "../../src/terminal/latency";

describe("terminal latency summary", () => {
  it("reports nearest-rank percentiles and the active renderer", () => {
    expect(summarizeLatency([8, 1, 4, 3, 2, 5, 6, 7, 9, 10], "dom")).toEqual({
      n: 10,
      p50: 5,
      p95: 10,
      p99: 10,
      renderer: "dom",
      samples: [8, 1, 4, 3, 2, 5, 6, 7, 9, 10],
    });
  });

  it("has an empty summary before the first sample", () => {
    expect(summarizeLatency([], "webgl")).toEqual({
      n: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      renderer: "webgl",
      samples: [],
    });
  });
});
