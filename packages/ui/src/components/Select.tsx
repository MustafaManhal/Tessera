import { Check, ChevronDown } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../cn";
import { iconSize } from "../icons";
import { t } from "../strings";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<ComponentProps<typeof SelectPrimitive.Root>, "children"> {
  options: readonly SelectOption[];
  placeholder?: string;
  /** Id of the trigger, for <label htmlFor>. */
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  invalid?: boolean;
  className?: string;
}

/** Drop-down list (Radix Select): Enter, Space or arrows open it, arrows move, typing jumps, Esc closes. */
export function Select({
  options,
  placeholder = t("select.placeholder"),
  id,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  invalid = false,
  className,
  ...props
}: SelectProps) {
  return (
    <SelectPrimitive.Root {...props}>
      <SelectPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid || undefined}
        className={cn(
          "inline-flex h-9 w-full min-w-0 cursor-default items-center justify-between gap-2 rounded-lg",
          "border border-border-strong bg-surface px-3 text-start text-base text-fg transition-colors",
          "enabled:hover:bg-surface-2 data-placeholder:text-muted",
          "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger",
          className,
        )}
      >
        <span className="min-w-0 truncate">
          <SelectPrimitive.Value placeholder={placeholder} />
        </span>
        <SelectPrimitive.Icon className="shrink-0 text-muted">
          <ChevronDown size={iconSize.row} aria-hidden />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className={cn(
            "z-50 max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) overflow-hidden",
            "rounded-lg border border-border bg-surface text-fg shadow-popover",
            "data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in",
          )}
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={cn(
                  "relative flex h-7 cursor-default items-center rounded-sm ps-7 pe-2 text-base select-none",
                  "data-disabled:opacity-50 data-highlighted:bg-surface-3",
                )}
              >
                <SelectPrimitive.ItemIndicator className="absolute start-2 inline-flex items-center text-accent">
                  <Check size={iconSize.tab} aria-hidden />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
