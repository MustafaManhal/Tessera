// "New terminal": a terminal without a task, in the home folder or in a folder the user picks. The sidebar's terminal
// button and the tab strip's + open the same menu.
import {
  getPlatform,
  IconButton,
  Icons,
  type LucideIcon,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  t,
} from "@tessera/ui";
import { primaryShortcut, runAction } from "../actions/registry";

export function NewTerminalMenu({
  icon = Icons.SquareTerminal,
  label = t("sidebar.newTerminal"),
  align = "end",
  shortcut,
  ...data
}: {
  icon?: LucideIcon;
  label?: string;
  align?: "start" | "end";
  /** Shown in the button's tooltip (the tab strip's + shows New tab's). */
  shortcut?: string;
  [key: `data-${string}`]: string | boolean | undefined;
}) {
  const platform = getPlatform();
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton size="sm" icon={icon} label={label} shortcut={shortcut} {...data} />
      </MenuTrigger>
      <MenuContent align={align}>
        <MenuItem
          icon={Icons.House}
          shortcut={primaryShortcut("tab.new", platform) || undefined}
          data-new-terminal-home
          onSelect={() => runAction("tab.new")}
        >
          {t("action.tab.newHome")}
        </MenuItem>
        <MenuItem
          icon={Icons.FolderOpen}
          shortcut={primaryShortcut("tab.newInFolder", platform) || undefined}
          data-new-terminal-folder
          onSelect={() => runAction("tab.newInFolder")}
        >
          {t("action.tab.newInFolder")}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
