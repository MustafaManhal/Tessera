// The contract between the layout and whatever a pane shows. Today that is PanePlaceholder; M1.2 replaces it with the
// real terminal by implementing this interface and passing it to <Shell paneContent={…}>, without touching the
// layout code.
//
// Rules for an implementation:
// - Render to fill the parent (the layout sizes and positions the pane; it never unmounts a pane because of a split,
//   a close elsewhere, a swap, a zoom or a tab switch: hidden panes stay mounted with `visible: false`).
// - Put `data-terminal` on the element that takes keyboard input: the app's shortcuts keep working while it has
//   focus, and every other key goes to the content.
// - Expose `focus()` through the ref: the layout calls it when keyboard focus should move into the pane.
// - Call `onFocused` when the content gets focus on its own (a click), so the layout marks this pane focused.
// - Report the cwd (OSC 7), the program title (OSC 0/2) and a running foreground process when they change; closing
//   a tab or pane asks for confirmation while `onRunningProcessChange` reported one (F-03 step 7).
import type { ComponentType, Ref } from "react";
import type { PaneId, PaneInfo, PaneKind } from "../../layout";

export interface PaneContentProps {
  tabId: string;
  paneId: PaneId;
  kind: PaneKind;
  /** The PTY session to attach to; null until sessions exist (M1.1). */
  sessionId: string | null;
  info: PaneInfo;
  /** The focused pane of its tab: keyboard input goes here while the tab is active. */
  focused: boolean;
  /** On screen: its tab is active and no other pane is zoomed. */
  visible: boolean;
  onFocused: () => void;
  onCwdChange: (cwd: string) => void;
  onTitleChange: (title: string | null) => void;
  /** The foreground process name ("npm run dev"), or null when the shell is idle. */
  onRunningProcessChange: (process: string | null) => void;
  /** The PTY session started (a launch binds an agent session to it). */
  onSpawned?: (sessionId: string) => void;
  /** Raw output bytes, before rendering (agent prompt delivery waits for a ready line). */
  onOutput?: (bytes: Uint8Array) => void;
  /** The PTY exited with this code (an agent session ends with it). */
  onExit?: (code: number) => void;
}

export interface PaneContentHandle {
  focus: () => void;
}

export type PaneContentComponent = ComponentType<PaneContentProps & { ref?: Ref<PaneContentHandle> }>;
