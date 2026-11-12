// One setting: label, help (the schema description), the control for its kind, the TOML key (shown on hover and focus,
// with a copy button), "Reset to default", and inline "Saved" / error text. Text and numbers save 250 ms after the
// last keystroke; switches and selects save at once.
import { cn, IconButton, Icons, Input, Select, type StringKey, strings, Switch, t } from "@tessera/ui";
import { useEffect, useId, useRef, useState } from "react";
import type { SettingField } from "./schema";
import { formatValue, parseInput } from "./schema";

export const SETTING_DEBOUNCE_MS = 250;
const SAVED_FOR_MS = 2000;

/** The friendly name from the catalog, else the key's last part in words ("cursor-style" → "Cursor style"). */
export function settingLabel(field: SettingField): string {
  const key = `setting.${field.key}`;
  if (key in strings) return t(key as StringKey);
  const words = field.name.replace(/[-.]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function rangeHint(field: SettingField): string | null {
  const { min, max } = field;
  if (min !== undefined && max !== undefined) return t("settings.range", { min, max });
  if (min !== undefined) return t("settings.rangeMin", { min });
  if (max !== undefined) return t("settings.rangeMax", { max });
  return null;
}

export interface SettingRowProps {
  field: SettingField;
  value: unknown;
  /** Saves one value; rejects with an Error whose message is shown next to the control. */
  onSave: (key: string, value: unknown) => Promise<void>;
  onCopyKey: (key: string) => void;
}

export function SettingRow({ field, value, onSave, onCopyKey }: SettingRowProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const label = settingLabel(field);
  const [draft, setDraft] = useState(formatValue(value));
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editing = useRef(false);

  // A new value from outside (the config file, a reset, another control) replaces the draft unless the user is typing.
  useEffect(() => {
    if (!editing.current) setDraft(formatValue(value));
  }, [value]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  const save = async (next: unknown) => {
    setStatus("saving");
    setError(null);
    try {
      await onSave(field.key, next);
      editing.current = false;
      setStatus("saved");
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setStatus("idle"), SAVED_FOR_MS);
    } catch (cause) {
      editing.current = false;
      setStatus("idle");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const edit = (text: string) => {
    editing.current = true;
    setDraft(text);
    setStatus("idle");
    if (timer.current) clearTimeout(timer.current);
    const parsed = parseInput(field, text);
    if ("error" in parsed) {
      setError(t(parsed.error === "invalidInteger" ? "settings.invalidInteger" : "settings.invalidNumber"));
      return;
    }
    setError(null);
    timer.current = setTimeout(() => void save(parsed.value), SETTING_DEBOUNCE_MS);
  };

  const atDefault = field.default === undefined || sameValue(value, field.default);
  const hint = rangeHint(field);
  const readOnly = field.kind === "readonly" || field.kind === "chords";

  let control: React.ReactNode;
  switch (field.kind) {
    case "boolean":
      control = (
        <Switch
          id={id}
          checked={value === true}
          aria-describedby={noteId}
          onCheckedChange={(checked) => void save(checked)}
        />
      );
      break;
    case "enum":
      control = (
        <Select
          id={id}
          value={typeof value === "string" ? value : ""}
          aria-describedby={noteId}
          invalid={error !== null}
          options={(field.options ?? []).map((option) => ({ value: option.value, label: option.value }))}
          onValueChange={(next) => void save(next)}
        />
      );
      break;
    case "integer":
    case "number":
    case "string":
    case "list":
      control = (
        <Input
          id={id}
          value={draft}
          inputMode={field.kind === "integer" ? "numeric" : field.kind === "number" ? "decimal" : "text"}
          className={field.kind === "integer" || field.kind === "number" ? "text-end tabular-nums" : undefined}
          invalid={error !== null}
          aria-describedby={noteId}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => edit(event.target.value)}
        />
      );
      break;
    default:
      control = (
        <code id={id} className="block min-h-8 rounded-md bg-surface-2 px-2 py-1.5 font-mono text-sm break-all">
          {formatValue(value) || "—"}
        </code>
      );
  }

  return (
    <div
      data-setting={field.key}
      className="group/setting flex flex-wrap items-start justify-between gap-x-8 gap-y-2 border-b border-border py-3"
    >
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
        <label id={`${id}-label`} htmlFor={id} className="text-base font-medium">
          {label}
        </label>
        {field.description && <p className="text-sm text-muted">{field.description}</p>}
        <div className="flex min-h-4 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          {hint && <span>{hint}</span>}
          {readOnly && <span>{t("settings.readOnly")}</span>}
          <code
            className={cn(
              "rounded-sm bg-surface-2 px-1 py-0.5 font-mono",
              "opacity-0 group-focus-within/setting:opacity-100 group-hover/setting:opacity-100",
            )}
          >
            {field.key}
          </code>
          <IconButton
            size="sm"
            icon={Icons.Copy}
            label={t("settings.copyKey")}
            className="opacity-0 focus:opacity-100 group-focus-within/setting:opacity-100 group-hover/setting:opacity-100"
            onClick={() => onCopyKey(field.key)}
          />
        </div>
      </div>
      <div className={cn("flex min-w-0 flex-col items-end gap-1", field.kind === "boolean" ? "" : "w-full sm:w-56")}>
        <div className="flex min-w-0 max-w-full items-center justify-end gap-1.5 self-stretch">
          <div className={cn("min-w-0", field.kind === "boolean" ? "flex justify-end" : "flex-1")}>{control}</div>
          {!readOnly && (
            <IconButton
              size="sm"
              icon={Icons.RotateCcw}
              label={t("settings.resetLabel", { name: label })}
              disabled={atDefault}
              onClick={() => {
                editing.current = false;
                void save(field.default);
              }}
            />
          )}
        </div>
        <p
          id={noteId}
          aria-live="polite"
          className={cn("self-end text-end text-xs", field.kind !== "boolean" && "min-h-4")}
        >
          {error ? (
            <span className="text-danger" role="alert">
              {error}
            </span>
          ) : status === "saved" ? (
            <span className="text-muted">{t("settings.saved")}</span>
          ) : status === "saving" ? (
            <span className="text-muted">{t("settings.saving")}</span>
          ) : null}
        </p>
      </div>
    </div>
  );
}
