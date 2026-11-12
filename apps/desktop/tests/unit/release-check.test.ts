import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import * as check from "../../../../scripts/release-check.mjs";

const { versions, notesEntryFor, rows } = check;

describe("release check", () => {
  it("reads the version from each file", () => {
    expect(
      versions({
        cargo: '[workspace.package]\nversion = "0.3.1"\nedition = "2024"\n',
        tauri: '{"version":"0.3.1"}',
        package: '{"version":"0.3.1"}',
      }),
    ).toEqual({ tauri: "0.3.1", cargo: "0.3.1", package: "0.3.1" });
  });
  it("finds the release entry for a version", () => {
    expect(notesEntryFor("0.1.0", 'RELEASES = [{ version: "0.1.0", date: "x" }]')).toBe(true);
    expect(notesEntryFor("0.2.0", 'RELEASES = [{ version: "0.1.0", date: "x" }]')).toBe(false);
    expect(notesEntryFor("1.0.0", 'version: "100"')).toBe(false);
  });
  it("the repository passes its own mechanical rows and lists the manual ones", () => {
    const result = rows();
    expect(result.filter((r: { status: string }) => r.status === "fail")).toEqual([]);
    expect(result.some((r: { status: string }) => r.status === "manual")).toBe(true);
    expect(result.map((r: { id: string }) => r.id)).toEqual(
      expect.arrayContaining(["version", "notes", "licenses", "network", "updater"]),
    );
  });
});
