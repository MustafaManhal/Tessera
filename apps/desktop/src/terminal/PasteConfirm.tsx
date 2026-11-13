// "Paste 3 lines?" (FR-07, F-03 step 5): a preview of the first lines with control characters made visible, and
// Paste, Paste as one line, Cancel, plus "Don't ask again" that turns the setting off.
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Switch, t } from "@tessera/ui";
import { useId, useState } from "react";
import { hasControlCharacters, lineCount, previewLines } from "./paste";

export type PasteChoice = "paste" | "oneLine" | "cancel";

interface PasteConfirmProps {
  text: string | null;
  onChoose: (choice: PasteChoice, dontAskAgain: boolean) => void;
}

export function PasteConfirm({ text, onChoose }: PasteConfirmProps) {
  const [dontAsk, setDontAsk] = useState(false);
  const switchId = useId();
  if (text === null) return null;
  const { lines, more } = previewLines(text);
  const count = lineCount(text);
  const control = hasControlCharacters(text);
  const choose = (choice: PasteChoice) => onChoose(choice, choice !== "cancel" && dontAsk);

  return (
    <Dialog open onOpenChange={(open) => !open && choose("cancel")}>
      <DialogContent
        hideClose
        role="alertdialog"
        className="max-w-xl"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DialogTitle>
          {count > 1 ? t("paste.titleLines", { count }) : control ? t("paste.title") : t("paste.titleOne")}
        </DialogTitle>
        <DialogDescription>
          {control ? t("paste.controlCharacters") : count > 1 ? t("paste.lines") : t("paste.always")}
        </DialogDescription>
        <figure className="m-0">
          <figcaption className="sr-only">{t("paste.preview")}</figcaption>
          <pre className="max-h-48 overflow-auto rounded-md border border-border bg-surface-2 p-2 font-mono text-sm whitespace-pre-wrap break-all">
            {lines.join("\n")}
            {more > 0 && `\n${t("paste.more", { count: more })}`}
          </pre>
        </figure>
        <div className="flex items-center gap-2">
          <Switch id={switchId} checked={dontAsk} onCheckedChange={setDontAsk} />
          <label htmlFor={switchId} className="text-base">
            {t("paste.dontAsk")}
          </label>
        </div>
        <DialogFooter>
          <Button onClick={() => choose("cancel")}>{t("confirm.cancel")}</Button>
          <Button onClick={() => choose("oneLine")}>{t("paste.oneLine")}</Button>
          <Button variant="primary" onClick={() => choose("paste")}>
            {t("paste.paste")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
