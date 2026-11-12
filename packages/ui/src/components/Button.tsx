import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle, type LucideIcon } from "lucide-react";
import type { ComponentProps, MouseEvent } from "react";
import { cn } from "../cn";
import { iconSize } from "../icons";
import { t } from "../strings";

export const buttonVariants = cva(
  [
    "inline-flex max-w-full min-w-0 shrink-0 cursor-default items-center justify-center gap-1.5 rounded-md",
    "font-medium whitespace-nowrap select-none transition-colors",
    "disabled:opacity-50 aria-disabled:pointer-events-none",
  ],
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg enabled:hover:bg-accent-hover enabled:active:bg-accent-press",
        secondary: "border border-border bg-surface-2 text-fg enabled:hover:bg-surface-3 enabled:active:bg-border",
        ghost: "text-fg enabled:hover:bg-surface-2 enabled:active:bg-surface-3",
        danger: "bg-danger text-danger-fg enabled:hover:bg-danger-hover enabled:active:bg-danger-press",
      },
      size: {
        sm: "h-6 px-2 text-sm",
        md: "h-8 px-3 text-base",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

export interface ButtonProps extends ComponentProps<"button">, VariantProps<typeof buttonVariants> {
  /** Leading icon. */
  icon?: LucideIcon;
  /** Shows a spinner and ignores clicks, but keeps focus (unlike `disabled`), so keyboard users stay in place. */
  loading?: boolean;
}

/** Button: primary, secondary, ghost, danger; sm or md. A long label truncates with an ellipsis. */
export function Button({
  variant,
  size,
  icon: Icon,
  loading = false,
  className,
  children,
  type = "button",
  onClick,
  ...props
}: ButtonProps) {
  const glyph = size === "sm" ? iconSize.tab : iconSize.row;
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (loading) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      onClick={handleClick}
      {...props}
    >
      {loading ? (
        <LoaderCircle size={glyph} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
      ) : (
        Icon && <Icon size={glyph} className="shrink-0" aria-hidden />
      )}
      {children !== undefined && <span className="min-w-0 truncate">{children}</span>}
      {loading && <span className="sr-only">{t("button.loading")}</span>}
    </button>
  );
}
