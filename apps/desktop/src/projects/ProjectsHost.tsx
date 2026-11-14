// Mounted once in the Shell: loads projects and tasks, follows `task:changed`, and renders the project and task dialogs.
import { useEffect } from "react";
import { useAppStore } from "../store/hooks";
import { ProjectDialogs } from "./ProjectDialogs";
import { projectsClient } from "./service";
import { startReadyToCompare } from "./readyToCompare";
import { startProjectsSync } from "./sync";

export function ProjectsHost() {
  const store = useAppStore();
  useEffect(() => {
    const stopSync = startProjectsSync(projectsClient(), store);
    const stopReady = startReadyToCompare(store);
    return () => {
      stopSync();
      stopReady();
    };
  }, [store]);
  return <ProjectDialogs />;
}
