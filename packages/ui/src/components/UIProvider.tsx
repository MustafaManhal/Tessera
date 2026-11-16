import type { ReactNode } from "react";
import { ToastProvider } from "./Toast";
import { TooltipProvider } from "./Tooltip";

/** Wrap the app once: the shared tooltip delay and the toast stack. */
export function UIProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <ToastProvider>{children}</ToastProvider>
    </TooltipProvider>
  );
}
