// Accessibility preferences (M12.6, NFR-10): reduce motion and screen reader mode. They are per device, kept in the
// browser storage of the window, and applied as attributes on <html> that the style sheet and the terminal read.
// Reduce motion follows the operating system until the user turns it on here; the OS setting always wins when it is on.
import { useSyncExternalStore } from "react";

export interface AccessibilityPrefs {
  reduceMotion: boolean;
  /** Terminals expose their text to screen readers (xterm's accessibility tree) and more changes are announced. */
  screenReader: boolean;
}

const KEY = "tessera.accessibility";
const listeners = new Set<() => void>();
let prefs: AccessibilityPrefs = read();

function read(): AccessibilityPrefs {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "{}");
    return { reduceMotion: raw.reduceMotion === true, screenReader: raw.screenReader === true };
  } catch {
    return { reduceMotion: false, screenReader: false };
  }
}

export function applyAccessibilityPrefs(target: HTMLElement = document.documentElement): void {
  target.dataset.reduceMotion = String(prefs.reduceMotion);
  target.dataset.screenReader = String(prefs.screenReader);
}

export function getAccessibilityPrefs(): AccessibilityPrefs {
  return prefs;
}

export function setAccessibilityPref<K extends keyof AccessibilityPrefs>(key: K, value: AccessibilityPrefs[K]): void {
  prefs = { ...prefs, [key]: value };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // The choice lasts for this session only.
  }
  applyAccessibilityPrefs();
  for (const listener of listeners) listener();
}

export function useAccessibilityPrefs(): AccessibilityPrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => prefs,
  );
}
