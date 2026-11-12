// S-19 SSH hosts (FR-62): hosts from ~/.ssh/config (read only; Tessera never writes that file) and hosts added by
// hand. Per host: Connect, edit (auth method, key), save or forget a password in the OS keychain, remove a manual host.
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  EmptyState,
  Icons,
  Input,
  Select,
  t,
} from "@tessera/ui";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Field } from "../projects/dialogs/Field";
import { useAppDispatch } from "../store/hooks";
import { setSettingsOpen } from "../store/uiSlice";
import { connectSsh } from "./connect";
import { sshClient } from "./service";
import type { SshAuth, SshHostInfo, SshHostInput } from "./types";

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function address(host: SshHostInfo): string {
  const user = host.user ? `${host.user}@` : "";
  const port = host.port ? `:${host.port}` : "";
  return `${user}${host.host}${port}`;
}

export function SshHostsPage() {
  const dispatch = useAppDispatch();
  const [hosts, setHosts] = useState<SshHostInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SshHostInfo | "new" | null>(null);
  const [password, setPassword] = useState<SshHostInfo | null>(null);
  const [removing, setRemoving] = useState<SshHostInfo | null>(null);

  const reload = useCallback(async () => {
    try {
      setHosts(await sshClient().list());
      setError(null);
    } catch (cause) {
      setError(message(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const connect = (host: SshHostInfo) => {
    dispatch(setSettingsOpen(false));
    void dispatch(connectSsh(host.id));
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4" data-ssh-page>
      <div className="flex items-center gap-2">
        <p className="me-auto text-sm text-muted">{t("ssh.page.description")}</p>
        <Button size="sm" icon={Icons.Plus} onClick={() => setEditing("new")}>
          {t("ssh.add")}
        </Button>
      </div>
      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-lg bg-st-error-tint p-2 text-sm">
          <span className="me-auto">{t("ssh.loadFailed", { message: error })}</span>
          <Button size="sm" onClick={() => void reload()}>
            {t("ssh.retry")}
          </Button>
        </div>
      )}
      {hosts?.length === 0 ? (
        <EmptyState icon={Icons.Server} message={t("ssh.empty")} />
      ) : (
        <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto" aria-label={t("ssh.list")}>
          {hosts?.map((host) => (
            <li
              key={host.id}
              data-ssh-host={host.alias}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2"
            >
              <Icons.Server size={16} className="text-muted" aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">{host.alias}</span>
                <span className="truncate text-xs text-muted">
                  {address(host)} · {t(`ssh.auth.${host.auth}`)}
                  {host.proxy_jump ? ` · ${t("ssh.via", { jump: host.proxy_jump })}` : ""} ·{" "}
                  {t(host.source === "config" ? "ssh.source.config" : "ssh.source.manual")}
                  {host.password_saved ? ` · ${t("ssh.passwordSaved")}` : ""}
                </span>
              </div>
              <Button size="sm" variant="primary" onClick={() => connect(host)}>
                {t("ssh.connect")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(host)}>
                {t("ssh.edit")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPassword(host)}>
                {t(host.password_saved ? "ssh.password.manage" : "ssh.password.save")}
              </Button>
              {(host.source === "manual" || !host.id.startsWith("config:")) && (
                <Button size="sm" variant="ghost" onClick={() => setRemoving(host)}>
                  {t(host.source === "manual" ? "ssh.remove" : "ssh.resetSettings")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <HostDialog
          host={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
      {password && (
        <PasswordDialog
          host={password}
          onClose={() => setPassword(null)}
          onDone={() => {
            setPassword(null);
            void reload();
          }}
        />
      )}
      {removing && (
        <Dialog open onOpenChange={(open) => !open && setRemoving(null)}>
          <DialogContent role="alertdialog">
            <DialogTitle>{t("ssh.removeTitle", { name: removing.alias })}</DialogTitle>
            <DialogDescription>
              {t(removing.source === "manual" ? "ssh.removeBody" : "ssh.resetBody")}
            </DialogDescription>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setRemoving(null)}>
                {t("form.cancel")}
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  try {
                    await sshClient().remove(removing.id);
                  } catch (cause) {
                    setError(message(cause));
                  }
                  setRemoving(null);
                  void reload();
                }}
              >
                {t(removing.source === "manual" ? "ssh.remove" : "ssh.resetSettings")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function HostDialog({
  host,
  onClose,
  onSaved,
}: {
  host: SshHostInfo | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const fromConfig = host?.source === "config";
  const [alias, setAlias] = useState(host?.alias ?? "");
  const [address, setAddress] = useState(host?.host ?? "");
  const [port, setPort] = useState(host?.port ? String(host.port) : "");
  const [user, setUser] = useState(host?.user ?? "");
  const [auth, setAuth] = useState<SshAuth>(host?.auth ?? "agent");
  const [keyPath, setKeyPath] = useState(host?.key_path ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const portValue = port.trim() === "" ? null : Number(port);
  const portInvalid = portValue !== null && (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (portInvalid) return;
    setBusy(true);
    const input: SshHostInput = {
      id: host?.id ?? null,
      alias: alias.trim(),
      host: address.trim(),
      port: portValue,
      user: user.trim() || null,
      auth,
      key_path: auth === "key" ? keyPath.trim() || null : null,
    };
    try {
      await sshClient().save(input);
      onSaved();
    } catch (cause) {
      setError(message(cause));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent data-ssh-host-dialog>
        <DialogTitle>{t(host ? "ssh.editTitle" : "ssh.addTitle")}</DialogTitle>
        <DialogDescription>{t(fromConfig ? "ssh.configNote" : "ssh.manualNote")}</DialogDescription>
        <form className="flex flex-col gap-2" onSubmit={(event) => void submit(event)}>
          <Field label={t("ssh.field.alias")}>
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={alias}
                disabled={fromConfig}
                onChange={(e) => setAlias(e.target.value)}
              />
            )}
          </Field>
          <Field label={t("ssh.field.host")}>
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={address}
                disabled={fromConfig}
                onChange={(e) => setAddress(e.target.value)}
              />
            )}
          </Field>
          <div className="flex gap-2">
            <Field label={t("ssh.field.port")} error={portInvalid ? t("ssh.portInvalid") : null} className="w-28">
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  inputMode="numeric"
                  value={port}
                  disabled={fromConfig}
                  onChange={(e) => setPort(e.target.value)}
                />
              )}
            </Field>
            <Field label={t("ssh.field.user")} className="flex-1">
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  value={user}
                  disabled={fromConfig}
                  onChange={(e) => setUser(e.target.value)}
                />
              )}
            </Field>
          </div>
          <Field label={t("ssh.field.auth")}>
            {({ id, describedBy }) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                value={auth}
                onValueChange={(value) => setAuth(value as SshAuth)}
                options={(["agent", "key", "password"] as const).map((value) => ({
                  value,
                  label: t(`ssh.auth.${value}`),
                }))}
              />
            )}
          </Field>
          {auth === "key" && (
            <Field label={t("ssh.field.key")} hint={t("ssh.keyHint")}>
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  value={keyPath}
                  onChange={(e) => setKeyPath(e.target.value)}
                />
              )}
            </Field>
          )}
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              {t("form.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={busy || portInvalid}>
              {t("ssh.saveHost")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PasswordDialog({ host, onClose, onDone }: { host: SshHostInfo; onClose: () => void; onDone: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      onDone();
    } catch (cause) {
      setError(message(cause));
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent data-ssh-password-dialog>
        <DialogTitle>{t("ssh.password.title", { name: host.alias })}</DialogTitle>
        <DialogDescription>{t("ssh.password.body")}</DialogDescription>
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => sshClient().savePassword(host.alias, value));
          }}
        >
          <Field label={t("ssh.password.field")}>
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                type="password"
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
          </Field>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <DialogFooter>
            {host.password_saved && (
              <Button
                type="button"
                variant="danger"
                disabled={busy}
                onClick={() => void run(() => sshClient().forgetPassword(host.alias))}
              >
                {t("ssh.password.forget")}
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              {t("form.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={busy || value === ""}>
              {t("ssh.password.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
