import type { ComponentProps } from "react";
import { cn } from "../cn";
import { iconSize } from "../icons";
import { type Status, statusMeta } from "../status";
import { t } from "../strings";

export interface StatusPillProps extends Omit<ComponentProps<"span">, "children"> {
  status: Status;
  /** Overrides the catalog label, e.g. "Needs you · 2". */
  label?: string;
}

/** Agent status as icon + label + colour (never colour alone). The label is --text on a tint, for 4.5:1. */
export function StatusPill({ status, label, className, ...props }: StatusPillProps) {
  const meta = statusMeta[status];
  const Icon = meta.icon;
  return (
    <span
      data-status={status}
      className={cn(
        "inline-flex h-5 max-w-full shrink-0 items-center gap-1 rounded-sm px-1.5 text-xs font-medium text-fg",
        meta.tint,
        className,
      )}
      {...props}
    >
      <Icon
        size={iconSize.tab}
        className={cn("shrink-0", meta.color, meta.spin && "animate-spin motion-reduce:animate-none")}
        aria-hidden
      />
      <span className="min-w-0 truncate">{label ?? t(meta.label)}</span>
    </span>
  );
}
