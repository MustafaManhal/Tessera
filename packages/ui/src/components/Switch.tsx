import { Switch as SwitchPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../cn";

/**
 * On/off switch (role="switch"; Space toggles). Pair it with a <label htmlFor>. Off: --border-strong track; on:
 * --accent track, 40x24 px (WCAG 2.2 target size minimum). The thumb is --surface, which keeps 3:1 against both tracks in both themes.
 */
export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "inline-flex h-6 w-10 shrink-0 cursor-default items-center rounded-full bg-border-strong p-0.5",
        "transition-colors data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block size-5 rounded-full bg-surface",
          "transition-transform duration-(--motion-fast) ease-standard",
          "data-[state=checked]:translate-x-4 rtl:data-[state=checked]:-translate-x-4",
        )}
      />
    </SwitchPrimitive.Root>
  );
}
