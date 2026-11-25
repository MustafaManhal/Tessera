// Live terminal panes by pane id, so registry actions (find, copy, paste, clear selection) reach the focused pane's
// engine without going through React. Each TerminalPane registers itself on mount and unregisters on unmount.
import type { TerminalEngine } from "@tessera/term";
import { activeTabOf, type LayoutState, type PaneId } from "../layout";
import type { BlockApi } from "./blocks/api";

export interface PaneTerminal {
  engine: TerminalEngine;
  transferSession(): { sessionId?: string; exitCode?: number };
  reclaimSession(sessionId: string): Promise<void>;
  /** Opens (or focuses) the pane's search bar. */
  openSearch(): void;
  /** Moves to the next or previous match, opening the search bar if it is closed. */
  find(direction: "next" | "previous"): void;
  /** Pastes through the confirmation rules (FR-07); `plain` strips control characters first. */
  paste(text: string, plain?: boolean): void;
  /** Reads the clipboard (from the palette or a menu) and pastes it. */
  pasteFromClipboard(plain: boolean): Promise<void>;
  /** Types text into the session as if typed (dropped paths). */
  insert(text: string): void;
  /** An agent was started in this shell (the title bar's agent menu): its output now lights the task while busy. */
  trackAgent(): void;
  /** Writes raw terminal input bytes only while this pane's PTY session is live. */
  writeInput(bytes: Uint8Array): boolean;
  /** Copies the selection to the clipboard (trimmed per setting); false when nothing is selected. */
  copySelection(): Promise<boolean>;
  /** Command blocks (M2.2). */
  blocks: BlockApi;
}

const panes = new Map<PaneId, PaneTerminal>();

declare global {
  interface Window {
    /** Dev builds only: live terminal panes, for tests and debugging. */
    __tesseraPanes?: Map<PaneId, PaneTerminal>;
  }
}
if (import.meta.env.DEV && typeof window !== "undefined") window.__tesseraPanes = panes;

export function registerPaneTerminal(paneId: PaneId, terminal: PaneTerminal): () => void {
  panes.set(paneId, terminal);
  return () => {
    if (panes.get(paneId) === terminal) panes.delete(paneId);
  };
}

export function paneTerminal(paneId: PaneId): PaneTerminal | undefined {
  return panes.get(paneId);
}

/** The focused pane's terminal in the active tab, if that pane is a terminal. */
export function focusedTerminal(layout: LayoutState): PaneTerminal | undefined {
  const tab = activeTabOf(layout);
  return tab ? panes.get(tab.focusedPane) : undefined;
}

/** Ctrl+L: shells (zsh, bash, fish, PowerShell) clear the screen and draw the prompt again, keeping what was typed. */
const FORM_FEED = new Uint8Array([0x0c]);

/**
 * Clears a terminal as typing `clear` does: the screen and the scrollback go and the shell draws a fresh prompt at the
 * top. Unlike typing the command, it works while something is half typed, and a full-screen program just redraws.
 */
export function clearTerminal(terminal: PaneTerminal): void {
  terminal.engine.clearScrollback();
  terminal.writeInput(FORM_FEED);
  terminal.engine.scrollToBottom();
  // From a toolbar button: typing goes on in the terminal.
  terminal.engine.focus();
}
