import { describe, expect, it } from "vitest";
import {
  createSettingsSlice,
  defaultTerminalSettings,
  LONG_COMMAND_SECONDS,
  type TerminalSettings,
} from "../../src/store/settingsSlice";

describe("settings: keys added in brief 08", () => {
  it("default to the planned values on every platform", () => {
    for (const platform of ["mac", "windows", "other"] as const) {
      expect(defaultTerminalSettings(platform)).toMatchObject({
        pasteConfirm: "multiline",
        osc52Write: "ask",
        images: true,
        blockGutter: true,
        longCommandAlert: true,
        longCommandSeconds: 30,
        notifications: true,
        secureKeyboardEntry: false,
      });
    }
  });

  it("clamp the long-command threshold and reject unknown enum values", () => {
    const slice = createSettingsSlice("mac");
    const apply = (patch: Partial<TerminalSettings>) =>
      slice.reducer(undefined, slice.actions.setTerminal(patch)).terminal;
    expect(apply({ longCommandSeconds: 0 }).longCommandSeconds).toBe(LONG_COMMAND_SECONDS.min);
    expect(apply({ longCommandSeconds: 10 ** 9 }).longCommandSeconds).toBe(LONG_COMMAND_SECONDS.max);
    expect(apply({ longCommandSeconds: 12.6 }).longCommandSeconds).toBe(13);
    expect(apply({ longCommandSeconds: Number.NaN }).longCommandSeconds).toBe(30);
    expect(apply({ pasteConfirm: "sometimes" as never }).pasteConfirm).toBe("multiline");
    expect(apply({ pasteConfirm: "always" }).pasteConfirm).toBe("always");
    expect(apply({ osc52Write: "maybe" as never }).osc52Write).toBe("ask");
    expect(apply({ osc52Write: "deny" }).osc52Write).toBe("deny");
    expect(apply({ blockGutter: false, images: false }).blockGutter).toBe(false);
  });
});
