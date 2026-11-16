// "Close tab? npm run dev is still running." (04-app-flow F-03 step 7). Cancel is first, so it has the focus. The
// close runs after the dialog has let go of the focus, so the next pane can take it.
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, t } from "@tessera/ui";
import { useRef } from "react";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { performClose } from "../store/thunks";
import { type ConfirmState, requestConfirm } from "../store/uiSlice";

function message(request: ConfirmState): string {
  const [first] = request.processes;
  if (request.processes.length === 1 && first) return t("confirm.oneProcess", { process: first });
  return t("confirm.manyProcesses", { count: request.processes.length, list: request.processes.join(", ") });
}

export function ConfirmClose() {
  const request = useAppSelector((state) => state.ui.confirm);
  const dispatch = useAppDispatch();
  const setRequest = (next: ConfirmState | null) => dispatch(requestConfirm(next));
  const confirmed = useRef<ConfirmState | null>(null);
  const previous = useRef<HTMLElement | null>(null);

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (open) return;
        setRequest(null);
      }}
    >
      {request && (
        <DialogContent
          hideClose
          role="alertdialog"
          onOpenAutoFocus={() => {
            previous.current = document.activeElement as HTMLElement | null;
            confirmed.current = null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const run = confirmed.current;
            confirmed.current = null;
            if (run) dispatch(performClose(run.close));
            else previous.current?.focus();
          }}
        >
          <DialogTitle>{t(request.title)}</DialogTitle>
          <DialogDescription>{message(request)}</DialogDescription>
          <DialogFooter>
            <Button onClick={() => setRequest(null)}>{t("confirm.cancel")}</Button>
            <Button
              variant="danger"
              onClick={() => {
                confirmed.current = request;
                setRequest(null);
              }}
            >
              {t("confirm.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
