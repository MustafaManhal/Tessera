// Settings until config.toml lands in the UI (M4.1). Names follow the planned config keys (05-backend-schema §5.1).
import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { clampFontSize, type CursorStyle, type Osc52Policy, type Renderer } from "@tessera/term";
import { getPlatform, type Platform } from "@tessera/ui";
import { configToTerminal } from "../settings/mapping";
import { configApplied } from "./configSlice";

/** `[terminal]` in config.toml. */
export interface TerminalSettings {
  /** `terminal.font_family`: the first family; the bundled fallbacks follow it. */
  fontFamily: string;
  /** `terminal.font_size` in CSS pixels (UI-UX §2: 13 px macOS, 12 pt = 16 px Windows). */
  fontSize: number;
  /** `terminal.line_height`. */
  lineHeight: number;
  /** `terminal.font_weight`. */
  fontWeight: number;
  /** `terminal.ligatures`: off by default (the addon costs performance). */
  ligatures: boolean;
  /** `terminal.cursor_style`. */
  cursorStyle: CursorStyle;
  /** `terminal.cursor_blink`. */
  cursorBlink: boolean;
  /** `terminal.scrollback` lines (FR-05, default 10 000). */
  scrollback: number;
  /** `terminal.renderer`: "webgl" with DOM fallback, or "dom". */
  renderer: Renderer;
  /** `clipboard.copy_on_select`. */
  copyOnSelect: boolean;
  /** `clipboard.trim_trailing_whitespace` on copy. */
  trimTrailingWhitespace: boolean;
  /**
   * `terminal.paste_confirm` (FR-07): "multiline" asks before pasting several lines or control characters, "always"
   * before every paste, "never" not at all.
   */
  pasteConfirm: PasteConfirm;
  /** `clipboard.middle_click_paste`: off by default on macOS. */
  middleClickPaste: boolean;
  /** `terminal.osc52_write`: what happens when a program copies to the clipboard (OSC 52). Reads are always blocked. */
  osc52Write: Osc52Policy;
  /** `terminal.images`: Sixel and iTerm2 inline images. */
  images: boolean;
  /** `terminal.block_gutter`: the command block column left of the text (M2.2). */
  blockGutter: boolean;
  /** `terminal.long_command_alert`: notify when a long command ends while you look elsewhere (FR-18). */
  longCommandAlert: boolean;
  /** `terminal.long_command_seconds`: what "long" means. */
  longCommandSeconds: number;
  /** `notifications.enabled`: programs may show OS notifications (OSC 9, 99, 777). */
  notifications: boolean;
  /** `terminal.secure_keyboard_entry` (macOS): mirrors the OS secure-input state for controls and status UI. */
  secureKeyboardEntry: boolean;
}

export const PASTE_CONFIRM = ["multiline", "always", "never"] as const;
export type PasteConfirm = (typeof PASTE_CONFIRM)[number];

/** Bounds of `terminal.long_command_seconds`. */
export const LONG_COMMAND_SECONDS = { min: 1, max: 86_400 } as const;

export interface SettingsState {
  /** `confirm-close-running` (F-03 step 7, "setting to skip"): ask before closing a running process. */
  confirmCloseRunning: boolean;
  /** `pane-dim-unfocused` (03-UI-UX §4): how much unfocused panes dim, 0–1; sets the `--pane-dim` token. */
  paneDimUnfocused: number;
  terminal: TerminalSettings;
  /** `window.restore`: bring back tabs and splits at start. Not in the config schema yet: kept on this computer. */
  restoreSession: boolean;
}

export const DEFAULT_FONT_FAMILY = "JetBrains Mono";

/** UI-UX §2: 13 px on macOS, 12 pt on Windows (16 CSS px), 13 px elsewhere. */
export function defaultFontSize(platform: Platform): number {
  return platform === "windows" ? 16 : 13;
}

export function defaultTerminalSettings(platform: Platform): TerminalSettings {
  return {
    fontFamily: DEFAULT_FONT_FAMILY,
    fontSize: defaultFontSize(platform),
    lineHeight: 1.2,
    fontWeight: 400,
    ligatures: false,
    cursorStyle: "block",
    cursorBlink: true,
    scrollback: 10_000,
    renderer: "webgl",
    copyOnSelect: false,
    trimTrailingWhitespace: true,
    pasteConfirm: "never",
    middleClickPaste: platform !== "mac",
    osc52Write: "ask",
    images: true,
    blockGutter: true,
    longCommandAlert: true,
    longCommandSeconds: 30,
    notifications: true,
    secureKeyboardEntry: false,
  };
}

export function createSettingsSlice(platform: Platform = getPlatform()) {
  const initialState: SettingsState = {
    confirmCloseRunning: true,
    paneDimUnfocused: 0,
    terminal: defaultTerminalSettings(platform),
    restoreSession: true,
  };
  return createSlice({
    name: "settings",
    initialState,
    reducers: {
      setConfirmCloseRunning: (state, action: PayloadAction<boolean>) => {
        state.confirmCloseRunning = action.payload;
      },
      setRestoreSession: (state, action: PayloadAction<boolean>) => {
        state.restoreSession = action.payload;
      },
      setPaneDimUnfocused: (state, action: PayloadAction<number>) => {
        state.paneDimUnfocused = Math.min(1, Math.max(0, action.payload));
      },
      setTerminal: (state, action: PayloadAction<Partial<TerminalSettings>>) => {
        const next = { ...state.terminal, ...action.payload };
        next.fontSize = clampFontSize(next.fontSize);
        next.lineHeight = Math.min(2, Math.max(1, next.lineHeight));
        next.scrollback = Math.max(0, Math.min(1_000_000, Math.round(next.scrollback)));
        const seconds = Number.isFinite(next.longCommandSeconds) ? Math.round(next.longCommandSeconds) : 30;
        next.longCommandSeconds = Math.max(LONG_COMMAND_SECONDS.min, Math.min(LONG_COMMAND_SECONDS.max, seconds));
        if (!PASTE_CONFIRM.includes(next.pasteConfirm)) next.pasteConfirm = "multiline";
        if (!["ask", "allow", "deny"].includes(next.osc52Write)) next.osc52Write = "ask";
        state.terminal = next;
      },
      /** Font zoom: +1, -1, or "reset" to the platform default (8–40 px). */
      zoomFont: (state, action: PayloadAction<1 | -1 | "reset">) => {
        state.terminal.fontSize =
          action.payload === "reset"
            ? defaultFontSize(platform)
            : clampFontSize(state.terminal.fontSize + action.payload);
      },
    },
    // The config file (Rust) decides the keys it has; `configApplied` is not a `setTerminal`, so it is never written back.
    extraReducers: (builder) => {
      builder.addCase(configApplied, (state, action) => {
        const next = { ...state.terminal, ...configToTerminal(action.payload, state.terminal) };
        next.fontSize = clampFontSize(next.fontSize);
        next.lineHeight = Math.min(2, Math.max(1, next.lineHeight));
        state.terminal = next;
      });
    },
  });
}

export const settingsSlice = createSettingsSlice();

export const { setConfirmCloseRunning, setRestoreSession, setPaneDimUnfocused, setTerminal, zoomFont } =
  settingsSlice.actions;
