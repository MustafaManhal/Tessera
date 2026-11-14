// The one global key handler, built from the registry. It listens in the capture phase (before any pane), matches
// `KeyboardEvent.code`, ignores keys that belong to an input method composition, keeps out of text fields unless
// the chord uses the command modifier, keeps out of dialogs unless the action is meant for them, and scopes the
// tab-strip keys (Delete, F2, Alt+Shift+arrows) to the tab strip.
import { getPlatform, type Platform } from "@tessera/ui";
import { useEffect, useSyncExternalStore } from "react";
import {
  allowedInTextField,
  type Chord,
  isComposing,
  isTextEntry,
  type KeyLike,
  matchesChord,
  parseChord,
} from "./keys";
import { keymap } from "./keymap";
import { type AppAction, availability, bindings, context } from "./registry";

export interface ResolvedBinding {
  action: AppAction;
  chord: Chord;
  scope: "tabStrip" | undefined;
  native: boolean;
}

export function resolveBindings(platform: Platform, list?: readonly AppAction[]): ResolvedBinding[] {
  return bindings(platform, list).flatMap(({ action, keys, scope, native }) => {
    const chord = parseChord(keys, platform);
    return chord ? [{ action, chord, scope, native }] : [];
  });
}

export interface KeyTarget {
  /** Focus is in a text field (see `isTextEntry`). */
  inText: boolean;
  /** Focus is inside a dialog. */
  inDialog: boolean;
  /** Focus is in the tab strip. */
  inTabStrip: boolean;
}

/** The binding a key press triggers, or null. Pure, so it is unit-tested without a DOM. */
export function matchBinding(
  event: KeyLike & { isComposing?: boolean; keyCode?: number },
  target: KeyTarget,
  resolved: readonly ResolvedBinding[],
  platform: Platform,
): ResolvedBinding | null {
  if (isComposing(event)) return null;
  for (const binding of resolved) {
    if (!matchesChord(event, binding.chord)) continue;
    if (binding.scope === "tabStrip" && !target.inTabStrip) continue;
    if (target.inText && !allowedInTextField(binding.chord, platform)) continue;
    if (target.inDialog && !binding.action.inDialog) continue;
    return binding;
  }
  return null;
}

export function describeTarget(element: EventTarget | null): KeyTarget {
  const node = element instanceof Element ? element : null;
  return {
    inText: isTextEntry(element),
    inDialog: Boolean(node?.closest('[role="dialog"], [role="alertdialog"]')),
    inTabStrip: Boolean(node?.closest('[role="tablist"]')),
  };
}

let lastNative: { id: string; at: number } | null = null;

/**
 * True when a native chord for this action was pressed in the last moment (the clipboard event it causes follows the
 * keydown at once). The terminal uses it to tell "paste" from "paste as plain text" on macOS.
 */
export function takeNativeShortcut(actionId: string): boolean {
  const hit = lastNative !== null && lastNative.id === actionId && performance.now() - lastNative.at < 500;
  if (hit) lastNative = null;
  return hit;
}

/** Installs the global key handler for the app's lifetime; it follows the keymap when overrides change. */
export function useGlobalShortcuts(): void {
  const version = useSyncExternalStore(keymap.subscribe, keymap.version);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the trigger: the bindings are re-read on a change.
  useEffect(() => {
    const platform = getPlatform();
    const resolved = resolveBindings(platform);
    const onKeyDown = (event: KeyboardEvent) => {
      // The shortcut recorder (Settings) is listening for the next chord: it gets every key.
      if (keymap.recording) return;
      const binding = matchBinding(event, describeTarget(event.target), resolved, platform);
      if (!binding) return;
      if (binding.native) {
        // Let the WebView fire its clipboard event; the terminal pane handles it.
        lastNative = { id: binding.action.id, at: performance.now() };
        return;
      }
      // The chord is ours even when the action is unavailable: the webview must not act on it either.
      event.preventDefault();
      event.stopPropagation();
      const ctx = context(binding.scope);
      if (availability(binding.action, ctx).ok) binding.action.run(ctx);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [version]);
}
