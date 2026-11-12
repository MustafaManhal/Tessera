import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { type ComponentProps, useRef } from "react";
import { cn } from "../cn";
import { t } from "../strings";
import { IconButton } from "./IconButton";

// Radix Dialog traps focus, closes on Esc and on a click outside, and returns focus to the trigger.
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps extends ComponentProps<typeof DialogPrimitive.Content> {
  /** Hides the close button in the corner (Esc still closes). */
  hideClose?: boolean;
}

/**
 * The dialog box, centred on a dimmed backdrop. The backdrop scrolls when the dialog is taller than the window,
 * so a 640×400 window still reaches every control. The close button comes last in the DOM, so opening the dialog
 * focuses its first field instead.
 */
export function DialogContent({
  hideClose = false,
  className,
  children,
  onCloseAutoFocus,
  ...props
}: DialogContentProps) {
  // A dialog opened by a shortcut has no trigger for Radix to give the focus back to: without this the focus falls
  // to the page body and a keyboard user loses their place. Remember what had it and restore it on close.
  const previous = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          "fixed inset-0 z-40 grid place-items-center overflow-y-auto bg-overlay p-8",
          "data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in",
        )}
      >
        <DialogPrimitive.Content
          className={cn(
            "relative flex w-full max-w-md flex-col gap-4 rounded-xl border border-border bg-surface p-6 text-fg",
            "shadow-dialog data-[state=closed]:animate-dialog-out data-[state=open]:animate-dialog-in",
            className,
          )}
          onCloseAutoFocus={(event) => {
            if (onCloseAutoFocus) return onCloseAutoFocus(event);
            const element = previous.current;
            if (element?.isConnected && element !== document.body) {
              event.preventDefault();
              element.focus();
            }
          }}
          {...props}
        >
          {children}
          {!hideClose && (
            <DialogPrimitive.Close asChild>
              <IconButton
                icon={X}
                label={t("dialog.close")}
                shortcut="Escape"
                size="sm"
                className="absolute end-3 top-3"
              />
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Overlay>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("pe-8 text-lg font-semibold", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn("text-base text-muted", className)} {...props} />;
}

/** Actions row: least destructive first, primary last (end side). */
export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-wrap justify-end gap-2", className)} {...props} />;
}
