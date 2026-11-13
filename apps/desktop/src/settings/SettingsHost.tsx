// Mounted once in the Shell: starts the settings sync (config.toml ↔ Redux) and renders the settings dialog.
import { getPlatform, t } from "@tessera/ui";
import { useEffect, useRef } from "react";
import { keymap } from "../actions/keymap";
import { type Conflict, detectConflicts } from "../actions/conflicts";
import { actionLabel, actions } from "../actions/registry";
import { notifications } from "../notify";
import { useAppSelector, useAppStore } from "../store/hooks";
import { loadPreset } from "./KeybindingsPage";
import { configSchema } from "./provider";
import { flattenSchema } from "./schema";
import { useSettingsClient } from "./provider";
import { startSettingsSync } from "./sync";
import { lazyOnOpen } from "../shell/lazyOnOpen";

// The settings screen and its pages load when Settings is first opened; this host keeps the keymap and config in sync.
const SettingsDialog = lazyOnOpen(
  () => import("./SettingsDialog").then((m) => ({ default: m.SettingsDialog })),
  () => useAppSelector((s) => s.ui.settingsOpen),
);

function conflictMessage(conflict: Conflict): string {
  if (conflict.kind === "duplicate") {
    const owner = conflict.actions.find((id) => keymap.isCustom(id)) ?? conflict.actions[0];
    return t("keys.conflict.duplicate", {
      keys: conflict.keys,
      others: conflict.actions
        .filter((id) => id !== owner)
        .map((id) => {
          const action = actions.find((candidate) => candidate.id === id);
          return action ? actionLabel(action) : id;
        })
        .join(", "),
    });
  }
  if (conflict.kind === "reserved") return t("keys.conflict.reserved", { keys: conflict.keys });
  return t("keys.conflict.noModifier", { keys: conflict.keys });
}

export function SettingsHost() {
  const client = useSettingsClient();
  const store = useAppStore();
  useEffect(() => startSettingsSync(client, store), [client, store]);

  // The config's [keybindings] table drives the keymap (live: `config:changed` updates `config.values`). A chord that
  // cannot be read is ignored and reported once, with its key.
  useEffect(() => {
    keymap.setPreset(loadPreset());
  }, []);
  const values = useAppSelector((state) => state.config.values);
  const reported = useRef(new Set<string>());
  useEffect(() => {
    if (!values) return;
    const defaults: Record<string, unknown> = {};
    for (const field of flattenSchema(configSchema)) {
      if (field.section === "keybindings") defaults[field.name] = field.default;
    }
    const platform = getPlatform();
    for (const problem of keymap.setOverrides(values.keybindings, defaults, platform)) {
      const id = `${problem.key}\u0000${problem.value}\u0000${problem.reason}`;
      if (reported.current.has(id)) continue;
      reported.current.add(id);
      notifications().toastNow({
        kind: "error",
        title: t("keys.problem", {
          value: problem.value,
          key: problem.key,
          reason: t(`keys.problem.${problem.reason}`),
        }),
      });
    }
    const entries = actions.flatMap((action) =>
      keymap.entries(action.id, platform).map((entry) => ({
        actionId: action.id,
        keys: entry.keys,
        ...(entry.scope ? { scope: entry.scope } : {}),
      })),
    );
    for (const conflict of detectConflicts(entries, platform)) {
      if (!conflict.actions.some((id) => keymap.isCustom(id))) continue;
      const id = JSON.stringify(conflict);
      if (reported.current.has(id)) continue;
      reported.current.add(id);
      notifications().toastNow({ kind: "error", title: conflictMessage(conflict) });
    }
  }, [values]);
  return <SettingsDialog />;
}
