// Asks for a restart once an update is downloaded (in the background or from Settings): "Restart now" finishes it,
// "Later" leaves it for the next start (the status bar chip and Settings, Updates still offer the restart).
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, t } from "@tessera/ui";
import { useState } from "react";
import { updatesClient } from "./service";
import { setUpdateView, useUpdateView } from "./state";

export function UpdateReadyDialog() {
  const view = useUpdateView();
  const [restarting, setRestarting] = useState(false);
  const version = view.ready?.version ?? "";
  return (
    <Dialog open={view.promptOpen} onOpenChange={(open) => setUpdateView({ promptOpen: open })}>
      {view.promptOpen && (
        <DialogContent className="max-w-md" data-update-ready>
          <DialogTitle>{t("updates.readyTitle", { version })}</DialogTitle>
          <DialogDescription>{t("updates.readyBody")}</DialogDescription>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setUpdateView({ promptOpen: false })}>
              {t("updates.later")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={restarting}
              data-update-restart
              onClick={() => {
                setRestarting(true);
                void updatesClient()
                  .relaunch()
                  .finally(() => setRestarting(false));
              }}
            >
              {t("updates.restart")}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
