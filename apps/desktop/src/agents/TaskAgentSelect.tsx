// The agent choice in the New task dialog: one drop-down listing every installed agent profile (tick the ones to start),
// then the agents that are not installed yet, and a way to add one. Each row has the logo and the name on one line.
import {
  Button,
  Icons,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  t,
} from "@tessera/ui";
import { useEffect, useState } from "react";
import { AgentLogo } from "./AgentLogo";
import { agentsClient } from "./service";
import type { AgentInfo } from "./types";
import { type Launchable, launchableLabel } from "./useLaunchable";

export function TaskAgentSelect({
  items,
  chosen,
  onToggle,
  onManage,
}: {
  items: Launchable[];
  chosen: string[];
  onToggle: (profileId: string) => void;
  /** Opens the Agents page, where an agent is installed or added. */
  onManage: () => void;
}) {
  const [missing, setMissing] = useState<AgentInfo[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      agentsClient()
        .agentCatalog(false)
        .then((agents) => alive && setMissing(agents.filter((agent) => !agent.installed)))
        .catch(() => alive && setMissing([]));
    void load();
    const stop = agentsClient().onChanged(() => void load());
    return () => {
      alive = false;
      stop();
    };
  }, []);
  const picked = items.filter((item) => chosen.includes(item.profile.id));
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="sm" data-agent-picker className="justify-between self-start">
          <span className="flex items-center gap-2">
            {picked.length === 0
              ? t("newTask.agentsPick")
              : picked.map((item) => (
                  <span
                    key={item.profile.id}
                    className="inline-flex items-center gap-1.5"
                    data-agent-picked={item.agent.id}
                  >
                    <AgentLogo agent={item.agent.id} name={item.agent.name} size={14} />
                    {item.agent.name}
                  </span>
                ))}
          </span>
          <Icons.ChevronDown size={14} aria-hidden />
        </Button>
      </MenuTrigger>
      <MenuContent align="start">
        {items.length > 0 && <MenuLabel>{t("newTask.agentsInstalled")}</MenuLabel>}
        {items.map((item) => (
          <MenuCheckboxItem
            key={item.profile.id}
            checked={chosen.includes(item.profile.id)}
            data-agent-option={item.agent.id}
            // Several agents can be ticked: keep the list open.
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => onToggle(item.profile.id)}
          >
            <span className="flex items-center gap-2">
              <AgentLogo agent={item.agent.id} name={item.agent.name} size={16} />
              <span>{item.profile.is_default ? item.agent.name : launchableLabel(item)}</span>
              {item.profile.skip_permissions && (
                <Icons.TriangleAlert
                  size={12}
                  className="text-st-error"
                  aria-label={t("newTask.skipMarker", { name: item.agent.name })}
                />
              )}
            </span>
          </MenuCheckboxItem>
        ))}
        {items.length === 0 && <MenuLabel>{t("newTask.agentsNone")}</MenuLabel>}
        {missing.length > 0 && (
          <>
            <MenuSeparator />
            <MenuLabel>{t("newTask.agentsGet")}</MenuLabel>
            {missing.map((agent) => (
              <MenuItem key={agent.id} data-agent-install={agent.id} onSelect={onManage}>
                <span className="flex items-center gap-2">
                  <AgentLogo agent={agent.id} name={agent.name} size={16} />
                  <span>{t("newTask.agentsInstall", { name: agent.name })}</span>
                </span>
              </MenuItem>
            ))}
          </>
        )}
        <MenuSeparator />
        <MenuItem icon={Icons.Plus} data-agent-add onSelect={onManage}>
          {t("newTask.agentsAdd")}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
