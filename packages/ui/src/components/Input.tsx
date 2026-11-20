import type { ComponentProps } from "react";
import { cn } from "../cn";

export interface InputProps extends ComponentProps<"input"> {
  /** Marks the value as wrong (red border, aria-invalid). Put the message in text linked with aria-describedby. */
  invalid?: boolean;
}

/** Single-line text field. The border is --border-strong: a field's edge needs 3:1 (WCAG 1.4.11). */
export function Input({ invalid = false, className, type = "text", ...props }: InputProps) {
  return (
    <input
      type={type}
      aria-invalid={invalid || undefined}
      className={cn(
        "h-9 w-full min-w-0 rounded-lg border border-border-strong bg-surface px-3 text-base text-fg",
        "transition-colors placeholder:text-muted hover:bg-surface-2",
        "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger",
        className,
      )}
      {...props}
    />
  );
}
