// The agent catalog and profiles screen (S-05, FR-34, FR-35, FR-42): installed agents first with their version and
// path, the rest with install and docs links; per agent its profiles, a live command preview, hook status, and the
// skip-permissions switch behind its red warning. Links open in the system browser, like every other URL in the app.
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  EmptyState,
  Icons,
  type StringKey,
  t,
} from "@tessera/ui";
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { notifications } from "../notify";
import { useAppDispatch } from "../store/hooks";
import { setSettingsOpen } from "../store/uiSlice";
import { openExternal } from "../terminal/open";
import { agentLaunchToast, startAgent } from "./launch";
import { CustomAgentDialog } from "./CustomAgentDialog";
import { HookReviewDialog, type HookAction } from "./HookReviewDialog";
import { AgentLogo } from "./AgentLogo";
import { agentsErrorMessage } from "./errors";
import type { AgentInfo, AgentProfile, AgentProfileInput, HookChange } from "./types";
import { ProfileEditor } from "./ProfileEditor";
import { agentsClient } from "./service";
import { useAgents } from "./useAgents";

function AgentLink({ url, label, name, tabIndex }: { url: string; label: string; name: string; tabIndex?: number }) {
  return (
    <button
      type="button"
      tabIndex={tabIndex}
      aria-label={`${label} ${name}`}
      className="inline-flex min-h-6 items-center gap-0.5 rounded-sm text-sm text-accent-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus"
      onClick={() => void openExternal(url)}
    >
      {label}
      <Icons.ExternalLink size={12} aria-hidden />
    </button>
  );
}

function uniqueName(profiles: readonly AgentProfile[], base: string): string {
  const names = new Set(profiles.map((profile) => profile.name));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

export function AgentsPage() {
  const client = agentsClient();
  const { catalog, profiles, loading, rescanning, error, reload, rescan } = useAgents(client);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [customDialog, setCustomDialog] = useState<{ editId: string | null } | null>(null);
  const [deletingAgent, setDeletingAgent] = useState<AgentInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const bundledIds = useMemo(
    () => new Set(catalog?.filter((a) => a.source !== "user").map((a) => a.id) ?? []),
    [catalog],
  );
  const sourceLabel = (source: AgentInfo["source"]) =>
    t(
      source === "user"
        ? "agents.source.custom"
        : source === "override"
          ? "agents.source.override"
          : "agents.source.user",
    );

  const sorted = catalog ? [...catalog].sort((a, b) => Number(b.installed) - Number(a.installed)) : [];
  const installed = sorted.filter((agent) => agent.installed).length;

  // Keep a selection that still exists; otherwise start on the first installed agent.
  useEffect(() => {
    if (!catalog) return;
    if (selected && catalog.some((agent) => agent.id === selected)) return;
    setSelected(catalog.find((agent) => agent.installed)?.id ?? catalog[0]?.id ?? null);
  }, [catalog, selected]);

  const select = (id: string) => {
    setSelected(id);
    setEditing(null);
    setConfirmDelete(null);
    setActionError(null);
  };

  const agent = sorted.find((candidate) => candidate.id === selected) ?? null;
  const agentProfiles = profiles.filter((profile) => profile.agent_id === agent?.id);
  const dispatch = useAppDispatch();
  const launchProfile = agentProfiles.find((profile) => profile.is_default) ?? agentProfiles[0];
  // Test launch: the default profile, no prompt, in a new tab; Settings closes so the agent is in view.
  const testLaunch = async () => {
    if (!launchProfile) return;
    try {
      const plan = await dispatch(startAgent({ profileId: launchProfile.id, prompt: null, taskId: null, cwd: null }));
      agentLaunchToast(plan);
      dispatch(setSettingsOpen(false));
    } catch (cause) {
      notifications().toastNow({
        kind: "error",
        title: t("agents.launch.failed", { message: agentsErrorMessage(cause) }),
      });
    }
  };
  const editingProfile = agentProfiles.find((profile) => profile.id === editing) ?? null;

  const save = useCallback(
    async (input: AgentProfileInput): Promise<AgentProfile> => {
      const stored = await client.agentProfileSave(input);
      await reload();
      return stored;
    },
    [client, reload],
  );

  const addProfile = async () => {
    if (!agent || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const stored = await client.agentProfileSave({
        id: null,
        agent_id: agent.id,
        name: uniqueName(agentProfiles, "New profile"),
        model: null,
        extra_args: [],
        env: {},
        skip_permissions: false,
        is_default: agentProfiles.length === 0,
      });
      await reload();
      setEditing(stored.id);
    } catch (cause) {
      setActionError(agentsErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async (profile: AgentProfile) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const stored = await client.agentProfileSave({
        id: null,
        agent_id: profile.agent_id,
        name: uniqueName(agentProfiles, `${profile.name} copy`),
        model: profile.model,
        extra_args: [...profile.extra_args],
        env: { ...profile.env },
        skip_permissions: profile.skip_permissions,
        is_default: false,
      });
      await reload();
      setEditing(stored.id);
    } catch (cause) {
      setActionError(agentsErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const makeDefault = async (profile: AgentProfile) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await client.agentProfileSave({
        id: profile.id,
        agent_id: profile.agent_id,
        name: profile.name,
        model: profile.model,
        extra_args: [...profile.extra_args],
        env: { ...profile.env },
        skip_permissions: profile.skip_permissions,
        is_default: true,
      });
      await reload();
    } catch (cause) {
      setActionError(agentsErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const removeAgent = async () => {
    if (!deletingAgent || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await client.agentDefinitionDelete(deletingAgent.id);
      if (selected === deletingAgent.id) setSelected(null);
      setDeletingAgent(null);
      await reload();
    } catch (cause) {
      setActionError(agentsErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await client.agentProfileDelete(id);
      if (editing === id) setEditing(null);
      setConfirmDelete(null);
      await reload();
    } catch (cause) {
      setActionError(agentsErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  // Arrow keys move the selection and the focus together, so the whole list is one keyboard stop.
  const onRowKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, id: string) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const index = sorted.findIndex((candidate) => candidate.id === id);
    const next = sorted[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    select(next.id);
    list.current?.querySelector<HTMLButtonElement>(`button[data-agent-id="${next.id}"]`)?.focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-agents-page>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3">
        <h3 className="me-auto text-base font-semibold">{t("agents.title")}</h3>
        {catalog && (
          <span className="text-sm text-muted" data-agent-count>
            {t("agents.installedCount", { count: installed, total: catalog.length })}
          </span>
        )}
        <Button size="sm" icon={Icons.Plus} onClick={() => setCustomDialog({ editId: null })} data-add-custom-agent>
          {t("agents.custom.add")}
        </Button>
        <Button size="sm" icon={Icons.RotateCcw} loading={rescanning} data-rescan onClick={() => void rescan()}>
          {t("agents.rescan")}
        </Button>
      </div>

      {/* All ten stay listed with their install links; the line says what installing gets you. */}
      {catalog && installed === 0 && (
        <p data-agents-empty className="border-b border-border px-4 py-2 text-sm text-muted">
          {t("agents.noneInstalled")}
        </p>
      )}

      {(error || actionError) && (
        <div
          role="alert"
          data-agents-error
          className="flex items-start gap-2 border-b border-border bg-st-error-tint px-4 py-2 text-sm text-fg"
        >
          <Icons.TriangleAlert size={16} className="mt-0.5 shrink-0 text-st-error" aria-hidden />
          <p className="min-w-0 flex-1 break-words">{error ?? actionError}</p>
          {error && (
            <Button size="sm" icon={Icons.RotateCcw} onClick={() => void reload()}>
              {t("agents.retry")}
            </Button>
          )}
        </div>
      )}

      {loading && !catalog ? (
        <p className="p-6 text-muted" role="status">
          {t("agents.loading")}
        </p>
      ) : !catalog ? (
        <EmptyState
          className="h-full"
          icon={Icons.TriangleAlert}
          message={t("agents.loadFailed")}
          action={{ label: t("agents.retry"), icon: Icons.RotateCcw, onClick: () => void reload() }}
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <nav
            ref={list}
            aria-label={t("agents.list")}
            className="flex w-60 shrink-0 flex-col gap-1 overflow-y-auto border-e border-border px-4 py-3"
            data-agent-list
          >
            {sorted.map((entry) => (
              <div key={entry.id} className={cn("rounded-md", selected === entry.id && "bg-surface-3")}>
                <button
                  type="button"
                  data-agent-id={entry.id}
                  data-installed={entry.installed}
                  data-selected={selected === entry.id}
                  aria-current={selected === entry.id ? "true" : undefined}
                  // One tab stop for the list; arrow keys move the selection and the focus (roving tabindex).
                  tabIndex={selected === entry.id ? 0 : -1}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-md px-3 py-2 text-start",
                    "focus-visible:outline-2 focus-visible:outline-focus",
                    selected === entry.id ? "bg-surface-3" : "hover:bg-surface-2",
                  )}
                  onClick={() => select(entry.id)}
                  onKeyDown={(event) => onRowKeyDown(event, entry.id)}
                >
                  <AgentLogo agent={entry.id} name={entry.name} size={18} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1">
                      <span className="truncate font-medium text-fg">{entry.name}</span>
                      {entry.definition_error && (
                        <Icons.TriangleAlert size={12} className="shrink-0 text-st-error" aria-hidden />
                      )}
                    </span>
                    <span
                      className="block truncate text-xs text-muted"
                      title={entry.installed ? (entry.binary_path ?? undefined) : undefined}
                    >
                      {entry.installed ? (entry.version ?? t("agents.installed")) : t("agents.notFound")}
                    </span>
                    {entry.source !== "bundled" && (
                      <span className="mt-0.5 inline-block rounded-sm bg-surface-2 px-1 text-xs text-muted">
                        {sourceLabel(entry.source)}
                      </span>
                    )}
                  </span>
                </button>
                {!entry.installed && (
                  <div className="flex flex-wrap gap-3 px-3 pb-2">
                    {/* The list is one tab stop (arrow keys move it); the detail's links are in the tab order. */}
                    <AgentLink url={entry.install_url} label={t("agents.install")} name={entry.name} tabIndex={-1} />
                    <AgentLink url={entry.docs_url} label={t("agents.docs")} name={entry.name} tabIndex={-1} />
                  </div>
                )}
              </div>
            ))}
          </nav>

          <div className="min-w-0 flex-1 overflow-y-auto p-6" data-agent-detail>
            {!agent ? (
              <EmptyState icon={Icons.Bot} message={t("agents.noneInstalled")} />
            ) : (
              <div className="flex flex-col gap-3">
                <header className="flex items-start gap-3">
                  <AgentLogo agent={agent.id} name={agent.name} size={28} className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-lg font-semibold">{agent.name}</h4>
                      {agent.source !== "bundled" && (
                        <span className="rounded-sm bg-surface-2 px-1.5 text-xs text-muted">
                          {sourceLabel(agent.source)}
                        </span>
                      )}
                    </div>
                    <p className="break-all text-sm text-muted">
                      {agent.installed
                        ? [agent.version, agent.binary_path].filter(Boolean).join(" · ")
                        : t("agents.notFound")}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-3">
                      <AgentLink url={agent.install_url} label={t("agents.install")} name={agent.name} />
                      <AgentLink url={agent.docs_url} label={t("agents.docs")} name={agent.name} />
                    </div>
                  </div>
                  {agent.source === "user" && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={Icons.Pencil}
                        data-edit-agent
                        onClick={() => setCustomDialog({ editId: agent.id })}
                      >
                        {t("agents.custom.edit")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={Icons.Trash2}
                        data-delete-agent
                        onClick={() => setDeletingAgent(agent)}
                      >
                        {t("agents.custom.delete")}
                      </Button>
                    </>
                  )}
                  <Button
                    size="sm"
                    data-test-launch
                    disabled={!agent.installed || !launchProfile}
                    onClick={() => void testLaunch()}
                  >
                    {t("agents.testLaunch")}
                  </Button>
                </header>

                {agent.definition_error && (
                  <div
                    role="alert"
                    data-definition-error
                    className="flex items-start gap-2 rounded-lg bg-st-error-tint p-2 text-sm text-fg"
                  >
                    <Icons.TriangleAlert size={16} className="mt-0.5 shrink-0 text-st-error" aria-hidden />
                    <div className="min-w-0">
                      <p className="font-medium">{t("agents.definitionError")}</p>
                      <p className="break-words text-muted">{agent.definition_error}</p>
                    </div>
                  </div>
                )}

                {!agent.installed && (
                  <p className="rounded-lg bg-surface-2 p-3 text-sm">{t("agents.installHint", { name: agent.name })}</p>
                )}

                <HooksRow agent={agent} onChanged={reload} />

                <section aria-labelledby="agent-profiles-heading" className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <h5 id="agent-profiles-heading" className="me-auto text-base font-semibold">
                      {t("agents.profiles")}
                    </h5>
                    <Button size="sm" icon={Icons.Plus} loading={busy} onClick={() => void addProfile()}>
                      {t("agents.addProfile")}
                    </Button>
                  </div>

                  {agentProfiles.length === 0 ? (
                    <p className="text-sm text-muted">{t("agents.noProfiles")}</p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {agentProfiles.map((profile) => (
                        <div
                          key={profile.id}
                          data-profile-id={profile.id}
                          data-default={profile.is_default}
                          className="rounded-lg border border-border"
                        >
                          <div className="flex items-start gap-2 p-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="truncate font-medium">{profile.name}</span>
                                {profile.is_default && (
                                  <span className="rounded-sm bg-surface-3 px-1 text-xs">{t("agents.default")}</span>
                                )}
                                {profile.skip_permissions && (
                                  <span className="inline-flex items-center gap-1 rounded-sm bg-st-error-tint px-1 text-xs text-fg">
                                    <Icons.TriangleAlert size={12} className="text-st-error" aria-hidden />
                                    {t("agents.skipBadge")}
                                  </span>
                                )}
                              </div>
                              <p className="truncate text-sm text-muted">
                                {profile.model ?? "—"}
                                {profile.extra_args.length > 0 ? ` · ${profile.extra_args.join(" ")}` : ""}
                              </p>
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-1 border-t border-border p-1.5">
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={Icons.Pencil}
                              aria-label={`${t("agents.edit")}: ${profile.name}`}
                              onClick={() => {
                                setEditing(profile.id);
                                setConfirmDelete(null);
                              }}
                            >
                              {t("agents.edit")}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={Icons.Copy}
                              aria-label={`${t("agents.duplicate")}: ${profile.name}`}
                              onClick={() => void duplicate(profile)}
                            >
                              {t("agents.duplicate")}
                            </Button>
                            {!profile.is_default && (
                              <Button
                                size="sm"
                                variant="ghost"
                                icon={Icons.Check}
                                aria-label={`${t("agents.makeDefault")}: ${profile.name}`}
                                onClick={() => void makeDefault(profile)}
                              >
                                {t("agents.makeDefault")}
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={Icons.Trash2}
                              aria-label={`${t("agents.delete")}: ${profile.name}`}
                              onClick={() => setConfirmDelete(profile.id)}
                            >
                              {t("agents.delete")}
                            </Button>
                          </div>
                          {confirmDelete === profile.id && (
                            <div
                              data-delete-confirm
                              className="flex flex-wrap items-center gap-2 border-t border-border bg-surface-2 p-2"
                            >
                              <p className="min-w-0 flex-1 text-sm">
                                {t("agents.deleteConfirm", { name: profile.name })}
                              </p>
                              <Button
                                size="sm"
                                variant="danger"
                                icon={Icons.Trash2}
                                onClick={() => void remove(profile.id)}
                              >
                                {t("agents.deleteYes")}
                              </Button>
                              <Button size="sm" onClick={() => setConfirmDelete(null)}>
                                {t("agents.deleteNo")}
                              </Button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                {editingProfile && (
                  <ProfileEditor
                    key={editingProfile.id}
                    agent={agent}
                    profile={editingProfile}
                    client={client}
                    onSave={save}
                    onDone={() => setEditing(null)}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {customDialog && (
        <CustomAgentDialog
          open
          editId={customDialog.editId}
          bundledIds={bundledIds}
          onClose={() => setCustomDialog(null)}
          onSaved={() => void reload()}
        />
      )}
      {deletingAgent && (
        <DeleteAgentDialog
          agent={deletingAgent}
          profiles={profiles.filter((profile) => profile.agent_id === deletingAgent.id)}
          busy={busy}
          onConfirm={() => void removeAgent()}
          onClose={() => setDeletingAgent(null)}
        />
      )}
    </div>
  );
}

/** In-app delete confirmation for a custom definition; profiles that still use it block the delete. */
function DeleteAgentDialog({
  agent,
  profiles: agentProfiles,
  busy,
  onConfirm,
  onClose,
}: {
  agent: AgentInfo;
  profiles: AgentProfile[];
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const blocked = agentProfiles.length > 0;
  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent data-delete-agent-dialog>
        <DialogTitle>{t("agents.custom.deleteTitle", { name: agent.name })}</DialogTitle>
        <DialogDescription>{t("agents.custom.deleteBody")}</DialogDescription>
        {blocked && (
          <div className="rounded-md border border-border bg-st-error-tint p-2 text-sm" data-delete-blocked>
            <p>{t("agents.custom.deleteBlocked")}</p>
            <ul className="mt-1 list-inside list-disc">
              {agentProfiles.map((profile) => (
                <li key={profile.id}>{profile.name}</li>
              ))}
            </ul>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t("agents.custom.deleteNo")}
          </Button>
          <Button variant="danger" disabled={busy || blocked} onClick={onConfirm} data-delete-agent-confirm>
            {t("agents.custom.deleteYes")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HooksRow({ agent, onChanged }: { agent: AgentInfo; onChanged: () => Promise<void> }) {
  const client = agentsClient();
  const [review, setReview] = useState<{ action: HookAction; change: HookChange } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = agent.hooks_state === "installed" || agent.hooks_state === "outdated";
  const action: HookAction | null =
    agent.hooks_state === "installed"
      ? "remove"
      : agent.hooks_state === "outdated"
        ? "update"
        : agent.hooks_state === "none" || agent.hooks_state === "unsupported"
          ? "install"
          : null;

  const open = async () => {
    if (!action || busy) return;
    setBusy(true);
    setError(null);
    try {
      setReview({ action, change: await client.hooksPreview(agent.id) });
    } catch (cause) {
      setError(agentsErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!review || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (review.action === "remove") await client.hooksRemove(agent.id);
      else await client.hooksInstall(agent.id);
      setReview(null);
      notifications().toastNow({
        kind: "success",
        title:
          review.action === "remove"
            ? t("agents.hooks.state.none")
            : review.action === "update"
              ? t("agents.hooks.state.installed")
              : t("agents.hooks.state.installed"),
      });
      await onChanged();
    } catch (cause) {
      setError(agentsErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-hooks-state={agent.hooks_state}
      className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2"
    >
      <span className="text-sm font-medium">{t("agents.hooks")}</span>
      <span className={cn("text-sm", connected ? "text-fg" : "text-muted")}>
        {t(`agents.hooks.state.${agent.hooks_state}` as StringKey)}
      </span>
      {error && !review && (
        <span role="alert" className="text-sm text-st-error">
          {error}
        </span>
      )}
      <div className="ms-auto flex flex-wrap gap-1">
        {action === "remove" ? (
          <Button size="sm" variant="ghost" icon={Icons.Trash2} loading={busy} onClick={() => void open()}>
            {t("agents.hooks.remove")}
          </Button>
        ) : action === "update" ? (
          <Button size="sm" icon={Icons.Download} loading={busy} onClick={() => void open()}>
            {t("agents.hooks.update")}
          </Button>
        ) : (
          <Button size="sm" icon={Icons.Download} loading={busy} onClick={() => void open()}>
            {t("agents.hooks.install")}
          </Button>
        )}
      </div>
      {review && (
        <HookReviewDialog
          agent={agent}
          action={review.action}
          change={review.change}
          open
          busy={busy}
          error={error}
          onConfirm={() => void confirm()}
          onClose={() => {
            setReview(null);
            setError(null);
          }}
        />
      )}
    </div>
  );
}

export type { AgentsClient } from "./client";
