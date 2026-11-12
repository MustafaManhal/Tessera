// First-run onboarding (S-14): four skippable steps over the shell — welcome, look (theme/font +
// terminal-config importers), agents (detection + status hooks), first project. `onboarding_done` in kv
// gates it; Skip and Finish both call onboardingComplete. Esc never skips — there is no key handler.

import { useCallback, useEffect, useState } from "react";
import { Button, Dialog, DialogContent, DialogFooter, DialogTitle, Icons, Input, Select, t } from "@tessera/ui";
import { useAppDispatch } from "../store/hooks";
import { agentsClient } from "../agents/service";
import type { AgentInfo } from "../agents/types";
import { useSettingsClient } from "../settings/provider";
import { folderPicker } from "../native/dialog";
import { addProject } from "../projects/thunks";
import { onboarding } from "./client";
import type { ImportPreview, ImportSource } from "./types";

const STEPS = ["welcome", "look", "agents", "project"] as const;
type Step = (typeof STEPS)[number];

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause && "message" in cause) return String(cause.message);
  return String(cause);
}

export function Onboarding({ onDone }: { onDone?: () => void }) {
  const dispatch = useAppDispatch();
  const settings = useSettingsClient();
  const [step, setStep] = useState<Step>("welcome");
  const [sources, setSources] = useState<ImportSource[]>([]);
  const [preview, setPreview] = useState<{ source: ImportSource; data: ImportPreview } | null>(null);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [hooks, setHooks] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cloneUrl, setCloneUrl] = useState("");
  const [fontFamily, setFontFamily] = useState("");
  const [fontSize, setFontSize] = useState("");
  const [theme, setTheme] = useState("system");

  const index = STEPS.indexOf(step);
  const last = index === STEPS.length - 1;

  const finish = useCallback(async () => {
    setBusy("finish");
    try {
      await onboarding().onboardingComplete();
      onDone?.();
    } finally {
      setBusy(null);
    }
  }, [onDone]);

  // Load what each step needs, lazily.
  useEffect(() => {
    if (step === "look" && sources.length === 0) {
      void onboarding()
        .importSources()
        .then(setSources)
        .catch(() => setSources([]));
      void settings
        .get()
        .then((config) => {
          const font = (config.font ?? {}) as Record<string, unknown>;
          const appearance = (config.appearance ?? {}) as Record<string, unknown>;
          setFontFamily(String(font.family ?? ""));
          setFontSize(String(font.size ?? ""));
          setTheme(String(appearance.theme ?? "system"));
        })
        .catch(() => {});
    }
    if (step === "agents" && agents === null) {
      void agentsClient()
        .agentCatalog(false)
        .then(async (list) => {
          setAgents(list);
          const states: Record<string, boolean> = {};
          for (const agent of list) {
            try {
              const change = await agentsClient().hooksPreview(agent.id);
              states[agent.id] = change.state === "installed" || change.state === "outdated";
            } catch {
              states[agent.id] = false;
            }
          }
          setHooks(states);
        })
        .catch(() => setAgents([]));
    }
  }, [step, sources.length, agents, settings]);

  const saveLook = async () => {
    setBusy("look");
    setError(null);
    try {
      const patch: Record<string, unknown> = {};
      if (fontFamily.trim()) patch.font = { ...(patch.font as object), family: fontFamily.trim() };
      const size = Number(fontSize);
      if (fontSize.trim() && Number.isFinite(size)) patch.font = { ...(patch.font as object), size };
      if (theme !== "system") patch.appearance = { theme };
      if (Object.keys(patch).length > 0) await settings.set(patch as never);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const showImport = async (source: ImportSource) => {
    setBusy(`import:${source.id}`);
    setError(null);
    try {
      const data = await onboarding().importPreview(source.id);
      setPreview({ source, data });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const confirmImport = async () => {
    if (!preview) return;
    setBusy("apply");
    setError(null);
    try {
      await onboarding().importApply(preview.source.id);
      setPreview(null);
      setSources((list) => list.filter((s) => s.id !== preview.source.id));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const toggleHooks = async (agent: AgentInfo, on: boolean) => {
    setBusy(`hooks:${agent.id}`);
    setError(null);
    try {
      if (on) await agentsClient().hooksInstall(agent.id);
      else await agentsClient().hooksRemove(agent.id);
      setHooks((current) => ({ ...current, [agent.id]: on }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const pickFolder = async () => {
    setBusy("project");
    setError(null);
    try {
      const picked = await folderPicker().pickFolder();
      if (picked) {
        await dispatch(addProject({ path: picked }));
        await finish();
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const cloneRepo = async () => {
    const url = cloneUrl.trim();
    if (!url) return;
    setBusy("clone");
    setError(null);
    try {
      await dispatch(addProject({ clone_url: url }));
      await finish();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 p-4" data-onboarding>
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-xl border border-border bg-surface p-6 shadow-dialog">
        <div className="flex items-center justify-between">
          <div className="flex gap-1.5" aria-hidden>
            {STEPS.map((s, i) => (
              <span key={s} className={`h-1.5 w-6 rounded-full ${i <= index ? "bg-accent" : "bg-surface-3"}`} />
            ))}
          </div>
          <Button size="sm" variant="ghost" onClick={() => void finish()} disabled={busy === "finish"}>
            {t("onboarding.skip")}
          </Button>
        </div>

        {step === "welcome" && (
          <div className="space-y-3">
            <h1 className="text-xl font-semibold">{t("onboarding.welcomeTitle")}</h1>
            <p className="text-sm text-muted">{t("onboarding.welcomeLine")}</p>
          </div>
        )}

        {step === "look" && (
          <div className="space-y-3">
            <h2 className="text-lg font-medium">{t("onboarding.lookTitle")}</h2>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1 text-xs text-muted">
                {t("onboarding.theme")}
                <Select
                  aria-label={t("onboarding.theme")}
                  value={theme}
                  onValueChange={setTheme}
                  options={[
                    { value: "system", label: t("onboarding.themeSystem") },
                    { value: "light", label: t("onboarding.themeLight") },
                    { value: "dark", label: t("onboarding.themeDark") },
                  ]}
                />
              </div>
              <div className="space-y-1 text-xs text-muted">
                {t("onboarding.fontSize")}
                <Input
                  value={fontSize}
                  onChange={(e) => setFontSize(e.target.value)}
                  inputMode="decimal"
                  aria-label={t("onboarding.fontSize")}
                />
              </div>
              <div className="col-span-2 space-y-1 text-xs text-muted">
                {t("onboarding.fontFamily")}
                <Input
                  value={fontFamily}
                  onChange={(e) => setFontFamily(e.target.value)}
                  aria-label={t("onboarding.fontFamily")}
                />
              </div>
            </div>
            <pre
              className="rounded-md border border-border bg-surface-2 p-3 font-mono text-sm"
              style={{ fontFamily: fontFamily || undefined, fontSize: fontSize ? `${fontSize}px` : undefined }}
              data-look-preview
            >
              {"$ tessera run --agent claude\n✓ ready — ask anything"}
            </pre>
            <div className="flex flex-wrap gap-2">
              {sources
                .filter((s) => s.available)
                .map((s) => (
                  <Button
                    key={s.id}
                    size="sm"
                    variant="secondary"
                    onClick={() => void showImport(s)}
                    loading={busy === `import:${s.id}`}
                  >
                    {t("onboarding.importFrom", { name: s.name })}
                  </Button>
                ))}
            </div>
            {error && (
              <p role="alert" className="rounded-md border border-border bg-st-error-tint px-2 py-1 text-xs">
                {error}
              </p>
            )}
          </div>
        )}

        {step === "agents" && (
          <div className="space-y-3">
            <h2 className="text-lg font-medium">{t("onboarding.agentsTitle")}</h2>
            <p className="text-xs text-muted">{t("onboarding.agentsLine")}</p>
            {agents === null ? (
              <p className="text-sm text-muted" role="status">
                {t("onboarding.agentsLoading")}
              </p>
            ) : agents.length === 0 ? (
              <p className="text-sm text-muted">{t("onboarding.agentsNone")}</p>
            ) : (
              <ul className="space-y-2">
                {agents.map((agent) => {
                  const detected = Boolean(agent.detected_at) || Boolean(agent.version);
                  return (
                    <li
                      key={agent.id}
                      className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
                      data-agent-row={agent.id}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{agent.name}</p>
                        <p className="truncate text-xs text-muted">
                          {detected ? (agent.version ?? t("onboarding.agentDetected")) : t("onboarding.agentMissing")}
                        </p>
                      </div>
                      {!detected && agent.install_url && (
                        <a
                          href={agent.install_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-accent hover:underline"
                        >
                          {t("onboarding.install")}
                        </a>
                      )}
                      <label className="flex items-center gap-1.5 text-xs text-muted">
                        <input
                          type="checkbox"
                          checked={Boolean(hooks[agent.id])}
                          disabled={busy === `hooks:${agent.id}` || !detected}
                          onChange={(e) => void toggleHooks(agent, e.target.checked)}
                          aria-label={t("onboarding.hooksFor", { name: agent.name })}
                        />
                        {t("onboarding.hooks")}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-xs text-muted">{t("onboarding.hooksExplain")}</p>
            {error && (
              <p role="alert" className="rounded-md border border-border bg-st-error-tint px-2 py-1 text-xs">
                {error}
              </p>
            )}
          </div>
        )}

        {step === "project" && (
          <div className="space-y-3">
            <h2 className="text-lg font-medium">{t("onboarding.projectTitle")}</h2>
            <p className="text-xs text-muted">{t("onboarding.projectLine")}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void pickFolder()} loading={busy === "project"}>
                {t("onboarding.chooseFolder")}
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={cloneUrl}
                onChange={(e) => setCloneUrl(e.target.value)}
                placeholder={t("onboarding.clonePlaceholder")}
                aria-label={t("onboarding.cloneUrl")}
                className="flex-1"
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void cloneRepo()}
                loading={busy === "clone"}
                disabled={!cloneUrl.trim()}
              >
                {t("onboarding.clone")}
              </Button>
            </div>
            {error && (
              <p role="alert" className="rounded-md border border-border bg-st-error-tint px-2 py-1 text-xs">
                {error}
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          {!last && step !== "welcome" && (
            <Button
              size="sm"
              onClick={() =>
                void saveLook().then(() => setStep(STEPS[Math.min(index + 1, STEPS.length - 1)] ?? "project"))
              }
              loading={busy === "look" && step === "look"}
            >
              {t("onboarding.next")}
            </Button>
          )}
          {step === "welcome" && (
            <Button size="sm" onClick={() => setStep("look")}>
              {t("onboarding.getStarted")}
            </Button>
          )}
          {last && (
            <Button size="sm" onClick={() => void finish()} loading={busy === "finish"}>
              {t("onboarding.finish")}
            </Button>
          )}
        </div>
      </div>

      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent>
          <DialogTitle>{t("onboarding.importPreview", { name: preview?.source.name ?? "" })}</DialogTitle>
          {preview && (
            <div className="space-y-2 text-sm">
              {preview.data.applied.length > 0 && (
                <ul className="space-y-1" data-import-applied>
                  {preview.data.applied.map((item) => (
                    <li key={item.key} className="flex items-center gap-2">
                      <Icons.Check className="size-3.5 text-st-done" aria-hidden />
                      {item.label}
                    </li>
                  ))}
                </ul>
              )}
              {preview.data.failed.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted">{t("onboarding.couldNotImport")}</p>
                  <ul className="mt-1 space-y-1" data-import-failed>
                    {preview.data.failed.map((miss) => (
                      <li key={miss.item} className="text-xs text-muted">
                        {miss.item}: {miss.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPreview(null)}>
              {t("onboarding.cancel")}
            </Button>
            <Button
              onClick={() => void confirmImport()}
              loading={busy === "apply"}
              disabled={!preview || preview.data.applied.length === 0}
            >
              {t("onboarding.importConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
