// The title bar's agent menu: the installed agents, one click away. Picking one types its command into the open
// task's terminal (`startHere.ts`), so the user does not type `claude` themselves.
import { IconButton, Icons, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, t } from "@tessera/ui";
import { useState } from "react";
import { runAction } from "../actions/registry";
import { notifications } from "../notify";
import { useAppDispatch } from "../store/hooks";
import { AgentLogo } from "./AgentLogo";
import { startAgentHere } from "./startHere";
import { type Launchable, useLaunchable } from "./useLaunchable";

/** One row per installed agent (its default profile); an agent with several profiles lists each by name. */
function rows(items: readonly Launchable[]): { item: Launchable; label: string }[] {
  const count = new Map<string, number>();
  for (const item of items) count.set(item.agent.id, (count.get(item.agent.id) ?? 0) + 1);
  return items.map((item) => ({
    item,
    label: (count.get(item.agent.id) ?? 0) > 1 ? `${item.agent.name} · ${item.profile.name}` : item.agent.name,
  }));
}

export function AgentStarter() {
  const dispatch = useAppDispatch();
  const [open, setOpen] = useState(false);
  const { items, loading } = useLaunchable(open);

  const start = (item: Launchable) => {
    dispatch(startAgentHere(item.profile.id)).catch((cause: unknown) =>
      notifications().toastNow({
        kind: "error",
        title: t("agents.here.failed", {
          name: item.agent.name,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      }),
    );
  };

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>
        <IconButton icon={Icons.Bot} label={t("agents.here.menu")} size="sm" data-agent-starter />
      </MenuTrigger>
      <MenuContent align="end" data-agent-starter-menu>
        <MenuLabel>{t("agents.here.heading")}</MenuLabel>
        {rows(items).map(({ item, label }) => (
          <MenuItem key={item.profile.id} data-agent-starter-item={item.agent.id} onSelect={() => start(item)}>
            <span className="flex min-w-0 items-center gap-2">
              <AgentLogo agent={item.agent.id} name={item.agent.name} size={16} />
              <span className="truncate">{label}</span>
            </span>
          </MenuItem>
        ))}
        {!loading && items.length === 0 && (
          <MenuItem disabled data-agent-starter-empty>
            {t("agents.here.none")}
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem icon={Icons.Settings2} onSelect={() => runAction("agents.open")}>
          {t("action.agents.open")}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
