// The shortcut editor (S-13, FR-67): every action with its shortcuts, search, a recorder, conflict warnings with
// Replace / Keep both, per-action Reset, Reset all, preset choice, and TOML export and import. Writes go through
// `settings_set` as `[keybindings]` entries (an empty list unbinds; writing the default is "reset").
import {
  Button,
  cn,
  type IconButtonProps,
  IconButton,
  Icons,
  Input,
  Kbd,
  getPlatform,
  Select,
  t,
  useToast,
} from "@tessera/ui";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { canonicalFor, chordFromEvent, formatChord } from "../actions/chord";
import { type BindingEntry, type Conflict, conflictsFor, detectConflicts } from "../actions/conflicts";
import { keymap, configKeyFor } from "../actions/keymap";
import { parseTomlSnippet, toToml } from "../actions/keybindingToml";
import { PRESET_NAMES, type PresetName } from "../actions/presets";
import { actionLabel, actions, type AppAction, GROUP_LABELS, shortcutsFor } from "../actions/registry";
import { configApplied } from "../store/configSlice";
import { useAppDispatch } from "../store/hooks";
import { announce } from "../store/uiSlice";
import { useSettingsClient } from "./provider";

const PRESET_KEY = "tessera.keymapPreset";

/** Reads the remembered preset (a per-viewer convenience; there is no config key for it yet). */
export function loadPreset(): PresetName {
  try {
    const stored = localStorage.getItem(PRESET_KEY);
    return PRESET_NAMES.find((name) => name === stored) ?? "default";
  } catch {
    return "default";
  }
}

function savePreset(preset: PresetName): void {
  try {
    localStorage.setItem(PRESET_KEY, preset);
  } catch {
    // Blocked storage: the preset lasts for this session.
  }
}

function allEntries(platform: ReturnType<typeof getPlatform>): BindingEntry[] {
  return actions.flatMap((action) =>
    keymap.entries(action.id, platform).map((entry) => ({ actionId: action.id, keys: entry.keys, scope: entry.scope })),
  );
}

interface Pending {
  actionId: string;
  keys: string;
  conflicts: Conflict[];
}

export function KeybindingsPage() {
  const client = useSettingsClient();
  const dispatch = useAppDispatch();
  const { toast } = useToast();
  const platform = getPlatform();
  const version = useSyncExternalStore(keymap.subscribe, keymap.version);
  const [query, setQuery] = useState("");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState("");
  const [importNotes, setImportNotes] = useState<string[]>([]);

  const labelOf = (id: string) => {
    const action = actions.find((candidate) => candidate.id === id);
    return action ? actionLabel(action) : id;
  };

  /** Writes chords for one or several actions in one patch and adopts the config the backend returns. */
  const write = async (changes: Record<string, string[]>) => {
    setError(null);
    const table: Record<string, string[]> = {};
    for (const [id, chords] of Object.entries(changes)) table[configKeyFor(id)] = chords;
    try {
      const next = await client.set({ keybindings: table });
      dispatch(configApplied(next));
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  };

  /** Makes `keys` the action's shortcut (replacing its other global chords); `extraChanges` ride in the same patch. */
  const bind = async (actionId: string, keys: string, extraChanges: Record<string, string[]> = {}) => {
    if (await write({ ...extraChanges, [actionId]: [keys] })) {
      dispatch(announce(t("keys.saved", { action: labelOf(actionId), keys })));
    }
  };

  const unbind = async (actionId: string) => {
    if (await write({ [actionId]: [] })) dispatch(announce(t("keys.unbound", { action: labelOf(actionId) })));
  };

  const reset = async (actionId: string) => {
    const defaults = keymap
      .defaults(actionId, platform)
      .filter((entry) => entry.scope === undefined)
      .map((entry) => entry.keys);
    await write({ [actionId]: defaults });
  };

  const resetAll = async () => {
    const changes: Record<string, string[]> = {};
    for (const id of Object.keys(keymap.overrides)) {
      changes[id] = keymap
        .defaults(id, platform)
        .filter((entry) => entry.scope === undefined)
        .map((entry) => entry.keys);
    }
    if (Object.keys(changes).length > 0 && (await write(changes))) dispatch(announce(t("keys.resetAllDone")));
  };

  const onRecorded = (actionId: string, keys: string) => {
    setRecordingId(null);
    const conflicts = conflictsFor(actionId, keys, allEntries(platform), platform);
    if (conflicts.length > 0) setPending({ actionId, keys, conflicts });
    else void bind(actionId, keys);
  };

  const replaceConflicts = async () => {
    if (!pending) return;
    // The other actions lose this chord; the new action takes it (and only it).
    const changes: Record<string, string[]> = {};
    for (const conflict of pending.conflicts) {
      if (conflict.kind !== "duplicate") continue;
      for (const id of conflict.actions) {
        if (id === pending.actionId) continue;
        changes[id] = keymap
          .entries(id, platform)
          .filter((entry) => entry.scope === undefined && canonicalFor(entry.keys, platform) !== conflict.keys)
          .map((entry) => entry.keys);
      }
    }
    const { actionId, keys } = pending;
    setPending(null);
    await bind(actionId, keys, changes);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` re-reads the shortcuts after a keymap change.
  const visible = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return actions.filter((action) => {
      if (words.length === 0) return true;
      const hay = [actionLabel(action), action.id, ...(action.keywords ?? []), ...shortcutsFor(action, platform)]
        .join(" ")
        .toLowerCase();
      return words.every((word) => hay.includes(word));
    });
  }, [query, platform, version]);

  const groups = useMemo(() => {
    const order = Object.keys(GROUP_LABELS) as AppAction["group"][];
    return order
      .map((group) => ({ group, items: visible.filter((action) => action.group === group) }))
      .filter((entry) => entry.items.length > 0);
  }, [visible]);

  const conflicts = detectConflicts(allEntries(platform), platform);

  const exportToml = async () => {
    const overrides: Record<string, string[]> = {};
    for (const [id, chords] of Object.entries(keymap.overrides)) overrides[configKeyFor(id)] = chords;
    if (Object.keys(overrides).length === 0) {
      toast({ title: t("keys.exportNone") });
      return;
    }
    try {
      await navigator.clipboard.writeText(toToml(overrides));
      toast({ title: t("keys.exported") });
    } catch {
      toast({ kind: "error", title: t("keys.exportNone") });
    }
  };

  const applyImport = async () => {
    const { entries, errors } = parseTomlSnippet(importText);
    const notes = errors.map((entry) => t("keys.importLine", { line: entry.line, text: entry.text.trim() }));
    const known = new Set(actions.map((action) => action.id));
    const changes: Record<string, string[]> = {};
    for (const [key, chords] of Object.entries(entries)) {
      const id = key === "palette.open" ? "view.palette" : key;
      if (known.has(id)) changes[id] = chords;
      else notes.push(t("keys.importUnknown", { id: key }));
    }
    setImportNotes(notes);
    if (Object.keys(changes).length === 0) return;
    if (await write(changes)) {
      toast({ title: t("keys.imported", { count: Object.keys(changes).length }) });
      if (notes.length === 0) {
        setImporting(false);
        setImportText("");
      }
    }
  };

  return (
    <div className="flex flex-col gap-3 pt-2" data-keybindings>
      <p className="text-sm text-muted">{t("settings.keybindingsNote")}</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative min-w-40 flex-1">
          <Icons.Search size={14} className="pointer-events-none absolute start-2 top-2.5 text-muted" aria-hidden />
          <Input
            type="search"
            aria-label={t("keys.search")}
            placeholder={t("keys.searchPlaceholder")}
            className="ps-7"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="w-48">
          <Select
            aria-label={t("keys.preset")}
            value={keymap.preset}
            disabled={platform === "mac"}
            options={PRESET_NAMES.map((name) => ({ value: name, label: t(`keys.preset.${name}`) }))}
            onValueChange={(value) => {
              savePreset(value as PresetName);
              keymap.setPreset(value as PresetName);
            }}
          />
        </div>
        <Button
          size="sm"
          icon={Icons.RotateCcw}
          disabled={Object.keys(keymap.overrides).length === 0}
          onClick={() => void resetAll()}
        >
          {t("keys.resetAll")}
        </Button>
        <Button size="sm" icon={Icons.Copy} onClick={() => void exportToml()}>
          {t("keys.export")}
        </Button>
        <Button size="sm" icon={Icons.ClipboardPaste} onClick={() => setImporting((open) => !open)}>
          {t("keys.import")}
        </Button>
      </div>
      <p className="text-xs text-muted" role="status" data-conflict-summary>
        {conflicts.length === 0 ? t("keys.conflictsOk") : t("keys.conflictsSummary", { count: conflicts.length })}
      </p>
      {importing && (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-2 p-3" data-import-panel>
          <label htmlFor="keys-import" className="text-sm font-medium">
            {t("keys.importTitle")}
          </label>
          <textarea
            id="keys-import"
            className="min-h-24 w-full rounded-md border border-border-strong bg-surface px-2 py-1.5 font-mono text-sm text-fg"
            placeholder={t("keys.importHint")}
            spellCheck={false}
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
          />
          {importNotes.map((note) => (
            <p key={note} role="alert" className="text-xs text-danger">
              {note}
            </p>
          ))}
          <div>
            <Button size="sm" variant="primary" disabled={importText.trim() === ""} onClick={() => void applyImport()}>
              {t("keys.importApply")}
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-md border border-border bg-st-error-tint px-3 py-2 text-sm" data-keys-error>
          {error}
        </p>
      )}
      <ul aria-label={t("keys.list")} className="m-0 flex list-none flex-col p-0">
        {groups.map(({ group, items }) => (
          <li key={group}>
            <h4 className="pt-3 pb-1 text-xs font-semibold text-muted">{t(GROUP_LABELS[group])}</h4>
            {items.map((action) => (
              <Row
                key={action.id}
                action={action}
                platform={platform}
                recording={recordingId === action.id}
                pending={pending?.actionId === action.id ? pending : null}
                labelOf={labelOf}
                onRecord={() => {
                  setPending(null);
                  setRecordingId(action.id);
                }}
                onCancel={() => {
                  setRecordingId(null);
                  setPending(null);
                }}
                onRecorded={(keys) => onRecorded(action.id, keys)}
                onUnbind={() => void unbind(action.id)}
                onReset={() => void reset(action.id)}
                onReplace={() => void replaceConflicts()}
                onKeepBoth={() => {
                  if (!pending) return;
                  const { actionId, keys } = pending;
                  setPending(null);
                  const others = keymap
                    .entries(actionId, platform)
                    .filter((entry) => entry.scope === undefined)
                    .map((entry) => entry.keys);
                  void write({ [actionId]: [...others.filter((k) => k !== keys), keys] }).then(
                    (ok) => ok && dispatch(announce(t("keys.saved", { action: labelOf(actionId), keys }))),
                  );
                }}
                onUseAnyway={() => {
                  if (!pending) return;
                  const { actionId, keys } = pending;
                  setPending(null);
                  void bind(actionId, keys);
                }}
              />
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface RowProps {
  action: AppAction;
  platform: ReturnType<typeof getPlatform>;
  recording: boolean;
  pending: Pending | null;
  labelOf: (id: string) => string;
  onRecord: () => void;
  onCancel: () => void;
  onRecorded: (keys: string) => void;
  onUnbind: () => void;
  onReset: () => void;
  onReplace: () => void;
  onKeepBoth: () => void;
  onUseAnyway: () => void;
}

function Row({
  action,
  platform,
  recording,
  pending,
  labelOf,
  onRecord,
  onCancel,
  onRecorded,
  onUnbind,
  onReset,
  onReplace,
  onKeepBoth,
  onUseAnyway,
}: RowProps) {
  const label = actionLabel(action);
  const entries = keymap.entries(action.id, platform);
  const custom = keymap.isCustom(action.id);
  const recorder = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!recording) return;
    keymap.setRecording(true);
    recorder.current?.focus();
    return () => keymap.setRecording(false);
  }, [recording]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      onCancel();
      return;
    }
    const spec = chordFromEvent(event.nativeEvent, platform);
    if (spec) onRecorded(formatChord(spec));
  };

  return (
    <div data-action={action.id} className="border-b border-border py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-base">{label}</span>
        <span className="flex flex-wrap items-center gap-1">
          {entries.length === 0 ? (
            <span className="text-sm text-muted">{t("keys.notSet")}</span>
          ) : (
            entries.map((entry) => (
              <span key={`${entry.scope ?? "g"}:${entry.keys}`} data-chord={entry.keys}>
                <Kbd shortcut={entry.keys} />
              </span>
            ))
          )}
        </span>
        <span
          className={cn("w-16 text-xs", custom ? "font-medium text-accent" : "text-muted")}
          data-marker={custom ? "custom" : "default"}
        >
          {custom ? t("keys.custom") : t("keys.default")}
        </span>
        <KeyButton icon={Icons.Keyboard} label={t("keys.record", { action: label })} onClick={onRecord} />
        <KeyButton
          icon={Icons.Eraser}
          label={t("keys.unbind", { action: label })}
          disabled={entries.every((entry) => entry.scope !== undefined)}
          onClick={onUnbind}
        />
        <KeyButton
          icon={Icons.RotateCcw}
          label={t("keys.reset", { action: label })}
          disabled={!custom}
          onClick={onReset}
        />
      </div>
      {recording && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            ref={recorder}
            readOnly
            aria-label={t("keys.pressNew")}
            value={t("keys.pressNew")}
            data-recorder
            className="h-9 min-w-48 rounded-md border-2 border-accent bg-surface-2 px-3 text-base text-fg focus:outline-none"
            onKeyDown={onKeyDown}
            onBlur={onCancel}
          />
          <span className="text-sm text-muted">{t("keys.pressNewHint")}</span>
        </div>
      )}
      {pending && (
        <div
          role="alert"
          data-conflict
          className="mt-2 flex flex-col gap-2 rounded-md border border-border bg-st-needs-tint px-3 py-2 text-sm"
        >
          {pending.conflicts.map((conflict) => (
            <p key={`${conflict.kind}:${conflict.keys}`}>
              {conflict.kind === "duplicate"
                ? t("keys.conflict.duplicate", {
                    keys: conflict.keys,
                    others: conflict.actions
                      .filter((id) => id !== pending.actionId)
                      .map(labelOf)
                      .join(", "),
                  })
                : conflict.kind === "reserved"
                  ? t("keys.conflict.reserved", { keys: conflict.keys })
                  : t("keys.conflict.noModifier", { keys: conflict.keys })}
            </p>
          ))}
          <div className="flex flex-wrap gap-2">
            {pending.conflicts.some((conflict) => conflict.kind === "duplicate") ? (
              <>
                <Button size="sm" variant="primary" onClick={onReplace}>
                  {t("keys.replace")}
                </Button>
                <Button size="sm" onClick={onKeepBoth}>
                  {t("keys.keepBoth")}
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={onUseAnyway}>
                {t("keys.useAnyway")}
              </Button>
            )}
            <Button size="sm" onClick={onCancel}>
              {t("keys.cancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function KeyButton(props: Pick<IconButtonProps, "icon" | "label" | "disabled" | "onClick">) {
  return <IconButton size="sm" {...props} />;
}
