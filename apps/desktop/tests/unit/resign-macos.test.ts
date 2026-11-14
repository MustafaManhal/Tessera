import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import * as resign from "../../../../scripts/resign-macos.mjs";

const { APP_IDENTIFIER, REQUIREMENT, helperRequirement, signCommands } = resign;

describe("macOS re-signing", () => {
  it("pins the designated requirement to the app identifier, not to one build", () => {
    expect(APP_IDENTIFIER).toBe("dev.tessera.terminal");
    expect(REQUIREMENT).toBe('designated => identifier "dev.tessera.terminal"');
    expect(REQUIREMENT).not.toContain("cdhash");
  });

  it("signs the helpers before the app so nested code stays valid", () => {
    const calls: string[][] = signCommands("/b/Tessera.app", "/e.plist", ["tessera", "tesserad"]);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.at(-1)).toBe(join("/b/Tessera.app", "Contents", "MacOS", "tessera"));
    expect(calls[1]?.at(-1)).toBe(join("/b/Tessera.app", "Contents", "MacOS", "tesserad"));
    expect(calls[2]?.at(-1)).toBe("/b/Tessera.app");
    expect(calls[2]).toContain(`-r=${REQUIREMENT}`);
    expect(calls[1]).toContain(`-r=${helperRequirement("tesserad")}`);
    expect(helperRequirement("tesserad")).not.toContain("cdhash");
    expect(calls[2]).toContain("/e.plist");
  });
});
