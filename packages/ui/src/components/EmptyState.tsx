import type { LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../cn";
import { iconSize } from "../icons";
import { Button } from "./Button";

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
  icon?: LucideIcon;
}

export interface EmptyStateProps extends Omit<ComponentProps<"div">, "children"> {
  icon: LucideIcon;
  /** One sentence (03-UI-UX §6). */
  message: string;
  /** The one primary action. */
  action?: EmptyStateAction;
}

/** What an empty list shows: an icon, one line, one action. */
export function EmptyState({ icon: Icon, message, action, className, ...props }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 p-8 text-center", className)} {...props}>
      <Icon size={iconSize.empty} className="text-muted" aria-hidden />
      <p className="max-w-xs text-base text-muted">{message}</p>
      {action && (
        <Button variant="primary" size="sm" icon={action.icon} onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
