// Keeps the projects slice current: loads projects and tasks at start and applies `task:changed` events as they come.
import type { AppStore } from "../store";
import { groupUpserted, taskUpserted } from "../store/projectsSlice";
import type { ProjectsClient } from "./client";
import { setProjectsClient } from "./service";
import { loadProjects } from "./thunks";

export function startProjectsSync(client: ProjectsClient, store: AppStore): () => void {
  let stopped = false;
  const unsubscribers: (() => void)[] = [];
  setProjectsClient(client);
  void store.dispatch(loadProjects());
  void client.taskGroupsList(null).then(
    (groups) => {
      for (const group of groups) store.dispatch(groupUpserted(group));
    },
    // Groups only decorate the tree; projects and tasks load on their own.
    () => {},
  );
  void client
    .onTaskChanged((event) => {
      if (!stopped) store.dispatch(taskUpserted(event.summary));
    })
    .then(
      (off) => {
        if (stopped) off();
        else unsubscribers.push(off);
      },
      () => {},
    );
  void client
    .onTaskGroupChanged((group) => {
      if (!stopped) store.dispatch(groupUpserted(group));
    })
    .then(
      (off) => {
        if (stopped) off();
        else unsubscribers.push(off);
      },
      () => {},
    );
  return () => {
    stopped = true;
    for (const off of unsubscribers) off();
  };
}
