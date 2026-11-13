// The settings screen (S-11): a large dialog with the section list on the left and the generated form on the right.
// The form comes from the config JSON Schema (schema.ts), so a new setting in Rust appears here without UI code.
// Changes apply live through `settings_set`; hand edits of config.toml arrive as `config:changed`; `config:error` shows a
// banner and the last good values stay.
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  EmptyState,
  IconButton,
  Icons,
  Input,
  type LucideIcon,
  type StringKey,
  t,
  useToast,
} from "@tessera/ui";
import { useEffect, useMemo, useState } from "react";
import { openPathExternal, revealPath } from "../terminal/open";
import { keymap } from "../actions/keymap";
import { runAction } from "../actions/registry";
import { configApplied, dismissDiagnostic } from "../store/configSlice";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { setSettingsOpen, setSettingsPage } from "../store/uiSlice";
import type { SettingsClient } from "./client";
import { configSchema, useSettingsClient } from "./provider";
import { flattenSchema, getValue, matchesQuery, patchFor, SECTION_GROUPS, type SettingField } from "./schema";
import { AccessibilityRows } from "./AccessibilityRows";
import { AppLocalRows } from "./AppLocalRows";
import { PrivacyRows } from "./PrivacyRows";
import { CliRow } from "./CliRow";
import { McpCommand } from "./McpCommand";
import { IntegrationsManager } from "../integrations/mcp/ManagerPage";
import { GithubRow } from "../github/GithubRow";
import { AutomationsPage } from "../automations/AutomationsPage";
import { UpdatesPage } from "../updates/UpdatesPage";
import { LinearRow } from "../issues/LinearRow";
import { KeybindingsPage } from "./KeybindingsPage";
import { SettingRow, settingLabel } from "./SettingRow";
import { AgentsPage } from "../agents/AgentsPage";
import { SshHostsPage } from "../ssh/SshHostsPage";
import { AccountPage } from "../sync/AccountPage";

type PageId =
  | (typeof SECTION_GROUPS)[number]["id"]
  | "keybindings"
  | "agents"
  | "ssh"
  | "account"
  | "integrations"
  | "automations";

const PAGES: { id: PageId; stub: boolean }[] = [
  { id: "general", stub: false },
  { id: "appearance", stub: false },
  { id: "font", stub: false },
  { id: "terminal", stub: false },
  { id: "notifications", stub: false },
  { id: "keybindings", stub: false },
  { id: "agents", stub: false },
  { id: "ssh", stub: false },
  { id: "account", stub: false },
  { id: "integrations", stub: false },
  { id: "automations", stub: false },
  { id: "updates", stub: false },
  { id: "advanced", stub: false },
];

const FIELDS = flattenSchema(configSchema);

function pageFrom(value: string | null): PageId {
  return PAGES.some((entry) => entry.id === value) ? (value as PageId) : "general";
}

function fieldsOf(page: PageId): SettingField[] {
  if (page === "keybindings") return FIELDS.filter((field) => field.section === "keybindings");
  const group = SECTION_GROUPS.find((candidate) => candidate.id === page);
  if (!group) return [];
  return FIELDS.filter((field) => group.sections.includes(field.section));
}

const PAGE_ICON: Record<PageId, LucideIcon> = {
  general: Icons.SlidersHorizontal,
  appearance: Icons.Palette,
  font: Icons.Type,
  terminal: Icons.Terminal,
  notifications: Icons.Bell,
  keybindings: Icons.Keyboard,
  agents: Icons.Bot,
  ssh: Icons.Server,
  account: Icons.Cloud,
  integrations: Icons.Plug,
  automations: Icons.Timer,
  updates: Icons.Download,
  advanced: Icons.Wrench,
};

const pageLabel = (page: PageId) => t(`settings.section.${page}` as StringKey);

function PageIcon({ page }: { page: PageId }) {
  const Icon = PAGE_ICON[page] ?? Icons.Settings;
  return <Icon size={16} aria-hidden className="shrink-0" />;
}

export function SettingsDialog() {
  const open = useAppSelector((state) => state.ui.settingsOpen);
  const dispatch = useAppDispatch();
  return (
    <Dialog open={open} onOpenChange={(next) => dispatch(setSettingsOpen(next))}>
      {open && (
        <DialogContent
          aria-describedby="settings-description"
          // While the shortcut recorder listens, Esc belongs to it (it cancels the recording, not the screen).
          onEscapeKeyDown={(event) => {
            if (keymap.recording) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            // The search box first, not the section list.
            event.preventDefault();
            document.getElementById("settings-search")?.focus();
          }}
          className="h-[min(52rem,calc(100vh-3rem))] w-[min(76rem,calc(100vw-3rem))] min-h-[24rem] min-w-[40rem] max-w-[calc(100vw-1rem)] resize gap-0 overflow-hidden p-0"
        >
          <DialogTitle className="sr-only">{t("settings.title")}</DialogTitle>
          <DialogDescription id="settings-description" className="sr-only">
            {t("settings.searchPlaceholder")}
          </DialogDescription>
          <SettingsBody />
        </DialogContent>
      )}
    </Dialog>
  );
}

function SettingsBody() {
  const client = useSettingsClient();
  const dispatch = useAppDispatch();
  const config = useAppSelector((state) => state.config.values);
  const diagnostic = useAppSelector((state) => state.config.diagnostic);
  const { toast } = useToast();
  // A command (e.g. the palette's "Agents and profiles…") can ask for a section before the dialog mounts.
  const requested = useAppSelector((state) => state.ui.settingsPage);
  const [page, setPage] = useState<PageId>(() => pageFrom(requested));
  const [query, setQuery] = useState("");
  const [dataDir, setDataDir] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (requested) setPage(pageFrom(requested));
  }, [requested]);

  useEffect(() => {
    let cancelled = false;
    void client.info().then((info) => !cancelled && setDataDir(info?.dataDir ?? null));
    return () => {
      cancelled = true;
    };
  }, [client]);

  const load = () => {
    setLoadError(false);
    client.get().then(
      (values) => dispatch(configApplied(values)),
      () => setLoadError(true),
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once when the screen opens without values.
  useEffect(() => {
    if (!config) load();
  }, []);

  const save = async (key: string, value: unknown) => {
    const next = await client.set(patchFor(key, value));
    dispatch(configApplied(next));
  };

  const copyKey = (key: string) => {
    void navigator.clipboard
      .writeText(key)
      .then(() => toast({ title: t("settings.keyCopied", { key }) }))
      .catch(() => {});
  };

  const searching = query.trim() !== "";
  const visible = useMemo(() => {
    if (!searching) return fieldsOf(page);
    return FIELDS.filter((field) => matchesQuery(field, settingLabel(field), query));
  }, [page, query, searching]);

  const sep = dataDir?.includes("\\") ? "\\" : "/";
  const configPath = dataDir ? `${dataDir.replace(/[\\/]+$/, "")}${sep}config.toml` : null;
  const current = PAGES.find((candidate) => candidate.id === page);

  return (
    <div className="flex min-h-0 flex-1">
      <nav
        aria-label={t("settings.nav")}
        className="flex w-56 shrink-0 flex-col gap-1 overflow-y-auto border-e border-border bg-surface-2/40 p-4"
      >
        <p className="px-2 pb-3 text-xl font-semibold" aria-hidden>
          {t("settings.title")}
        </p>
        {PAGES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-current={!searching && page === entry.id ? "page" : undefined}
            className="h-9 cursor-default rounded-lg px-2.5 text-start text-[0.9375rem] text-muted hover:bg-surface-2 hover:text-fg aria-[current=page]:bg-surface-3 aria-[current=page]:font-medium aria-[current=page]:text-fg"
            onClick={() => {
              setPage(entry.id);
              dispatch(setSettingsPage(entry.id));
              setQuery("");
            }}
          >
            <span className="flex items-center gap-2.5">
              <PageIcon page={entry.id} />
              {pageLabel(entry.id)}
            </span>
          </button>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-4 pe-14">
          <div className="relative min-w-40 flex-1">
            <Icons.Search size={16} className="pointer-events-none absolute start-2.5 top-2.5 text-muted" aria-hidden />
            <Input
              id="settings-search"
              type="search"
              aria-label={t("settings.search")}
              placeholder={t("settings.searchPlaceholder")}
              className="ps-9"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <Button
            size="sm"
            icon={Icons.FileText}
            disabled={!configPath}
            onClick={() => configPath && void openPathExternal(configPath)}
          >
            {t("settings.openConfig")}
          </Button>
          <Button
            size="sm"
            icon={Icons.FolderOpen}
            disabled={!configPath}
            onClick={() => configPath && void revealPath(configPath)}
          >
            {t("settings.revealConfig")}
          </Button>
        </div>
        {diagnostic && (
          <div
            role="alert"
            data-config-error
            className="flex items-start gap-2 border-b border-border bg-st-error-tint px-3 py-2 text-sm"
          >
            <Icons.TriangleAlert size={16} className="mt-0.5 shrink-0 text-st-error" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="font-medium">{t("settings.errorBanner")}</p>
              <p className="break-words">{diagnostic.message}</p>
              <p className="text-muted">
                {[
                  diagnostic.line !== null && diagnostic.key
                    ? t("settings.errorWhere", { line: diagnostic.line, key: diagnostic.key })
                    : diagnostic.line !== null
                      ? t("settings.errorLine", { line: diagnostic.line })
                      : diagnostic.key
                        ? t("settings.errorKey", { key: diagnostic.key })
                        : null,
                  diagnostic.suggestion ? t("settings.didYouMean", { suggestion: diagnostic.suggestion }) : null,
                ]
                  .filter(Boolean)
                  .join(". ")}
              </p>
            </div>
            <IconButton
              size="sm"
              icon={Icons.X}
              label={t("settings.dismiss")}
              onClick={() => dispatch(dismissDiagnostic())}
            />
          </div>
        )}
        {!searching && page === "integrations" ? (
          <IntegrationsManager />
        ) : !searching && page === "account" ? (
          <AccountPage />
        ) : !searching && page === "ssh" ? (
          <SshHostsPage />
        ) : !searching && page === "agents" ? (
          <AgentsPage />
        ) : !searching && page === "automations" ? (
          <AutomationsPage />
        ) : !searching && page === "updates" ? (
          <UpdatesPage />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-8" data-settings-form>
            {!config ? (
              loadError ? (
                <EmptyState
                  className="h-full"
                  icon={Icons.TriangleAlert}
                  message={t("settings.loadFailed")}
                  action={{ label: t("settings.retry"), icon: Icons.RotateCcw, onClick: load }}
                />
              ) : (
                <p className="py-6 text-muted" role="status">
                  {t("settings.loading")}
                </p>
              )
            ) : !searching && current?.stub ? (
              <EmptyState className="h-full" icon={Icons.Clock} message={t("settings.stub")} />
            ) : (
              <>
                <h3 className="pt-6 pb-1 text-2xl font-semibold tracking-tight">
                  {searching ? t("settings.search") : pageLabel(page)}
                </h3>
                {!searching && page === "general" && (
                  <>
                    <CliRow />
                    <GithubRow />
                    <LinearRow />
                    <AppLocalRows />
                  </>
                )}
                {!searching && page === "advanced" && (
                  <>
                    <PrivacyRows />
                    <h4 className="pt-3 text-sm font-medium">{t("settings.apiSection")}</h4>
                  </>
                )}
                {!searching && page === "appearance" && (
                  <div className="pt-2">
                    <Button
                      size="sm"
                      icon={Icons.Palette}
                      onClick={() => {
                        dispatch(setSettingsOpen(false));
                        runAction("theme.pick");
                      }}
                    >
                      {t("settings.chooseTheme")}
                    </Button>
                    <AccessibilityRows />
                  </div>
                )}
                {!searching && page === "keybindings" ? (
                  <KeybindingsPage />
                ) : visible.length === 0 ? (
                  <p className="py-6 text-muted">{t("settings.noResults", { query })}</p>
                ) : (
                  visible.map((field) => (
                    <div key={field.key}>
                      <SettingRow field={field} value={getValue(config, field.key)} onSave={save} onCopyKey={copyKey} />
                      {field.key === "api.mcp-server" && <McpCommand />}
                    </div>
                  ))
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export type { SettingsClient };
