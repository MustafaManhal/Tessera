import { describe, expect, it } from "vitest";
import { MODE_RESET } from "../../src/restore/restored";

describe("restored history", () => {
  it("switches off every mode that would make the new shell print mouse reports", () => {
    for (const mode of [9, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 47, 1047, 1049]) {
      expect(MODE_RESET).toContain(`\x1b[?${mode}l`);
    }
    // The cursor comes back, and bracketed paste (the shell's own setting) is not touched.
    expect(MODE_RESET).toContain("\x1b[?25h");
    expect(MODE_RESET).not.toContain("2004");
  });
});

describe("REPORTING_RESET (a session kept by the daemon, re-attached)", () => {
  it("switches off every mouse and focus reporting mode and nothing else", async () => {
    const { REPORTING_RESET } = await import("../../src/restore/restored");
    for (const mode of [9, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 1016]) {
      expect(REPORTING_RESET).toContain(`\x1b[?${mode}l`);
    }
    // The alternate screen and the cursor stay as the replay left them: a program that still runs is on them.
    expect(REPORTING_RESET).not.toContain("1049");
    expect(REPORTING_RESET).not.toContain("?25");
  });
});
