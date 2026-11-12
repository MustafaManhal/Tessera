import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import * as lib from "../../../../scripts/release-lib.mjs";
// @ts-expect-error plain .mjs script without types
import * as pack from "../../../../scripts/package.mjs";

const { installers, MAX_INSTALLER_BYTES, oversized, signedAssets, updateManifest } = lib;
const { bundleOverride, helperTargets } = pack;

describe("release helpers", () => {
  it("finds installers and flags the ones over 25 MB", () => {
    const dir = mkdtempSync(join(tmpdir(), "tessera-size-"));
    mkdirSync(join(dir, "dmg"));
    writeFileSync(join(dir, "dmg", "Tessera_0.1.0_universal.dmg"), Buffer.alloc(1000));
    writeFileSync(join(dir, "Tessera_0.1.0_x64-setup.exe"), Buffer.alloc(2000));
    writeFileSync(join(dir, "notes.txt"), "not an installer");
    writeFileSync(join(dir, "rw.123.Tessera_0.1.0_aarch64.dmg"), Buffer.alloc(50_000_000));
    const files = installers(dir);
    expect(files.map((f: { path: string }) => basename(f.path)).sort()).toEqual([
      "Tessera_0.1.0_universal.dmg",
      "Tessera_0.1.0_x64-setup.exe",
    ]);
    expect(oversized(files)).toEqual([]);
    expect(oversized(files, 1500)).toHaveLength(1);
    expect(MAX_INSTALLER_BYTES).toBe(25_000_000);
  });

  it("builds the update manifest per platform, sharing the universal Mac bundle", () => {
    const manifest = updateManifest({
      version: "0.2.0",
      notes: "Notes",
      date: "2026-12-01T00:00:00Z",
      baseUrl: "https://example.com/dl",
      assets: [
        { name: "Tessera.app.tar.gz", signature: "SIG-MAC\n" },
        { name: "Tessera_0.2.0_x64-setup.exe", signature: "SIG-X64" },
        { name: "Tessera_0.2.0_arm64-setup.exe", signature: "SIG-ARM" },
        { name: "Tessera_0.2.0_x64_en-US.msi", signature: "IGNORED" },
      ],
    });
    expect(Object.keys(manifest.platforms).sort()).toEqual([
      "darwin-aarch64",
      "darwin-x86_64",
      "windows-aarch64",
      "windows-x86_64",
    ]);
    expect(manifest.platforms["darwin-aarch64"]).toEqual({
      signature: "SIG-MAC",
      url: "https://example.com/dl/Tessera.app.tar.gz",
    });
    expect(manifest.platforms["windows-aarch64"].signature).toBe("SIG-ARM");
    expect(manifest.version).toBe("0.2.0");
  });

  it("refuses a manifest without update bundles and reads signatures from disk", () => {
    expect(() => updateManifest({ version: "1", notes: "", date: "", baseUrl: "u", assets: [] })).toThrow();
    const dir = mkdtempSync(join(tmpdir(), "tessera-sig-"));
    writeFileSync(join(dir, "Tessera.app.tar.gz.sig"), "abc\n");
    writeFileSync(join(dir, "Tessera.app.tar.gz"), "bundle");
    expect(signedAssets(dir)).toEqual([{ name: "Tessera.app.tar.gz", signature: "abc\n" }]);
  });

  it("packages the helpers for every architecture of a universal Mac build", () => {
    expect(helperTargets("universal-apple-darwin", "aarch64-apple-darwin")).toEqual([
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
    ]);
    expect(helperTargets(undefined, "x86_64-pc-windows-msvc")).toEqual(["x86_64-pc-windows-msvc"]);
    expect(helperTargets("aarch64-pc-windows-msvc", "x86_64-pc-windows-msvc")).toEqual(["aarch64-pc-windows-msvc"]);
    expect(bundleOverride({ updater: false }).bundle.createUpdaterArtifacts).toBeUndefined();
    expect(bundleOverride({ updater: true }).bundle.createUpdaterArtifacts).toBe(true);
    expect(bundleOverride({ updater: false }).bundle.externalBin).toEqual(["binaries/tesserad", "binaries/tessera"]);
  });
});
