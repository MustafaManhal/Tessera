// Watches agent sessions and fires the once-only "ready to compare" inbox notification per group (FR-36).
import type { AppStore } from "../store";
import { inbox } from "../notify/inbox";
import { t } from "@tessera/ui";
import { groupStatus, readyToCompare } from "./groups";
import type { TaskGroupInfo } from "./types";

const fired = new Set<string>();

export function startReadyToCompare(store: AppStore): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const check = () => {
    const state = store.getState();
    for (const group of Object.values(state.projects.groups) as TaskGroupInfo[]) {
      if (!readyToCompare(group, state.projects.tasks, state.agentSessions.sessions, fired)) continue;
      fired.add(group.id);
      const status = groupStatus(group, state.projects.tasks, state.agentSessions.sessions);
      void inbox()
        .record({
          source: "agent",
          taskId: null,
          paneSessionId: null,
          title: group.name,
          body: t("taskGroup.status", {
            working: status.working,
            needs: status.needs,
            idle: status.idle,
            done: status.done,
          }),
        })
        .catch(() => {});
    }
  };
  const unsubscribe = store.subscribe(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, 800);
  });
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}
