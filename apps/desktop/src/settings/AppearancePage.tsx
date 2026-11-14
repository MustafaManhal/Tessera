// Settings, Appearance (M13.4): one page with three clear parts. The app theme (the whole app: light, dark or follow the
// computer), the terminal theme (a big preview and one obvious button that opens the theme picker), and the window.
import { cn, Icons, t } from "@tessera/ui";
import { AccessibilityRows } from "./AccessibilityRows";
import { PageParts } from "./PageParts";
import { SettingRow } from "./SettingRow";
import { getValue, type SettingField } from "./schema";
import { runAction } from "../actions/registry";
import { useAppDispatch } from "../store/hooks";
import { setSettingsOpen } from "../store/uiSlice";
import { useActiveTheme } from "../terminal/theme";

type Mode = "system" | "light" | "dark";

const MODES: { id: Mode; label: Parameters<typeof t>[0]; hint: Parameters<typeof t>[0] }[] = [
  { id: "system", label: "appearance.mode.system", hint: "appearance.mode.systemHint" },
  { id: "light", label: "appearance.mode.light", hint: "appearance.mode.lightHint" },
  { id: "dark", label: "appearance.mode.dark", hint: "appearance.mode.darkHint" },
];

/** A tiny window drawn with the real tokens of the theme it shows (`data-theme` re-derives them for the subtree). */
function ModePreview({ mode }: { mode: "light" | "dark" }) {
  return (
    <span
      data-theme={mode}
      aria-hidden
      className="flex h-16 min-w-0 flex-1 gap-1 overflow-hidden bg-bg p-1.5"
      style={{ background: "var(--bg)" }}
    >
      <span className="flex w-1/3 flex-col gap-1 rounded-sm bg-surface p-1">
        <span className="h-1 rounded-full bg-border-strong" />
        <span className="h-1 w-2/3 rounded-full bg-border" />
        <span className="h-1 w-3/4 rounded-full bg-border" />
      </span>
      <span className="flex flex-1 flex-col gap-1 rounded-sm bg-surface-2 p-1">
        <span className="h-1 w-1/2 rounded-full bg-accent" />
        <span className="h-1 rounded-full bg-border" />
      </span>
    </span>
  );
}

function AppThemeChoice({ mode, selected, onPick }: { mode: Mode; selected: boolean; onPick: () => void }) {
  const entry = MODES.find((candidate) => candidate.id === mode);
  if (!entry) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a card-style radio; the group below is the radiogroup.
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-app-theme={mode}
      onClick={onPick}
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-lg border bg-surface p-3 text-start transition-colors",
        "hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus",
        selected ? "border-accent ring-2 ring-accent" : "border-border",
      )}
    >
      <span className="flex overflow-hidden rounded-md border border-border">
        {mode === "system" ? (
          <>
            <ModePreview mode="light" />
            <ModePreview mode="dark" />
          </>
        ) : (
          <ModePreview mode={mode} />
        )}
      </span>
      <span className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{t(entry.label)}</span>
        {selected && <Icons.Check size={16} aria-hidden />}
      </span>
      <span className="text-xs text-muted">{t(entry.hint)}</span>
    </button>
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
  const active = useActiveTheme();
  const raw = getValue(config, "appearance.theme");
  const mode: Mode = raw === "light" || raw === "dark" ? raw : "system";
  const light = String(getValue(config, "appearance.theme-light") ?? "");
  const dark = String(getValue(config, "appearance.theme-dark") ?? "");
  const own = new Set(["appearance.theme", "appearance.theme-light", "appearance.theme-dark"]);
  const c = (index: number) => ({ color: active?.ansi[index] });
  const openPicker = () => {
    dispatch(setSettingsOpen(false));
    runAction("theme.pick");
  };

  return (
    <div className="flex flex-col gap-6" data-appearance-page>
      <PageParts.Card title={t("appearance.appTheme")} lede={t("appearance.appThemeLede")} data-appearance-app-theme="">
        <div
          role="radiogroup"
          aria-label={t("appearance.appTheme")}
          className="grid grid-cols-1 gap-3 py-4 sm:grid-cols-3"
        >
          {MODES.map((entry) => (
            <AppThemeChoice
              key={entry.id}
              mode={entry.id}
              selected={mode === entry.id}
              onPick={() => void save("appearance.theme", entry.id)}
            />
          ))}
        </div>
      </PageParts.Card>

      <PageParts.Card
        title={t("appearance.terminalTheme")}
        lede={t("appearance.terminalLede")}
        data-appearance-terminal-theme=""
      >
        <div className="flex flex-col gap-4 py-4">
          {active && (
            <div className="flex flex-col gap-2">
              <p className="m-0 text-sm font-medium">{t("appearance.usedNow", { name: active.name })}</p>
              <pre
                className="m-0 overflow-x-auto rounded-lg border border-border p-3 font-mono text-sm leading-relaxed"
                style={{ background: active.background, color: active.foreground }}
                data-terminal-theme-preview
              >
                <span style={c(2)}>~/code/shop-api</span> <span style={c(6)}>main</span> <span style={c(5)}>❯</span>{" "}
                {t("theme.sample.ls")}
                {"\n"}
                <span style={c(4)}>src/</span> <span style={c(4)}>tests/</span> <span style={c(1)}>build.zip</span>{" "}
                <span style={c(3)}>README.md</span>
              </pre>
            </div>
          )}
          <p className="m-0 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
            <span>{t("appearance.usedLight", { name: light })}</span>
            <span>{t("appearance.usedDark", { name: dark })}</span>
          </p>
          <button
            type="button"
            data-change-terminal-appearance
            onClick={openPicker}
            className="inline-flex h-12 w-full cursor-default items-center justify-center gap-3 rounded-lg bg-accent px-6 text-base font-semibold text-accent-fg hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <Icons.Palette size={20} aria-hidden />
            {t("appearance.changeTerminal")}
          </button>
        </div>
      </PageParts.Card>

      <PageParts.Card title={t("appearance.window")}>
        {fields
          .filter((field) => !own.has(field.key))
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
