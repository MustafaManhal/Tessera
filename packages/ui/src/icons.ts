// The icon set is lucide (03-UI-UX §2). The app imports icons from here, so lucide stays one dependency of the
// design system: `import { Icons } from "@tessera/ui"; <Icons.Plus size={iconSize.row} />`.
export type { LucideIcon } from "lucide-react";
export * as Icons from "lucide-react";

// Icon sizes in px for lucide's `size` prop (03-UI-UX §2: 16 px in rows, 14 px in tabs; same values as
// --icon-size-row and --icon-size-tab). Stroke 1.75 comes from theme.css for every `.lucide` icon.
export const iconSize = {
  tab: 14,
  row: 16,
  /** EmptyState only: the one larger icon in the chrome. */
  empty: 24,
} as const;
