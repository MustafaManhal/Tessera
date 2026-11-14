import { defineConfig } from "vitest/config";

// One Vitest run for the whole repo (`pnpm test`). Each project has its own root so its include globs stay local.
export default defineConfig({
  test: {
    projects: [
      { test: { name: "scripts", include: ["scripts/lib/**/*.test.mjs"] } },
      {
        test: {
          name: "desktop",
          root: "apps/desktop",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "sync-worker",
          root: "services/sync",
          environment: "node",
          include: ["test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "packages",
          include: ["packages/*/tests/**/*.test.{ts,tsx}"],
          passWithNoTests: true,
        },
      },
    ],
  },
});
