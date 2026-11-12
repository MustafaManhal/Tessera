// What's new (FR-75): the notes of every release, newest first. Add an entry per release before building it; the
// dialog shows the entry of the running version and offers the earlier ones.
export interface ReleaseNotes {
  version: string;
  date: string;
  highlights: string[];
}

export const RELEASES: ReleaseNotes[] = [
  {
    version: "0.1.3",
    date: "2026-11-12",
    highlights: [
      "A task can work on a branch that is already checked out in another folder: it uses that folder instead of failing.",
      "Installing the command-line tool replaces a link left by a deleted copy of the app instead of refusing.",
    ],
  },
  {
    version: "0.1.2",
    date: "2026-11-12",
    highlights: [
      "A new look, Nebula for dark and Daybreak for light, with gradient buttons and tinted panels.",
      "Settings are picked from lists, switches and chips instead of typed, so a wrong value can no longer break the app.",
      "A new task can work on a branch that already exists, and the base branch is a list of the repository's branches.",
      "Agents you installed from another terminal, a version manager or an installer are found without installing them again.",
      "Agent logos in the Agents page, task rows and pane headers.",
      "Send feedback from the app: describe a problem or an idea and attach screenshots.",
      "Fixes: onboarding and What's new no longer overlap, links open your browser, the sidebar shows folder and remote icons, and the broadcast buttons are readable.",
    ],
  },
  {
    version: "0.1.1",
    date: "2026-11-12",
    highlights: [
      "Connect with GitHub now opens your browser by itself, and the Open github.com button works.",
      "A database left by an older development build is repaired on start instead of failing to start an agent.",
      "Icons in the command palette and in the Settings page list.",
    ],
  },
  {
    version: "0.1.0",
    date: "2026-11-12",
    highlights: [
      "Terminals with panes, tabs, blocks and restore after restart, on macOS and Windows.",
      "Agents side by side: Claude Code, Codex, Gemini CLI, OpenCode and your own, each in its own task and worktree.",
      "Review panel with comments to the agent, staging, pull requests, CI and merge.",
      "Best-of-N groups with a compare view, a board view, usage and cost, and handoff to another agent.",
      "Issues from GitHub and Linear become tasks; automations start agents on a schedule or a label.",
      "Remote projects over SSH, a local API and CLI, an MCP server, and an MCP and skills manager.",
      "Optional encrypted sync, first-run setup with importers, and signed updates on a stable or beta channel.",
    ],
  },
];

export function notesFor(version: string): ReleaseNotes | undefined {
  return RELEASES.find((release) => release.version === version);
}

export function newerThan(a: string, b: string): boolean {
  const parse = (v: string) => v.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}
