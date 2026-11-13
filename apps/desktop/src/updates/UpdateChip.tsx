// The status bar chip: an update is available (or installed and waiting for a restart). Click opens Settings, Updates.
import { Icons, t } from "@tessera/ui";
import { useAppDispatch } from "../store/hooks";
import { setSettingsOpen, setSettingsPage } from "../store/uiSlice";
import { useUpdateView } from "./state";

export function UpdateChip() {
  const dispatch = useAppDispatch();
  const view = useUpdateView();
  if (!view.pending && !view.installed) return null;
  const label = view.installed ? t("updates.chipRestart") : t("updates.chip", { version: view.pending?.version ?? "" });
  return (
    <button
      type="button"
      data-update-chip
      onClick={() => {
        dispatch(setSettingsPage("updates"));
        dispatch(setSettingsOpen(true));
      }}
      className="flex cursor-pointer items-center gap-1 rounded-sm border-0 bg-transparent px-1 text-xs text-accent"
    >
      <Icons.Download size={12} aria-hidden />
      {label}
    </button>
  );
}
