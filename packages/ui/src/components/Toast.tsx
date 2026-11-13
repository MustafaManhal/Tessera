import { CircleCheck, Copy, Info, type LucideIcon, TriangleExclamationPoint, Undo2, X } from "lucide-react";
import { Toast as ToastPrimitive } from "radix-ui";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../cn";
import { iconSize } from "../icons";
import { type StringKey, t } from "../strings";
import { Button } from "./Button";
import { IconButton } from "./IconButton";

export type ToastKind = "info" | "success" | "error";

export interface ToastOptions {
  kind?: ToastKind;
  /** What happened, one line. */
  title: string;
  /** What to do next. */
  description?: string;
  /** Error details (a log, a command's output): adds a "Copy details" button. A function is called when the button
   * is pressed, so a report can be built from fresh data. */
  details?: string | (() => string | Promise<string>);
  /** Adds an "Undo" button; called once when pressed, then the toast closes. */
  onUndo?: () => void;
  /** Milliseconds before it closes; paused while hovered or focused. Default 5 s, errors 10 s. */
  duration?: number;
}

export interface ToastApi {
  /** Shows a toast and returns its id. */
  toast: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
}

interface ToastItem extends ToastOptions {
  id: number;
  open: boolean;
}

const kinds: Record<ToastKind, { icon: LucideIcon; color: string; label: StringKey }> = {
  info: { icon: Info, color: "text-accent", label: "toast.kind.info" },
  success: { icon: CircleCheck, color: "text-success", label: "toast.kind.success" },
  error: { icon: TriangleExclamationPoint, color: "text-danger", label: "toast.kind.error" },
};

// Closed toasts stay mounted long enough for the exit fade, then leave the list.
const REMOVE_AFTER_MS = 1000;

const ToastContext = createContext<ToastApi | null>(null);

/** The toast API. Needs a ToastProvider (UIProvider has one) above it. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast needs a <ToastProvider> or <UIProvider> above it.");
  return api;
}

let errorReport: ((options: ToastOptions) => () => string | Promise<string>) | null = null;

/** Every error toast without its own details gets a "Copy details" button that copies what `build` returns. The app
 * sets this once (an error report with the log tail); the design system itself knows nothing about logs. */
export function setToastErrorReport(build: ((options: ToastOptions) => () => string | Promise<string>) | null): void {
  errorReport = build;
}

/** Holds the toasts and renders them in a stack at the bottom end of the window (F8 moves focus there). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
    };
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    const id = nextId.current++;
    const complete =
      options.kind === "error" && !options.details && errorReport
        ? { ...options, details: errorReport(options) }
        : options;
    setItems((current) => [...current, { ...complete, id, open: true }]);
    return id;
  }, []);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, open: false } : item)));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setItems((current) => current.filter((item) => item.id !== id));
    }, REMOVE_AFTER_MS);
    timers.current.add(timer);
  }, []);

  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext value={api}>
      <ToastPrimitive.Provider label={t("toast.label")} swipeDirection="right">
        {children}
        {items.map((item) => (
          <ToastCard key={item.id} item={item} onDismiss={() => dismiss(item.id)} />
        ))}
        <ToastPrimitive.Viewport
          label={t("toast.region")}
          className="fixed end-0 bottom-0 z-50 flex max-h-screen w-full max-w-sm flex-col gap-2 p-4"
        />
      </ToastPrimitive.Provider>
    </ToastContext>
  );
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const kind = kinds[item.kind ?? "info"];
  const Icon = kind.icon;
  const isError = item.kind === "error";
  const { onUndo, details } = item;
  return (
    <ToastPrimitive.Root
      open={item.open}
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
      duration={item.duration ?? (isError ? 10_000 : 5_000)}
      type={isError ? "foreground" : "background"}
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 rounded-lg border border-border bg-surface p-3",
        "text-fg shadow-popover",
        "data-[state=closed]:animate-toast-out data-[state=open]:animate-toast-in",
        "data-[swipe=move]:translate-x-(--radix-toast-swipe-move-x) data-[swipe=cancel]:translate-x-0",
        "data-[swipe=cancel]:transition-transform data-[swipe=end]:animate-toast-out",
      )}
    >
      <Icon size={iconSize.row} className={cn("mt-0.5 shrink-0", kind.color)} aria-hidden />
      <div className="flex min-w-0 flex-col gap-0.5">
        <ToastPrimitive.Title className="text-base font-medium break-words">
          <span className="sr-only">{t(kind.label)}: </span>
          {item.title}
        </ToastPrimitive.Title>
        {item.description && (
          <ToastPrimitive.Description className="text-sm break-words text-muted">
            {item.description}
          </ToastPrimitive.Description>
        )}
        {(onUndo || details) && (
          <div className="mt-2 flex flex-wrap gap-2">
            {onUndo && (
              <ToastPrimitive.Action altText={t("toast.undoAlt")} asChild>
                <Button size="sm" icon={Undo2} onClick={onUndo}>
                  {t("toast.undo")}
                </Button>
              </ToastPrimitive.Action>
            )}
            {details && <CopyDetailsButton details={details} />}
          </div>
        )}
      </div>
      <ToastPrimitive.Close asChild>
        <IconButton icon={X} label={t("toast.dismiss")} size="sm" tooltipSide="left" />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  );
}

const COPIED_FOR_MS = 2000;

function CopyDetailsButton({ details }: { details: string | (() => string | Promise<string>) }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), COPIED_FOR_MS);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(typeof details === "function" ? await details() : details);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  const label = state === "copied" ? "toast.copied" : state === "failed" ? "toast.copyFailed" : "toast.copyDetails";
  return (
    <Button size="sm" icon={Copy} onClick={copy} aria-live="polite">
      {t(label)}
    </Button>
  );
}
