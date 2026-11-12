// Design tokens and base components (03-UI-UX §2, §4).
// CSS: import "tailwindcss", then src/tokens.css and src/theme.css (see theme.css). Wrap the app in <UIProvider>.

export { type ButtonProps, type ButtonSize, type ButtonVariant, Button, buttonVariants } from "./components/Button";
export {
  Dialog,
  DialogClose,
  DialogContent,
  type DialogContentProps,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "./components/Dialog";
export { type EmptyStateAction, EmptyState, type EmptyStateProps } from "./components/EmptyState";
export { IconButton, type IconButtonProps } from "./components/IconButton";
export { Input, type InputProps } from "./components/Input";
export { Kbd, type KbdProps } from "./components/Kbd";
export {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuItem,
  type MenuItemProps,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from "./components/Menu";
export { Select, type SelectOption, type SelectProps } from "./components/Select";
export { StatusPill, type StatusPillProps } from "./components/StatusPill";
export { Switch } from "./components/Switch";
export {
  setToastErrorReport,
  type ToastApi,
  type ToastKind,
  type ToastOptions,
  ToastProvider,
  useToast,
} from "./components/Toast";
export { Tooltip, type TooltipProps, TooltipProvider } from "./components/Tooltip";
export { UIProvider } from "./components/UIProvider";
export { cn } from "./cn";
export {
  AA_TEXT,
  AA_UI,
  composite,
  contrastRatio,
  mixSrgb,
  parseColor,
  type Rgba,
  relativeLuminance,
} from "./contrast";
export { Icons, iconSize, type LucideIcon } from "./icons";
export { describeShortcut, formatShortcut, getPlatform, type Platform, splitShortcut } from "./platform";
export { type Status, type StatusMeta, statuses, statusMeta } from "./status";
export { type StringKey, strings, t } from "./strings";
