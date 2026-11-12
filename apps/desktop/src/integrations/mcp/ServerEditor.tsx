import { useId, useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Input,
  Select,
  t,
} from "@tessera/ui";
import type { Server } from "./client";
export function ServerEditor({
  initial,
  onClose,
  onSave,
}: {
  initial: Server;
  onClose: () => void;
  onSave: (row: Server, values: Record<string, string>) => Promise<void>;
}) {
  const uid = useId();
  const [row, setRow] = useState(initial),
    [args, setArgs] = useState(JSON.stringify(initial.args)),
    [keys, setKeys] = useState(initial.env_keys.join(", ")),
    [values, setValues] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const envKeys = Array.from(new Set(keys.split(/[\s,]+/).filter(Boolean)));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-auto">
        <DialogTitle>{t(initial.id ? "manager.editServer" : "manager.addServer")}</DialogTitle>
        <DialogDescription>{t("manager.serverHint")}</DialogDescription>
        {initial.command === "tessera" && initial.args.includes("mcp") && (
          <p className="text-sm text-muted">{t("manager.ownHint")}</p>
        )}
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void (async () => {
              setError("");
              setBusy(true);
              try {
                const parsed: unknown = JSON.parse(args);
                if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string"))
                  throw Error(t("manager.argsInvalid"));
                await onSave(
                  { ...row, args: parsed as string[], env_keys: envKeys },
                  Object.fromEntries(Object.entries(values).filter(([k]) => envKeys.includes(k))),
                );
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          <label htmlFor={`${uid}-name`}>
            {t("manager.name")}
            <Input
              id={`${uid}-name`}
              required
              value={row.name}
              onChange={(e) => setRow({ ...row, name: e.target.value })}
            />
          </label>
          <label htmlFor={`${uid}-transport`}>
            {t("manager.transport")}
            <Select
              id={`${uid}-transport`}
              aria-label={t("manager.transport")}
              value={row.transport}
              options={[
                { value: "stdio", label: "stdio" },
                { value: "http", label: "HTTP" },
              ]}
              onValueChange={(transport) => setRow({ ...row, transport: transport as Server["transport"] })}
            />
          </label>
          {row.transport === "stdio" ? (
            <>
              <label htmlFor={`${uid}-command`}>
                {t("manager.command")}
                <Input
                  id={`${uid}-command`}
                  required
                  value={row.command}
                  onChange={(e) => setRow({ ...row, command: e.target.value })}
                />
              </label>
              <label htmlFor={`${uid}-args`}>
                {t("manager.args")}
                <Input id={`${uid}-args`} value={args} onChange={(e) => setArgs(e.target.value)} />
              </label>
            </>
          ) : (
            <label htmlFor={`${uid}-url`}>
              {t("manager.url")}
              <Input
                id={`${uid}-url`}
                required
                type="url"
                value={row.url}
                onChange={(e) => setRow({ ...row, url: e.target.value })}
              />
            </label>
          )}
          <label htmlFor={`${uid}-envNames`}>
            {t("manager.envNames")}
            <Input id={`${uid}-envNames`} value={keys} onChange={(e) => setKeys(e.target.value)} />
          </label>
          <p className="text-xs text-muted">{t("manager.secretHint")}</p>
          {envKeys.map((key) => (
            <label key={key} htmlFor={`${uid}-env-${key}`}>
              {t("manager.envValue").replace("{key}", key)}
              <Input
                id={`${uid}-env-${key}`}
                type="password"
                autoComplete="new-password"
                value={values[key] ?? ""}
                placeholder={t("manager.unchanged")}
                onChange={(e) => setValues({ ...values, [key]: e.target.value })}
              />
            </label>
          ))}
          {error && (
            <p role="alert" className="text-sm text-st-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              {t("button.cancel")}
            </Button>
            <Button type="submit" disabled={busy || !row.name.trim()}>
              {t("manager.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
