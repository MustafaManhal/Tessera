// Agent status: colour, icon and label always travel together (03-UI-UX §1.2, §2), so status is never shown by
// colour alone. StatusPill uses this; sidebar rows, tabs and the board reuse it.
import { Check, Circle, Hand, LoaderCircle, type LucideIcon, TriangleExclamationPoint } from "lucide-react";
import type { StringKey } from "./strings";

export const statuses = ["working", "needs", "done", "error", "off"] as const;
export type Status = (typeof statuses)[number];

export interface StatusMeta {
  icon: LucideIcon;
  /** Catalog key of the label. */
  label: StringKey;
  /** Text colour class for the icon (`--st-<status>`). */
  color: string;
  /** Background class for a pill (`--st-<status>-tint`). */
  tint: string;
  /** The icon spins while the status lasts (stops with reduced motion). */
  spin: boolean;
}

// Class names are written out in full so Tailwind finds them.
export const statusMeta: Record<Status, StatusMeta> = {
  working: {
    icon: LoaderCircle,
    label: "status.working",
    color: "text-st-working",
    tint: "bg-st-working-tint",
    spin: true,
  },
  needs: { icon: Hand, label: "status.needs", color: "text-st-needs", tint: "bg-st-needs-tint", spin: false },
  done: { icon: Check, label: "status.done", color: "text-st-done", tint: "bg-st-done-tint", spin: false },
  error: {
    icon: TriangleExclamationPoint,
    label: "status.error",
    color: "text-st-error",
    tint: "bg-st-error-tint",
    spin: false,
  },
  off: { icon: Circle, label: "status.off", color: "text-st-off", tint: "bg-st-off-tint", spin: false },
};
