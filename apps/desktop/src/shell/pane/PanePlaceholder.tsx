// Stands in for the terminal until M1.2: a title bar, a fake prompt in the pane's cwd and a cursor that shows focus
// (solid when focused, hollow when not, like a terminal's). It takes focus, so keyboard flows are testable. In dev
// builds a menu can pretend a process is running, to try the close confirmation.
import { cn, IconButton, Icons, Menu, MenuCheckboxItem, MenuContent, MenuTrigger, t } from "@tessera/ui";
import { type Ref, useImperativeHandle, useRef } from "react";
import { baseName, paneTitle } from "../../layout";
import type { PaneContentHandle, PaneContentProps } from "./PaneContent";

/** The process the dev menu pretends is running. */
export const SIMULATED_PROCESS = "npm run dev";

export function PanePlaceholder({
  ref,
  info,
  focused,
  onFocused,
  onRunningProcessChange,
}: PaneContentProps & { ref?: Ref<PaneContentHandle> }) {
  const input = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus({ preventScroll: true }) }), []);
  const title = paneTitle(info) ?? t("tab.untitled");
  const folder = baseName(info.cwd) || info.cwd;

  return (
    <div className="flex h-full min-h-0 flex-col bg-term-bg">
      <div className="flex h-6 shrink-0 items-center gap-2 border-b border-border bg-surface ps-2 pe-1 text-xs text-muted">
        <span className="min-w-0 truncate font-medium text-fg">{title}</span>
        <span className="min-w-0 flex-1 truncate">{info.cwd}</span>
        {import.meta.env.DEV && (
          <Menu>
            <MenuTrigger asChild>
              <IconButton icon={Icons.Ellipsis} label={t("pane.devMenu")} size="sm" tabIndex={-1} />
            </MenuTrigger>
            <MenuContent align="end">
              <MenuCheckboxItem
                checked={info.runningProcess !== null}
                onCheckedChange={(checked) => onRunningProcessChange(checked ? SIMULATED_PROCESS : null)}
              >
                {t("pane.simulateProcess")}
              </MenuCheckboxItem>
            </MenuContent>
          </Menu>
        )}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: the stand-in for the terminal's input; a fieldset would add a
          border and a legend that the real terminal does not have. */}
      <div
        ref={input}
        data-terminal
        role="group"
        aria-label={title}
        tabIndex={focused ? 0 : -1}
        onFocus={onFocused}
        className="min-h-0 flex-1 overflow-hidden p-2 font-mono text-base leading-term text-fg outline-none"
      >
        <p>
          <span className="text-muted">{folder}</span> ${" "}
          <span
            aria-hidden
            className={cn(
              "inline-block h-[1.1em] w-[0.6em] translate-y-[0.15em]",
              focused ? "bg-fg" : "border border-muted",
            )}
          />
        </p>
        {info.runningProcess && <p className="text-muted">{t("pane.running", { process: info.runningProcess })}</p>}
        <p className="mt-2 font-sans text-sm text-muted">{t("pane.placeholderNote")}</p>
      </div>
    </div>
  );
}
