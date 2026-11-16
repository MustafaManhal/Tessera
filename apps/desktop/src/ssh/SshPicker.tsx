// "Connect to SSH host…": pick a host and open a terminal on it in a new tab.
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Select, t } from "@tessera/ui";
import { useEffect, useState } from "react";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { setSettingsOpen, setSettingsPage } from "../store/uiSlice";
import { connectSsh } from "./connect";
import { sshClient } from "./service";
import { setSshPicker } from "./sshSlice";
import type { SshHostInfo } from "./types";

export function SshPicker() {
  const open = useAppSelector((state) => state.ssh.pickerOpen);
  const dispatch = useAppDispatch();
  const [hosts, setHosts] = useState<SshHostInfo[]>([]);
  const [chosen, setChosen] = useState("");

  useEffect(() => {
    if (!open) return;
    void sshClient()
      .list()
      .then((list) => {
        setHosts(list);
        setChosen((current) => (list.some((h) => h.id === current) ? current : (list[0]?.id ?? "")));
      })
      .catch(() => setHosts([]));
  }, [open]);

  const close = () => dispatch(setSshPicker(false));

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent data-ssh-picker>
        <DialogTitle>{t("ssh.pick.title")}</DialogTitle>
        <DialogDescription>{t("ssh.pick.description")}</DialogDescription>
        {hosts.length === 0 ? (
          <p className="text-sm text-muted">{t("ssh.empty")}</p>
        ) : (
          <Select
            aria-label={t("ssh.pick.title")}
            value={chosen}
            onValueChange={setChosen}
            options={hosts.map((h) => ({ value: h.id, label: h.alias }))}
          />
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              close();
              dispatch(setSettingsPage("ssh"));
              dispatch(setSettingsOpen(true));
            }}
          >
            {t("ssh.pick.manage")}
          </Button>
          <Button
            variant="primary"
            disabled={!chosen}
            onClick={() => {
              close();
              void dispatch(connectSsh(chosen));
            }}
          >
            {t("ssh.connect")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
