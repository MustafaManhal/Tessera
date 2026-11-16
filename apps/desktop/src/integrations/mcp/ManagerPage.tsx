import { useCallback, useEffect, useId, useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Select,
  Switch,
  t,
} from "@tessera/ui";
import { managerClient, type Data, type Server, type Skill, type Preview, type Target } from "./client";
import { ServerEditor } from "./ServerEditor";
import { SkillEditor } from "../../skills/SkillEditor";
const blankServer: Server = { id: "", name: "", transport: "stdio", command: "", args: [], url: "", env_keys: [] };
const blankSkill: Skill = { id: "", name: "", kind: "agents_md", body: "", install_targets: [] };
export function IntegrationsManager() {
  const client = managerClient();
  const uid = useId();
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState("");
  const [server, setServer] = useState<Server | null>(null),
    [skill, setSkill] = useState<Skill | null>(null),
    [deleting, setDeleting] = useState<{ kind: "server" | "skill"; id: string } | null>(null),
    [install, setInstall] = useState<{ kind: "server" | "skill"; target: Target } | null>(null),
    [preview, setPreview] = useState<Preview | null>(null);
  const load = useCallback(async () => {
    setData(await client.list());
  }, [client]);
  useEffect(() => {
    let active = true;
    void client
      .list()
      .then((value) => {
        if (active) setData(value);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [client]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const choose = (kind: "server" | "skill", id: string, remove: boolean) => {
    setError("");
    setInstall({ kind, target: { id, target: "home", agent: "claude", remove, write_values: false } });
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-2" data-integrations-manager>
      <h2 className="text-base font-semibold">{t("manager.title")}</h2>
      <p className="my-2 text-sm text-muted">{t("manager.hint")}</p>
      {error && !install && !preview && !deleting && (
        <div role="alert" className="my-2 text-sm text-st-error">
          {error}
          <Button size="sm" variant="ghost" onClick={() => void run(load)}>
            {t("manager.retry")}
          </Button>
        </div>
      )}
      {status && (
        <p role="status" className="my-2 break-words text-sm text-muted">
          {status}
        </p>
      )}
      {!data ? (
        !error && <p role="status">{t("manager.loading")}</p>
      ) : (
        <>
          <section aria-label={t("manager.servers")}>
            <div className="my-3 flex flex-wrap items-center gap-2">
              <h3 className="mr-auto font-medium">{t("manager.servers")}</h3>
              <Button size="sm" disabled={busy} onClick={() => setServer({ ...blankServer })}>
                {t("manager.addServer")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setServer({ ...blankServer, name: "tessera", command: "tessera", args: ["mcp"] })}
              >
                {t("manager.preset")}
              </Button>
            </div>
            {data.servers.length === 0 ? (
              <p className="py-3 text-sm text-muted">{t("manager.emptyServers")}</p>
            ) : (
              data.servers.map((row) => (
                <article
                  key={row.id}
                  aria-label={row.name}
                  className="mb-3 rounded-md border border-border p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="font-medium">{row.name}</h4>
                    <span className="text-xs text-muted">{row.transport}</span>
                  </div>
                  <code className="my-1 block break-all text-xs">
                    {row.transport === "stdio" ? [row.command, ...row.args].join(" ") : row.url}
                  </code>
                  <p className="text-xs text-muted">
                    {t("manager.envNames")}: {row.env_keys.join(", ") || t("manager.none")}
                  </p>
                  <div className="my-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                    {data.agents.map((a) => (
                      <span key={a.id}>
                        {a.name}:{" "}
                        {a.manual
                          ? t("manager.manual")
                          : data.installs.some((i) => i.mcp_server_id === row.id && i.agent_id === a.id)
                            ? t("manager.installed")
                            : t("manager.notInstalled")}
                      </span>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setServer(row)}>
                      {t("manager.edit")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const tested = await client.test(row.id);
                          setStatus(
                            t("manager.toolsFound").replace("{tools}", tested.tools.join(", ") || t("manager.none")),
                          );
                        })
                      }
                    >
                      {t("manager.test")}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => choose("server", row.id, false)}>
                      {t("manager.install")}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => choose("server", row.id, true)}>
                      {t("manager.uninstall")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || data.installs.some((i) => i.mcp_server_id === row.id)}
                      onClick={() => setDeleting({ kind: "server", id: row.id })}
                    >
                      {t("manager.delete")}
                    </Button>
                  </div>
                </article>
              ))
            )}
          </section>
          <section aria-label={t("manager.skills")} className="border-t border-border pt-3">
            <div className="flex items-center gap-2">
              <h3 className="mr-auto font-medium">{t("manager.skills")}</h3>
              <Button size="sm" disabled={busy} onClick={() => setSkill({ ...blankSkill })}>
                {t("manager.addSkill")}
              </Button>
            </div>
            {data.skills.length === 0 ? (
              <p className="py-3 text-sm text-muted">{t("manager.emptySkills")}</p>
            ) : (
              data.skills.map((row) => (
                <article
                  key={row.id}
                  aria-label={row.name}
                  className="my-3 rounded-md border border-border p-3 text-sm"
                >
                  <h4 className="font-medium">{row.name}</h4>
                  <p className="text-xs text-muted">
                    {t(`manager.kind.${row.kind}`)} · {row.install_targets.length} {t("manager.targets")}
                  </p>
                  <p className="my-2 truncate text-muted">{row.body.split("\n")[0]}</p>
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSkill(row)}>
                      {t("manager.edit")}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => choose("skill", row.id, false)}>
                      {t("manager.install")}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => choose("skill", row.id, true)}>
                      {t("manager.uninstall")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || row.install_targets.length > 0}
                      onClick={() => setDeleting({ kind: "skill", id: row.id })}
                    >
                      {t("manager.delete")}
                    </Button>
                  </div>
                </article>
              ))
            )}
          </section>
        </>
      )}
      {server && (
        <ServerEditor
          initial={server}
          onClose={() => setServer(null)}
          onSave={async (row, values) => {
            await client.saveServer(row, values);
            await load();
            setServer(null);
          }}
        />
      )}
      {skill && (
        <SkillEditor
          initial={skill}
          onClose={() => setSkill(null)}
          onSave={async (row) => {
            await client.saveSkill(row);
            await load();
            setSkill(null);
          }}
        />
      )}
      <Dialog
        open={install !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setInstall(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-auto">
          <DialogTitle>{t(install?.target.remove ? "manager.uninstall" : "manager.install")}</DialogTitle>
          <DialogDescription>{t("manager.previewHint")}</DialogDescription>
          {error && (
            <p role="alert" className="text-sm text-st-error">
              {error}
            </p>
          )}
          {install && data && (
            <div className="flex flex-col gap-3">
              <label htmlFor={`${uid}-target`}>
                {t("manager.target")}
                <Select
                  id={`${uid}-target`}
                  aria-label={t("manager.target")}
                  value={install.target.target}
                  options={[
                    { value: "home", label: t("manager.home") },
                    ...data.tasks.map((task) => ({ value: task.id, label: task.name })),
                  ]}
                  onValueChange={(target) => setInstall({ ...install, target: { ...install.target, target } })}
                />
              </label>
              {install.kind === "server" && (
                <>
                  <label htmlFor={`${uid}-agent`}>
                    {t("manager.agent")}
                    <Select
                      id={`${uid}-agent`}
                      aria-label={t("manager.agent")}
                      value={install.target.agent}
                      options={data.agents.map((a) => ({
                        value: a.id,
                        label: a.name + (a.manual ? ` (${t("manager.manual")})` : ""),
                      }))}
                      onValueChange={(agent) => setInstall({ ...install, target: { ...install.target, agent } })}
                    />
                  </label>
                  {!install.target.remove && (
                    <label htmlFor={`${uid}-values`} className="flex items-center gap-2 text-sm">
                      <Switch
                        id={`${uid}-values`}
                        aria-label={t("manager.writeValues")}
                        checked={install.target.write_values}
                        onCheckedChange={(write_values) =>
                          setInstall({ ...install, target: { ...install.target, write_values } })
                        }
                      />
                      {t("manager.writeValues")}
                    </label>
                  )}
                </>
              )}
              <DialogFooter>
                <Button variant="ghost" disabled={busy} onClick={() => setInstall(null)}>
                  {t("button.cancel")}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const plan = await client.preview(install.kind, install.target);
                      setPreview(plan);
                      setInstall(null);
                    })
                  }
                >
                  {t("manager.preview")}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPreview(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-auto">
          <DialogTitle>{t(preview?.manual ? "manager.manualTitle" : "manager.previewTitle")}</DialogTitle>
          <DialogDescription>{t("manager.previewSafety")}</DialogDescription>
          {error && (
            <p role="alert" className="text-sm text-st-error">
              {error}
            </p>
          )}
          <p className="break-all text-xs text-muted">{preview?.path}</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-2 p-2 text-xs">
            {preview?.preview}
          </pre>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setPreview(null)}>
              {t("button.cancel")}
            </Button>
            {preview?.manual ? (
              <Button
                onClick={() =>
                  void run(async () => {
                    await navigator.clipboard.writeText(preview.preview);
                    setPreview(null);
                    setStatus(t("manager.copied"));
                  })
                }
              >
                {t("manager.copy")}
              </Button>
            ) : (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (!preview?.token) return;
                    const result = await client.apply(preview.token);
                    setPreview(null);
                    await load();
                    setStatus(t("manager.backup").replace("{path}", result.backup));
                  })
                }
              >
                {t("manager.apply")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(null);
        }}
      >
        <DialogContent>
          <DialogTitle>{t("manager.deleteTitle")}</DialogTitle>
          <DialogDescription>{t("manager.deleteHint")}</DialogDescription>
          {error && (
            <p role="alert" className="text-sm text-st-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>
              {t("button.cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (!deleting) return;
                  if (deleting.kind === "server") await client.deleteServer(deleting.id);
                  else await client.deleteSkill(deleting.id);
                  setDeleting(null);
                  await load();
                })
              }
            >
              {t("manager.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
