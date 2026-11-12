// The status bar (03-UI-UX §3, 22 px): the focused pane's cwd now. Later items get their own segment here, each
// rendering nothing until its milestone: branch and ahead count (M5), agent (M6), ports (M5.4), notifications (M7).
import { getPlatform, IconButton, Icons, t } from "@tessera/ui";
import { primaryShortcut, runAction } from "../actions/registry";
import { InboxButton } from "../notify/InboxPanel";
import { UpdateChip } from "../updates/UpdateChip";
import { useAppSelector } from "../store/hooks";
import { selectFocusedCwd } from "../store/selectors";

export function StatusBar() {
  const cwd = useAppSelector(selectFocusedCwd);
  const secureKeyboardEntry = useAppSelector((state) => state.settings.terminal.secureKeyboardEntry);
  const platform = getPlatform();
  return (
    <footer className="flex h-5.5 shrink-0 items-center gap-3 border-t border-border bg-surface bg-[linear-gradient(90deg,color-mix(in_srgb,var(--accent)_10%,var(--surface)),var(--surface)_40%)] ps-3 pe-1 text-xs text-muted">
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
      <InboxButton />
      <IconButton
        icon={Icons.MessageSquarePlus}
        label={t("action.feedback.open")}
        shortcut={primaryShortcut("feedback.open", platform)}
        size="sm"
        className="-my-px"
        onClick={() => runAction("feedback.open")}
      />
      <IconButton
        icon={Icons.Info}
        label={t("action.app.about")}
        shortcut={primaryShortcut("app.about", platform)}
        size="sm"
        className="-my-px"
        onClick={() => runAction("app.about")}
      />
      <IconButton
        icon={Icons.Keyboard}
        label={t("action.view.shortcuts")}
        shortcut={primaryShortcut("view.shortcuts", platform)}
        size="sm"
        className="-my-px"
        onClick={() => runAction("view.shortcuts")}
      />
    </footer>
  );
}
