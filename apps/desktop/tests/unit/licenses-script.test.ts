import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { npmPackages, rustPackages } from "../../../../scripts/licenses.mjs";

describe("licence list generation", () => {
  it("keeps only crates the app ships (normal dependencies) and reads their licence", () => {
    const metadata = {
      packages: [
        { id: "app", name: "tessera-desktop", version: "0.1.0", source: null, license: "MIT" },
        { id: "a", name: "serde", version: "1.0.0", source: "registry", license: "MIT OR Apache-2.0" },
        { id: "b", name: "cc", version: "1.0.0", source: "registry", license: "MIT" },
        { id: "c", name: "nolicense", version: "0.1.0", source: "registry", license: null },
        { id: "d", name: "pretty_assertions", version: "1.0.0", source: "registry", license: "MIT" },
      ],
      resolve: {
        nodes: [
          {
            id: "app",
            deps: [
              { pkg: "a", dep_kinds: [{ kind: null }] },
              { pkg: "b", dep_kinds: [{ kind: "build" }] },
              { pkg: "c", dep_kinds: [{ kind: null }] },
              { pkg: "d", dep_kinds: [{ kind: "dev" }] },
            ],
          },
          { id: "a", deps: [] },
          { id: "b", deps: [] },
          { id: "c", deps: [] },
          { id: "d", deps: [] },
        ],
      },
    };
    const found = rustPackages(metadata).map((p: { name: string; license: string }) => [p.name, p.license]);
    expect(found).toEqual([
      ["serde", "MIT OR Apache-2.0"],
      ["nolicense", "See the crate"],
    ]);
  });
  it("flattens pnpm's licence listing, one row per version", () => {
    const rows = npmPackages({
      MIT: [{ name: "react", versions: ["19.0.0", "18.3.1"] }],
      ISC: [{ name: "x", versions: ["1.0.0"] }],
    });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ name: "react", version: "19.0.0", license: "MIT", source: "npm" });
  });
});
