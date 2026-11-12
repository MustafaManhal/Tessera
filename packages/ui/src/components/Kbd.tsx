import type { ComponentProps } from "react";
import { cn } from "../cn";
import { describeShortcut, formatShortcut, getPlatform, type Platform } from "../platform";

export interface KbdProps extends Omit<ComponentProps<"kbd">, "children"> {
  /** Platform-neutral shortcut, e.g. "Mod+Shift+P". */
  shortcut: string;
  /** Defaults to the running platform. */
  platform?: Platform;
}

/** Shortcut chip: ⌘⇧P on macOS, Ctrl+Shift+P elsewhere. Screen readers hear the key names ("Command Shift P"). */
export function Kbd({ shortcut, platform = getPlatform(), className, ...props }: KbdProps) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-sm border border-border bg-surface px-1",
        "font-sans text-xs font-medium whitespace-nowrap text-muted",
        className,
      )}
      {...props}
    >
      <span aria-hidden>{formatShortcut(shortcut, platform)}</span>
      <span className="sr-only">{describeShortcut(shortcut, platform)}</span>
    </kbd>
  );
}
