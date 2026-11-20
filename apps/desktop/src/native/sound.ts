// Notification sounds. The app plays the sound itself (the OS notification is sent silent on macOS), so a finishing
// agent is heard whether or not the OS shows a banner. Choices are ids the native side maps to system sounds.
import { commands } from "@tessera/ipc";
import { isNativeRuntime } from "./runtime";

declare global {
  interface Window {
    __tesseraSounds?: string[];
  }
}

export const SOUND_CHOICES = ["default", "glass", "ping", "pop", "hero", "submarine", "funk", "basso"] as const;

export async function playSound(name: string): Promise<void> {
  if (typeof window !== "undefined") {
    window.__tesseraSounds = [...(window.__tesseraSounds ?? []), name];
  }
  if (!isNativeRuntime()) return;
  try {
    await commands.soundPlay(name);
  } catch {
    // A sound that cannot play is not worth an error toast.
  }
}
