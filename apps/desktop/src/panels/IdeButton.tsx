// "Open in editor": opens the focused pane's folder in an IDE. The main button opens it in the default editor (the
// `editor.command` setting, which the user can change here or in Settings); the arrow lists every editor found on this
// computer to open the folder in one of them just this once, and to pick the default.
import {
  Button,
  Icons,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  t,
} from "@tessera/ui";
import { useEffect, useState } from "react";
import { configApplied } from "../store/configSlice";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { selectFocusedCwd } from "../store/selectors";
import { useSettingsClient } from "../settings/provider";
import { patchFor } from "../settings/schema";
import { openFolderInEditorWith } from "../terminal/open";
import { type EditorChoice, listEditors } from "./client";

export function IdeButton() {
  const dispatch = useAppDispatch();
  const client = useSettingsClient();
  const cwd = useAppSelector(selectFocusedCwd);
  const configured = useAppSelector((state) => {
    const editor = (state.config.values as { editor?: { command?: unknown } } | null)?.editor;
    return typeof editor?.command === "string" ? editor.command : null;
  });
  const [editors, setEditors] = useState<EditorChoice[]>([]);
  // The choice shows at once; it is saved to the setting in the background.
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void listEditors()
      .then((list) => alive && setEditors(list))
      .catch(() => alive && setEditors([]));
    return () => {
      alive = false;
    };
  }, []);
  const installed = editors.filter((editor) => editor.installed);
  // The default is the configured editor when it is installed here, else the first installed one.
  const current = installed.find((editor) => editor.id === (picked ?? configured)) ?? installed[0];
  const open = (editor: EditorChoice) => {
    if (cwd) void openFolderInEditorWith(editor.id, cwd);
  };
  const makeDefault = async (id: string) => {
    setPicked(id);
    try {
      dispatch(configApplied(await client.set(patchFor("editor.command", id))));
    } catch {
      // The Settings page shows the error when it is open; here the choice simply does not change.
    }
  };
  return (
    <span className="inline-flex items-center" data-ide-button>
      <Button
        size="sm"
        variant="ghost"
        icon={Icons.Code}
        disabled={!cwd || !current}
        title={current ? t("ide.openIn", { name: current.name }) : t("ide.none")}
        onClick={() => current && open(current)}
      >
        {current ? current.name : t("ide.open")}
      </Button>
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" variant="ghost" aria-label={t("ide.choose")} className="px-1" data-ide-menu>
            <Icons.ChevronDown size={14} aria-hidden />
          </Button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuLabel>{t("ide.openOnce")}</MenuLabel>
          {editors.map((editor) => (
            <MenuItem
              key={editor.id}
              disabled={!editor.installed || !cwd}
              data-ide-option={editor.id}
              onSelect={() => open(editor)}
            >
              {editor.installed ? editor.name : t("ide.notInstalled", { name: editor.name })}
            </MenuItem>
          ))}
          {installed.length > 0 && (
            <>
              <MenuSeparator />
              <MenuLabel>{t("ide.default")}</MenuLabel>
              <MenuRadioGroup value={current?.id ?? ""} onValueChange={(id) => void makeDefault(id)}>
                {installed.map((editor) => (
                  <MenuRadioItem key={editor.id} value={editor.id} data-ide-default={editor.id}>
                    {editor.name}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </>
          )}
        </MenuContent>
      </Menu>
    </span>
  );
}
