// The shortcut sheet (S-24, FR-75): Mod+/. Every shortcut on this platform, grouped by area, from the registry, with
// a filter. "Conflicts" stays empty until custom keybindings exist (M4.4).
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  getPlatform,
  Input,
  Kbd,
  type StringKey,
  t,
} from "@tessera/ui";
import { shallowEqual } from "react-redux";
import { useMemo, useRef, useState } from "react";
import { type ActionGroup, actionLabel, actions, GROUP_LABELS, shortcutEntries } from "../actions/registry";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { setSheetOpen } from "../store/uiSlice";

const GROUPS: ActionGroup[] = ["tabs", "panes", "projects", "terminal", "view"];
const PLATFORM_NAMES: Record<string, StringKey> = {
  mac: "platform.mac",
  windows: "platform.windows",
  other: "platform.other",
};

export function ShortcutSheet() {
  const open = useAppSelector((state) => state.ui.sheetOpen);
  // The whole state: actions' availability can depend on any slice.
  const state = useAppSelector((root) => ({ ...root }), shallowEqual);
  const dispatch = useAppDispatch();
  const [filter, setFilter] = useState("");
  const previous = useRef<HTMLElement | null>(null);
  const platform = getPlatform();

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return GROUPS.map((group) => ({
      group,
      rows: actions
        .filter((action) => action.group === group)
        .map((action) => ({
          action,
          label: actionLabel(action, { layout: state.layout, state, dispatch }),
          keys: shortcutEntries(action, platform),
        }))
        .filter((row) => row.keys.length > 0)
        .filter((row) => needle === "" || row.label.toLowerCase().includes(needle)),
    })).filter((entry) => entry.rows.length > 0);
  }, [filter, state, dispatch, platform]);

  return (
    <Dialog open={open} onOpenChange={(next) => dispatch(setSheetOpen(next))}>
      {open && (
        <DialogContent
          className="max-w-2xl"
          onOpenAutoFocus={() => {
            previous.current = document.activeElement as HTMLElement | null;
            setFilter("");
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            previous.current?.focus({ preventScroll: true });
          }}
        >
          <DialogTitle>{t("sheet.title")}</DialogTitle>
          <DialogDescription>
            {t("sheet.description", { platform: t(PLATFORM_NAMES[platform] ?? "platform.other") })}
          </DialogDescription>
          <Input
            type="search"
            aria-label={t("sheet.filter")}
            placeholder={t("sheet.filter")}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <div className="-mx-2 max-h-[min(60vh,32rem)] overflow-y-auto px-2">
            {groups.length === 0 && <p className="py-6 text-center text-base text-muted">{t("sheet.empty")}</p>}
            {groups.map(({ group, rows }) => (
              <table key={group} className="mb-4 w-full border-collapse text-base">
                <caption className="pb-1 text-start text-xs font-semibold text-muted">{t(GROUP_LABELS[group])}</caption>
                <tbody>
                  {rows.map(({ action, label, keys }) => (
                    <tr key={action.id} className="border-b border-border last:border-b-0">
                      <th scope="row" className="py-1.5 pe-4 text-start font-normal">
                        {label}
                      </th>
                      <td className="py-1.5 text-end">
                        <span className="inline-flex flex-wrap justify-end gap-1">
                          {keys.map(({ keys: chord, scope }) => (
                            <span key={chord} className="inline-flex items-center gap-1">
                              <Kbd shortcut={chord} platform={platform} />
                              {scope && <span className="text-xs text-muted">{t("sheet.inTabStrip")}</span>}
                            </span>
                          ))}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
            <table className="w-full text-base">
              <caption className="pb-1 text-start text-xs font-semibold text-muted">{t("sheet.conflicts")}</caption>
              <tbody>
                <tr>
                  <td className="py-1.5 text-muted">{t("sheet.noConflicts")}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
