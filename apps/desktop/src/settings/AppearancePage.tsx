// Settings, Appearance: the theme (one theme colours the whole app, terminal included, like VS Code's colour themes),
// an optional switch to follow the computer's light or dark setting, the terminal's colours (the app theme's by default,
// or any other theme through the picker), and the window.
import {
  ACCENT_PRESETS,
  Button,
  COLOR_THEMES,
  type ColorTheme,
  cn,
  contrastRatio,
  Icons,
  normalizeAccent,
  Switch,
  t,
} from "@tessera/ui";
import { type CSSProperties, useId } from "react";
import { AccessibilityRows } from "./AccessibilityRows";
import { PageParts } from "./PageParts";
import { SettingRow } from "./SettingRow";
import { getValue, type SettingField } from "./schema";
import { runAction } from "../actions/registry";
import { useAppDispatch } from "../store/hooks";
import { setSettingsOpen } from "../store/uiSlice";
import { selectColorTheme, useActiveTheme, useColorTheme } from "../terminal/theme";
import type { Theme } from "../themes/model";

/** The keys this page draws itself; the generic rows below skip them (and the legacy ones nothing uses any more). */
const OWN = new Set([
  "appearance.color-theme",
  "appearance.follow-system",
  "appearance.preferred-light-theme",
  "appearance.preferred-dark-theme",
  "appearance.terminal-theme",
  "appearance.accent",
  "appearance.theme",
  "appearance.theme-light",
  "appearance.theme-dark",
]);

/** A theme's tokens on an element, so everything inside it is drawn in that theme. */
function themeStyle(theme: ColorTheme): CSSProperties {
  return { ...theme.variables, "--term-bg": theme.terminal.background } as CSSProperties;
}

/** A small window in the theme's own colours: title bar with the open tab, sidebar with tasks, terminal, status bar. */
function ThemeThumbnail({ theme }: { theme: ColorTheme }) {
  const ansi = (index: number) => ({ background: theme.terminal.ansi[index] });
  return (
    <span
      aria-hidden
      data-theme={theme.kind}
      style={themeStyle(theme)}
      className="flex h-24 flex-col overflow-hidden rounded-md border border-border bg-bg"
    >
      <span className="flex h-3.5 shrink-0 items-stretch border-b border-border bg-titlebar ps-[38%]">
        <span className="relative w-12 bg-term-bg">
          <span className="absolute inset-x-0 top-0 h-0.5 bg-accent-ink" />
        </span>
      </span>
      <span className="flex min-h-0 flex-1">
        <span className="flex w-[38%] flex-col gap-1 border-e border-border bg-sidebar p-1.5">
          <span className="h-1 w-1/2 rounded-full bg-muted" />
          <span className="flex items-center gap-1 rounded-sm bg-surface-3 px-1 py-1">
            <span className="size-1 shrink-0 rounded-full bg-st-done" />
            <span className="h-1 w-3/4 rounded-full bg-accent-ink" />
          </span>
          <span className="flex items-center gap-1 px-1">
            <span className="size-1 shrink-0 rounded-full bg-st-working" />
            <span className="h-1 w-2/3 rounded-full bg-muted" />
          </span>
          <span className="flex items-center gap-1 px-1">
            <span className="size-1 shrink-0 rounded-full bg-st-needs" />
            <span className="h-1 w-1/2 rounded-full bg-muted" />
          </span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1 p-1.5" style={{ background: theme.terminal.background }}>
          <span className="flex gap-1">
            <span className="h-1 w-3 rounded-full" style={ansi(2)} />
            <span className="h-1 w-5 rounded-full" style={{ background: theme.terminal.foreground }} />
          </span>
          <span className="flex gap-1">
            <span className="h-1 w-4 rounded-full" style={ansi(4)} />
            <span className="h-1 w-3 rounded-full" style={ansi(5)} />
            <span className="h-1 w-5 rounded-full" style={ansi(6)} />
          </span>
          <span className="flex gap-1">
            <span className="h-1 w-6 rounded-full" style={ansi(1)} />
            <span className="h-1 w-2 rounded-full" style={ansi(3)} />
          </span>
          <span className="flex gap-1">
            <span className="h-1 w-2 rounded-full" style={ansi(2)} />
            <span className="h-1.5 w-1 rounded-[1px]" style={{ background: theme.terminal.cursor }} />
          </span>
        </span>
      </span>
      <span className="h-2 shrink-0 border-t border-border bg-statusbar" />
    </span>
  );
}

function ThemeCard({
  theme,
  selected,
  inUse,
  badge,
  onPick,
}: {
  theme: ColorTheme;
  selected: boolean;
  inUse: boolean;
  badge?: string;
  onPick: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a card-style radio; the group around it is the radiogroup.
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-color-theme={theme.id}
      onClick={onPick}
      className={cn(
        "flex min-w-0 cursor-default flex-col gap-2 rounded-lg border p-2 text-start transition-colors",
        "hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        selected ? "border-accent-ink bg-surface-2 ring-1 ring-accent-ink" : "border-border bg-surface",
      )}
    >
      <ThemeThumbnail theme={theme} />
      <span className="flex min-w-0 items-center gap-1.5 px-0.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{theme.name}</span>
        {badge && (
          <span className="shrink-0 rounded-sm bg-surface-3 px-1.5 text-xs text-muted" data-theme-badge>
            {badge}
          </span>
        )}
        {inUse && <Icons.Check size={14} className="shrink-0 text-accent-ink" aria-label={t("appearance.inUse")} />}
      </span>
    </button>
  );
}

/** Black or white, whichever reads better on a swatch, for its check mark. */
function markOn(fill: string): string {
  return contrastRatio("#000000", fill) >= contrastRatio("#ffffff", fill) ? "#000000" : "#ffffff";
}

function Swatch({
  fill,
  label,
  selected,
  onPick,
  ...rest
}: {
  fill: string;
  label: string;
  selected: boolean;
  onPick: () => void;
} & Record<`data-${string}`, string>) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a colour swatch radio; the group around it is the radiogroup.
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      onClick={onPick}
      className={cn(
        "flex size-8 cursor-default items-center justify-center rounded-full border border-border",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        selected && "ring-2 ring-fg ring-offset-2 ring-offset-surface",
      )}
      style={{ background: fill }}
      {...rest}
    >
      {selected && <Icons.Check size={16} aria-hidden style={{ color: markOn(fill) }} />}
    </button>
  );
}

/** The primary colour: the theme's own, a preset, or any colour. Every theme keeps its contrast with any of them. */
function PrimaryColour({
  theme,
  value,
  save,
}: {
  theme: ColorTheme;
  value: string | null;
  save: (key: string, value: unknown) => Promise<void>;
}) {
  const inputId = useId();
  const pick = (fill: string) => void save("appearance.accent", fill);
  const own = theme.spec.accent;
  return (
    <PageParts.Card title={t("appearance.accent")} lede={t("appearance.accentLede")} data-appearance-accent="">
      <div className="flex flex-col gap-4 py-4">
        <div role="radiogroup" aria-label={t("appearance.accent")} className="flex flex-wrap items-center gap-3">
          <Swatch
            fill={own}
            label={t("appearance.accentDefault", { name: theme.name })}
            selected={value === null}
            onPick={() => pick("")}
            data-accent-preset="default"
          />
          <span aria-hidden className="h-6 w-px bg-border" />
          {ACCENT_PRESETS.map((preset) => (
            <Swatch
              key={preset.id}
              fill={preset.fill}
              label={t(`appearance.accent.${preset.id}` as Parameters<typeof t>[0])}
              selected={value === preset.fill}
              onPick={() => pick(preset.fill)}
              data-accent-preset={preset.id}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor={inputId} className="text-sm font-medium">
            {t("appearance.accentCustom")}
          </label>
          <input
            id={inputId}
            type="color"
            data-accent-custom
            value={value ?? own}
            onChange={(event) => pick(event.target.value)}
            className="h-8 w-12 cursor-default rounded-md border border-border-strong bg-surface-2 p-1"
          />
          <Button size="sm" variant="ghost" disabled={value === null} onClick={() => pick("")}>
            {t("appearance.accentReset")}
          </Button>
        </div>
      </div>
    </PageParts.Card>
  );
}

function TerminalPreview({ theme }: { theme: Theme }) {
  const c = (index: number) => ({ color: theme.ansi[index] });
  return (
    <pre
      className="m-0 overflow-x-auto rounded-lg border border-border p-3 font-mono text-sm leading-relaxed"
      style={{ background: theme.background, color: theme.foreground }}
      data-terminal-theme-preview
    >
      <span style={c(2)}>~/code/shop-api</span> <span style={c(6)}>main</span> <span style={c(5)}>❯</span>{" "}
      {t("theme.sample.ls")}
      {"\n"}
      <span style={c(4)}>src/</span> <span style={c(4)}>tests/</span> <span style={c(1)}>build.zip</span>{" "}
      <span style={c(3)}>README.md</span>
      {"\n"}
      <span style={c(2)}>✓ {t("theme.sample.ok")}</span> <span style={c(1)}>✗ {t("theme.sample.fail")}</span>
    </pre>
  );
}

export function AppearancePage({
  config,
  fields,
  save,
  copyKey,
}: {
  config: unknown;
  fields: SettingField[];
  save: (key: string, value: unknown) => Promise<void>;
  copyKey: (key: string) => void;
}) {
  const dispatch = useAppDispatch();
  const current = useColorTheme();
  const terminal = useActiveTheme();
  const followId = useId();
  const matchId = useId();
  const appearance = (config as Record<string, unknown> | null)?.appearance as Record<string, unknown> | undefined;
  const follow = getValue(config, "appearance.follow-system") === true;
  const lightPick = selectColorTheme({ ...appearance, "follow-system": true }, false);
  const darkPick = selectColorTheme({ ...appearance, "follow-system": true }, true);
  const terminalName = String(getValue(config, "appearance.terminal-theme") ?? "");
  const matchApp = terminalName.trim() === "";

  const pick = (theme: ColorTheme) => {
    if (follow) void save(`appearance.preferred-${theme.kind}-theme`, theme.name);
    else void save("appearance.color-theme", theme.name);
  };
  const openPicker = () => {
    dispatch(setSettingsOpen(false));
    runAction("theme.pick");
  };
  const groups: { kind: ColorTheme["kind"]; label: string }[] = [
    { kind: "dark", label: t("appearance.darkThemes") },
    { kind: "light", label: t("appearance.lightThemes") },
  ];

  return (
    <div className="flex flex-col gap-6" data-appearance-page>
      <PageParts.Card title={t("appearance.theme")} lede={t("appearance.themeLede")} data-appearance-theme="">
        <div
          className="flex items-center justify-between gap-4 border-b border-border py-4"
          data-setting="follow-system"
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            <label htmlFor={followId} className="text-base font-medium">
              {t("appearance.followSystem")}
            </label>
            <p className="text-sm text-muted">{t("appearance.followSystemHint")}</p>
          </div>
          <Switch id={followId} checked={follow} onCheckedChange={(on) => void save("appearance.follow-system", on)} />
        </div>
        <div className="flex flex-col gap-4 py-4">
          {groups.map((group) => (
            <div key={group.kind} className="flex flex-col gap-2">
              <h5 className="m-0 text-xs font-semibold tracking-wide text-muted uppercase">{group.label}</h5>
              <div
                role="radiogroup"
                aria-label={`${t("appearance.theme")}, ${group.label}`}
                className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
              >
                {COLOR_THEMES.filter((theme) => theme.kind === group.kind).map((theme) => {
                  const chosen = follow ? (theme.kind === "dark" ? darkPick : lightPick).id === theme.id : false;
                  return (
                    <ThemeCard
                      key={theme.id}
                      theme={theme}
                      selected={follow ? chosen : current.id === theme.id}
                      inUse={current.id === theme.id}
                      badge={
                        chosen ? t(theme.kind === "dark" ? "appearance.forDark" : "appearance.forLight") : undefined
                      }
                      onPick={() => pick(theme)}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </PageParts.Card>

      <PrimaryColour theme={current} value={normalizeAccent(getValue(config, "appearance.accent"))} save={save} />

      <PageParts.Card
        title={t("appearance.terminalTheme")}
        lede={t("appearance.terminalLede")}
        data-appearance-terminal-theme=""
      >
        <div className="flex items-center justify-between gap-4 border-b border-border py-4" data-setting="match-app">
          <div className="flex min-w-0 flex-col gap-0.5">
            <label htmlFor={matchId} className="text-base font-medium">
              {t("appearance.matchApp")}
            </label>
            <p className="text-sm text-muted">
              {matchApp
                ? t("appearance.matchAppHint", { name: current.name })
                : t("appearance.terminalOwn", { name: terminal.name })}
            </p>
          </div>
          <Switch
            id={matchId}
            checked={matchApp}
            onCheckedChange={(on) => {
              if (on) void save("appearance.terminal-theme", "");
              else openPicker();
            }}
          />
        </div>
        <div className="flex flex-col gap-3 py-4">
          <TerminalPreview theme={terminal} />
          {!matchApp && (
            <Button icon={Icons.Palette} className="self-start" data-change-terminal-appearance onClick={openPicker}>
              {t("appearance.chooseTerminal")}
            </Button>
          )}
        </div>
      </PageParts.Card>

      <PageParts.Card title={t("appearance.window")}>
        {fields
          .filter((field) => !OWN.has(field.key))
          .map((field) => (
            <div key={field.key} className="border-b border-border">
              <SettingRow field={field} value={getValue(config, field.key)} onSave={save} onCopyKey={copyKey} />
            </div>
          ))}
      </PageParts.Card>

      <AccessibilityRows />
    </div>
  );
}
