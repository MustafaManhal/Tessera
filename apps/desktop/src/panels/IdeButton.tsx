// "Open in editor": opens the focused pane's folder in an IDE. The button opens it in the editor chosen last (the first
// installed one at first); the arrow lists every editor Tessera knows, with the ones that are not installed greyed out.
import { Button, Icons, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, t } from "@tessera/ui";
import { useEffect, useState } from "react";
import { useAppSelector } from "../store/hooks";
import { selectFocusedCwd } from "../store/selectors";
import { openFolderInEditorWith } from "../terminal/open";
import { type EditorChoice, listEditors } from "./client";

const KEY = "tessera.ide";

function remembered(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function IdeButton() {
  const cwd = useAppSelector(selectFocusedCwd);
  const [editors, setEditors] = useState<EditorChoice[]>([]);
  const [chosen, setChosen] = useState<string | null>(remembered);
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
  const current = installed.find((editor) => editor.id === chosen) ?? installed[0];
  const open = (editor: EditorChoice) => {
    if (!cwd) return;
    setChosen(editor.id);
    try {
      localStorage.setItem(KEY, editor.id);
    } catch {
      // Remembering the choice is a convenience only.
    }
    void openFolderInEditorWith(editor.id, cwd);
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
          <MenuLabel>{t("ide.choose")}</MenuLabel>
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
        </MenuContent>
      </Menu>
    </span>
  );
}
