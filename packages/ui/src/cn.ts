import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge knows Tailwind's default scales; these are the names theme.css adds, so `cn("shadow-popover",
// "shadow-dialog")` keeps only the last one instead of reading "dialog" as a shadow colour.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      shadow: ["dialog", "popover"],
      ease: ["standard"],
      leading: ["ui", "term"],
      animate: ["fade-in", "fade-out", "dialog-in", "dialog-out", "toast-in", "toast-out"],
    },
  },
});

/** Joins class names (clsx) and lets later Tailwind classes win over earlier ones (tailwind-merge). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
