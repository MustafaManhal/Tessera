import type { LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../cn";
import { iconSize } from "../icons";
import { type ButtonSize, buttonVariants } from "./Button";
import { Tooltip } from "./Tooltip";

export interface IconButtonProps extends Omit<ComponentProps<"button">, "children" | "aria-label"> {
  icon: LucideIcon;
  /** Required: the accessible name and the tooltip text. */
  label: string;
  /** Platform-neutral shortcut shown in the tooltip, e.g. "Mod+B". */
  shortcut?: string;
  variant?: "ghost" | "secondary";
  size?: ButtonSize;
  tooltipSide?: "top" | "right" | "bottom" | "left";
}

/** Square icon-only button with a tooltip showing its label and shortcut (03-UI-UX §1.4: every action has a door). */
export function IconButton({
  icon: Icon,
  label,
  shortcut,
  variant = "ghost",
  size = "md",
  tooltipSide,
  className,
  type = "button",
  ...props
}: IconButtonProps) {
  return (
    <Tooltip label={label} shortcut={shortcut} side={tooltipSide}>
      <button
        type={type}
        aria-label={label}
        className={cn(buttonVariants({ variant, size }), size === "sm" ? "w-6 px-0" : "w-8 px-0", className)}
        {...props}
      >
        <Icon size={size === "sm" ? iconSize.tab : iconSize.row} aria-hidden />
      </button>
    </Tooltip>
  );
}
