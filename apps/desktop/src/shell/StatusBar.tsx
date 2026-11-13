// The status bar (03-UI-UX §3, 22 px): the focused pane's cwd now. Later items get their own segment here, each
// rendering nothing until its milestone: branch and ahead count (M5), agent (M6), ports (M5.4), notifications (M7).
import { getPlatform, IconButton, Icons, t } from "@tessera/ui";
import { primaryShortcut, runAction } from "../actions/registry";
import { UpdateChip } from "../updates/UpdateChip";
import { useAppSelector } from "../store/hooks";
import { selectFocusedCwd } from "../store/selectors";

export function StatusBar() {
  const cwd = useAppSelector(selectFocusedCwd);
  const secureKeyboardEntry = useAppSelector((state) => state.settings.terminal.secureKeyboardEntry);
  const platform = getPlatform();
  const hasTabs = useAppSelector((state) => state.layout.tabs.length > 0);
  const broadcasting = useAppSelector((state) => state.ui.broadcast !== null);
  return (
    <footer className="flex h-5.5 shrink-0 items-center gap-3 border-t border-border bg-surface ps-3 pe-1 text-xs text-muted">
      <span className="flex min-w-0 items-center gap-1" title={cwd ?? undefined}>
        <Icons.Folder size={12} aria-hidden className="shrink-0" />
        <span className="sr-only">{t("statusBar.cwd")}: </span>
        <span className="truncate" data-segment="cwd">
          {cwd || t("statusBar.noPane")}
        </span>
      </span>
      {platform === "mac" && secureKeyboardEntry && (
        <span
          role="img"
          className="flex items-center gap-1"
          aria-label={t("statusBar.secureKeyboardEntry")}
          title={t("statusBar.secureKeyboardEntry")}
          data-secure-keyboard-entry
        >
          <Icons.LockKeyhole size={12} aria-hidden />
        </span>
      )}
      <span className="flex-1" />
      <UpdateChip />
      <IconButton
        icon={Icons.Columns2}
        label={t("action.pane.splitRight")}
        shortcut={primaryShortcut("pane.splitRight", platform)}
        size="sm"
        className="-my-px"
        disabled={!hasTabs}
        onClick={() => runAction("pane.splitRight")}
      />
      <IconButton
        icon={Icons.Rows2}
        label={t("action.pane.splitDown")}
        shortcut={primaryShortcut("pane.splitDown", platform)}
        size="sm"
        className="-my-px"
        disabled={!hasTabs}
        onClick={() => runAction("pane.splitDown")}
      />
      <IconButton
        icon={Icons.Radio}
        label={t(broadcasting ? "action.terminal.broadcastOff" : "action.terminal.broadcastOn")}
        shortcut={primaryShortcut("terminal.broadcast", platform)}
        size="sm"
        className="-my-px"
        aria-pressed={broadcasting}
        onClick={() => runAction("terminal.broadcast")}
      />
    </footer>
  );
}
