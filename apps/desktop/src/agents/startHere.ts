// Starts an installed agent in the open task's terminal, as if the user typed `claude` there (the title bar's agent
// menu). Typing it into the shell, not launching it in an agent tab, keeps the terminal the user is looking at: the
// pane then tracks it as a typed agent (resumed after a restart, lit in the sidebar while it works).
import { getPlatform, type Platform } from "@tessera/ui";
import { activeTabOf, findPane, type PaneId } from "../layout";
import { currentTaskId, taskStartFolder } from "../sidebar/taskTabs";
import type { AppThunk } from "../store";
import { INITIAL_CWD, layout } from "../store/layoutSlice";
import { paneTerminal } from "../terminal/panes";
import { agentsClient } from "./service";

/** How long a new terminal may take to start before the command is given up. */
export const START_TIMEOUT_MS = 10_000;
const POLL_MS = 50;

const SAFE_WORD = /^[A-Za-z0-9_./:=@%+,-]+$/;

/** Quotes one word for the pane's shell: POSIX shells on macOS, PowerShell on Windows. */
export function quoteWord(word: string, platform: Platform): string {
  if (word !== "" && SAFE_WORD.test(word)) return word;
  if (platform === "windows") return `'${word.replace(/'/g, "''")}'`;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command line typed into the shell, without the final Enter. `program` is what the user would type (`claude`, or
 * the path of a program that is not on the PATH), from the backend's `typed_program`.
 */
export function agentCommandLine(program: string, args: readonly string[], platform: Platform): string {
  const name = quoteWord(program, platform);
  // PowerShell runs a quoted program only through the call operator.
  const head = platform === "windows" && name.startsWith("'") ? `& ${name}` : name;
  return [head, ...args.map((arg) => quoteWord(arg, platform))].join(" ");
}

/**
 * The pane the agent starts in: the focused pane of the open tab when it is a shell with nothing running in it.
 * Otherwise (no tab, an agent or another program is running there) a new terminal opens in the task's folder.
 */
function targetPane(dispatch: Parameters<AppThunk>[0], getState: Parameters<AppThunk>[1]): PaneId | null {
  const state = getState();
  const tab = activeTabOf(state.layout);
  const focused = tab?.focusedPane;
  if (tab && focused && findPane(tab.root, focused)?.kind === "shell" && !state.layout.panes[focused]?.runningProcess) {
    return focused;
  }
  const taskId = currentTaskId(state);
  const task = taskId ? state.projects.tasks[taskId] : undefined;
  const cwd = task
    ? taskStartFolder(state, task)
    : ((focused ? state.layout.panes[focused]?.cwd : undefined) ?? INITIAL_CWD);
  dispatch(
    layout(
      { type: "tab/new", cwd: cwd || INITIAL_CWD, ...(task ? { taskId: task.id, title: task.name } : {}) },
      "pane",
    ),
  );
  return activeTabOf(getState().layout)?.focusedPane ?? null;
}

/** Types `text` once the pane's shell session is live; false when it did not start in time. */
async function typeWhenLive(paneId: PaneId, text: string, timeoutMs: number): Promise<boolean> {
  const bytes = new TextEncoder().encode(text);
  const until = Date.now() + timeoutMs;
  for (;;) {
    const terminal = paneTerminal(paneId);
    if (terminal?.writeInput(bytes)) {
      terminal.trackAgent();
      terminal.engine.focus();
      return true;
    }
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Starts the profile's agent in the open task's terminal. Rejects when the command cannot be built or typed. */
export const startAgentHere =
  (profileId: string, timeoutMs = START_TIMEOUT_MS): AppThunk<Promise<void>> =>
  async (dispatch, getState) => {
    const preview = await agentsClient().agentCommandPreview(profileId, null);
    const line = agentCommandLine(preview.typed_program || preview.program, preview.args, getPlatform());
    const paneId = targetPane(dispatch, getState);
    if (!paneId || !(await typeWhenLive(paneId, `${line}\r`, timeoutMs))) {
      throw new Error("The terminal did not start in time.");
    }
  };
