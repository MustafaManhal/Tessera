import { Tooltip as TooltipPrimitive } from "radix-ui";
import type { ComponentProps, ReactElement } from "react";
import { cn } from "../cn";
import { Kbd } from "./Kbd";

/** One per app (UIProvider has it): tooltips share the open delay and skip it when moving between triggers. */
export function TooltipProvider({
  delayDuration = 500,
  skipDelayDuration = 300,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration} {...props} />;
}

export interface TooltipProps extends Omit<ComponentProps<typeof TooltipPrimitive.Content>, "children" | "content"> {
  /** The trigger: one element that takes a ref and props (a button). */
  children: ReactElement;
  label: string;
  /** Platform-neutral shortcut shown as a chip, e.g. "Mod+B". */
  shortcut?: string;
}

/** Label plus an optional shortcut chip, on hover and keyboard focus. Needs a TooltipProvider above it. */
export function Tooltip({
  children,
  label,
  shortcut,
  className,
  side = "bottom",
  sideOffset = 6,
  ...props
}: TooltipProps) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={sideOffset}
          collisionPadding={8}
          className={cn(
            "z-50 flex max-w-xs items-center gap-2 rounded-md border border-border bg-surface-3 px-2 py-1",
            "text-sm text-fg shadow-popover select-none",
            // Fades in, closes at once: a closing tooltip is still the top layer and would take the next Esc
            // (meant for a dialog) while it faded out.
            "data-[state=delayed-open]:animate-fade-in data-[state=instant-open]:animate-fade-in",
            className,
          )}
          {...props}
        >
          <span className="min-w-0">{label}</span>
          {shortcut && <Kbd shortcut={shortcut} />}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
