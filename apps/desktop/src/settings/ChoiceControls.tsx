// Controls for settings that are picked from a list: a drop-down for single values, toggle chips for the font features,
// a theme list loaded from the bundled collection, and a "do not disturb" duration.
import { cn, Select, t } from "@tessera/ui";
import { useEffect, useState } from "react";
import {
  type Choice,
  type ChoiceSet,
  DND_OPTIONS,
  FONT_FEATURES,
  parseChoice,
  themeNames,
  withCurrent,
} from "./choices";

interface Common {
  id: string;
  describedBy: string;
  invalid: boolean;
}

export function ChoiceSelect({
  set,
  value,
  onPick,
  id,
  describedBy,
  invalid,
}: Common & { set: ChoiceSet; value: unknown; onPick: (next: string | number) => void }) {
  return (
    <Select
      id={id}
      value={value === undefined || value === null ? "" : String(value)}
      aria-describedby={describedBy}
      invalid={invalid}
      options={withCurrent(set, value)}
      onValueChange={(next) => onPick(parseChoice(set, next))}
    />
  );
}

export function ThemeSelect({
  appearance,
  value,
  onPick,
  id,
  describedBy,
  invalid,
}: Common & { appearance: "dark" | "light"; value: unknown; onPick: (next: string) => void }) {
  const [names, setNames] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    void themeNames(appearance).then((list) => live && setNames(list));
    return () => {
      live = false;
    };
  }, [appearance]);
  const builtin = appearance === "dark" ? "Tessera Night" : "Tessera Light";
  const choices: Choice[] = [
    { value: builtin, label: `${builtin} (built in)` },
    ...(names ?? []).filter((name) => name !== builtin).map((name) => ({ value: name, label: name })),
  ];
  const set: ChoiceSet = { kind: "string", choices };
  // The schema default "GitHub Light" is the built-in light palette.
  const shown = value === "GitHub Light" ? builtin : value;
  return (
    <ChoiceSelect
      set={set}
      value={shown}
      id={id}
      describedBy={describedBy}
      invalid={invalid}
      onPick={(next) => onPick(String(next))}
    />
  );
}

export function FeatureChips({ value, onChange }: { value: unknown; onChange: (next: string[]) => void }) {
  const active = Array.isArray(value) ? value.map(String) : [];
  const known = new Set(FONT_FEATURES.map((feature) => feature.value));
  const extra = active.filter((feature) => !known.has(feature)).map((feature) => ({ value: feature, label: feature }));
  const toggle = (feature: string) =>
    onChange(active.includes(feature) ? active.filter((f) => f !== feature) : [...active, feature]);
  return (
    <fieldset className="m-0 flex min-w-0 flex-wrap justify-end gap-1.5 border-0 p-0">
      {[...FONT_FEATURES, ...extra].map((feature) => {
        const on = active.includes(feature.value);
        return (
          <button
            key={feature.value}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(feature.value)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs transition-colors",
              on
                ? "border-accent-ink bg-accent/15 text-fg"
                : "border-border-strong bg-surface text-muted hover:bg-surface-2 hover:text-fg",
            )}
          >
            {feature.label}
          </button>
        );
      })}
    </fieldset>
  );
}

export function DndSelect({
  value,
  onPick,
  id,
  describedBy,
  invalid,
}: Common & { value: unknown; onPick: (until: number) => void }) {
  const until = typeof value === "number" ? value : 0;
  const active = until * 1000 > Date.now();
  const options = active
    ? [
        {
          value: "keep",
          label: t("settings.dndUntil", { time: new Date(until * 1000).toLocaleString() }),
        },
        ...DND_OPTIONS,
      ]
    : DND_OPTIONS;
  return (
    <Select
      id={id}
      value={active ? "keep" : "off"}
      aria-describedby={describedBy}
      invalid={invalid}
      options={options}
      onValueChange={(next) => {
        if (next === "keep") return;
        onPick(next === "off" ? 0 : Math.floor(Date.now() / 1000) + Number(next));
      }}
    />
  );
}
