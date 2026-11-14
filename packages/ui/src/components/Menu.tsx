// Menus (03-UI-UX §4): a drop-down menu opened by a button (Radix DropdownMenu) and a context menu opened by a right
// click or Shift+F10 (Radix ContextMenu). Both share one look: items with an optional icon and a shortcut chip,
// checkbox and radio items, separators, labels and submenus. Arrow keys move, Enter picks, Esc closes.
import { Check, ChevronRight, Circle, type LucideIcon } from "lucide-react";
import { ContextMenu as ContextMenuPrimitive, DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";
import { iconSize } from "../icons";
import { Kbd } from "./Kbd";

const contentClass = cn(
  "z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-48 overflow-y-auto rounded-lg border",
  "border-border bg-surface p-1 text-fg shadow-popover data-[state=open]:animate-fade-in",
);
const contextContentClass = cn(contentClass, "max-h-(--radix-context-menu-content-available-height)");
const itemClass = cn(
  "relative flex h-7 cursor-default items-center gap-2 rounded-sm ps-2 pe-2 text-base select-none",
  "data-disabled:opacity-50 data-highlighted:bg-surface-3",
);
const indentedItemClass = cn(itemClass, "ps-7");
const indicatorClass = "absolute start-2 inline-flex items-center";

interface ItemBodyProps {
  icon?: LucideIcon;
  shortcut?: string;
  children: ReactNode;
}

function ItemBody({ icon: Icon, shortcut, children }: ItemBodyProps) {
  return (
    <>
      {Icon && <Icon size={iconSize.row} className="shrink-0 text-muted" aria-hidden />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <Kbd shortcut={shortcut} className="ms-4" />}
    </>
  );
}

// Drop-down menu ----------------------------------------------------------------------------------------------

export const Menu = DropdownMenuPrimitive.Root;
export const MenuTrigger = DropdownMenuPrimitive.Trigger;
export const MenuGroup = DropdownMenuPrimitive.Group;
export const MenuRadioGroup = DropdownMenuPrimitive.RadioGroup;
export const MenuSub = DropdownMenuPrimitive.Sub;

export function MenuContent({
  className,
  sideOffset = 4,
  collisionPadding = 8,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(contentClass, className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export interface MenuItemProps extends Omit<ComponentProps<typeof DropdownMenuPrimitive.Item>, "children"> {
  icon?: LucideIcon;
  /** Platform-neutral shortcut shown as a chip. */
  shortcut?: string;
  children: ReactNode;
}

export function MenuItem({ icon, shortcut, children, className, ...props }: MenuItemProps) {
  return (
    <DropdownMenuPrimitive.Item className={cn(itemClass, className)} {...props}>
      <ItemBody icon={icon} shortcut={shortcut}>
        {children}
      </ItemBody>
    </DropdownMenuPrimitive.Item>
  );
}

export function MenuCheckboxItem({
  shortcut,
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>, "children"> & {
  shortcut?: string;
  children: ReactNode;
}) {
  return (
    <DropdownMenuPrimitive.CheckboxItem className={cn(indentedItemClass, className)} {...props}>
      <DropdownMenuPrimitive.ItemIndicator className={indicatorClass}>
        <Check size={iconSize.tab} aria-hidden />
      </DropdownMenuPrimitive.ItemIndicator>
      <ItemBody shortcut={shortcut}>{children}</ItemBody>
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

export function MenuRadioItem({
  children,
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem className={cn(indentedItemClass, className)} {...props}>
      <DropdownMenuPrimitive.ItemIndicator className={indicatorClass}>
        <Circle size={8} className="fill-current" aria-hidden />
      </DropdownMenuPrimitive.ItemIndicator>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

export function MenuSubTrigger({
  icon,
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof DropdownMenuPrimitive.SubTrigger>, "children"> & {
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <DropdownMenuPrimitive.SubTrigger className={cn(itemClass, "data-[state=open]:bg-surface-3", className)} {...props}>
      <ItemBody icon={icon}>{children}</ItemBody>
      <ChevronRight size={iconSize.tab} className="shrink-0 text-muted rtl:rotate-180" aria-hidden />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

export function MenuSubContent({ className, ...props }: ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent collisionPadding={8} className={cn(contentClass, className)} {...props} />
    </DropdownMenuPrimitive.Portal>
  );
}

export function MenuLabel({ className, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label className={cn("px-2 py-1 text-xs font-medium text-muted", className)} {...props} />
  );
}

export function MenuSeparator({ className, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return <DropdownMenuPrimitive.Separator className={cn("my-1 h-px bg-border", className)} {...props} />;
}

// Context menu ------------------------------------------------------------------------------------------------

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup;
export const ContextMenuSub = ContextMenuPrimitive.Sub;

export function ContextMenuContent({
  className,
  collisionPadding = 8,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        collisionPadding={collisionPadding}
        className={cn(contextContentClass, className)}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuItem({
  icon,
  shortcut,
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof ContextMenuPrimitive.Item>, "children"> & {
  icon?: LucideIcon;
  shortcut?: string;
  children: ReactNode;
}) {
  return (
    <ContextMenuPrimitive.Item className={cn(itemClass, className)} {...props}>
      <ItemBody icon={icon} shortcut={shortcut}>
        {children}
      </ItemBody>
    </ContextMenuPrimitive.Item>
  );
}

export function ContextMenuCheckboxItem({
  shortcut,
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof ContextMenuPrimitive.CheckboxItem>, "children"> & {
  shortcut?: string;
  children: ReactNode;
}) {
  return (
    <ContextMenuPrimitive.CheckboxItem className={cn(indentedItemClass, className)} {...props}>
      <ContextMenuPrimitive.ItemIndicator className={indicatorClass}>
        <Check size={iconSize.tab} aria-hidden />
      </ContextMenuPrimitive.ItemIndicator>
      <ItemBody shortcut={shortcut}>{children}</ItemBody>
    </ContextMenuPrimitive.CheckboxItem>
  );
}

export function ContextMenuRadioItem({
  children,
  className,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.RadioItem>) {
  return (
    <ContextMenuPrimitive.RadioItem className={cn(indentedItemClass, className)} {...props}>
      <ContextMenuPrimitive.ItemIndicator className={indicatorClass}>
        <Circle size={8} className="fill-current" aria-hidden />
      </ContextMenuPrimitive.ItemIndicator>
      {children}
    </ContextMenuPrimitive.RadioItem>
  );
}

export function ContextMenuSubTrigger({
  icon,
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof ContextMenuPrimitive.SubTrigger>, "children"> & {
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <ContextMenuPrimitive.SubTrigger className={cn(itemClass, "data-[state=open]:bg-surface-3", className)} {...props}>
      <ItemBody icon={icon}>{children}</ItemBody>
      <ChevronRight size={iconSize.tab} className="shrink-0 text-muted rtl:rotate-180" aria-hidden />
    </ContextMenuPrimitive.SubTrigger>
  );
}

export function ContextMenuSubContent({ className, ...props }: ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent collisionPadding={8} className={cn(contextContentClass, className)} {...props} />
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuSeparator({ className, ...props }: ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return <ContextMenuPrimitive.Separator className={cn("my-1 h-px bg-border", className)} {...props} />;
}
