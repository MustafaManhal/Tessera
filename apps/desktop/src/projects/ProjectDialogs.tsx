// The one project or task dialog that is open (`ui.projectDialog`): add project, new task, project settings, and the
// two delete confirmations. Each dialog is its own component so it mounts fresh every time it opens.
import { useEffect, useRef } from "react";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { requestPaneFocus, setProjectDialog } from "../store/uiSlice";
import { ArchiveGroupOthersDialog, DeleteTaskDialog, RemoveProjectDialog } from "./ConfirmDialogs";
import { AddProjectDialog } from "./dialogs/AddProjectDialog";
import { NewTaskDialog } from "./dialogs/NewTaskDialog";
import { NewTaskGroupDialog } from "./dialogs/NewTaskGroupDialog";
import { ProjectSettingsDialog } from "./dialogs/ProjectSettingsDialog";

export function ProjectDialogs() {
  const dialog = useAppSelector((state) => state.ui.projectDialog);
  const dispatch = useAppDispatch();
  const close = () => dispatch(setProjectDialog(null));
  // Focus goes back to where it was (a sidebar row, say); when that is gone (a deleted task) it goes to the terminal.
  const opener = useRef<HTMLElement | null>(null);
  const open = dialog !== null;
  useEffect(() => {
    if (open) {
      opener.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return;
    }
    const element = opener.current;
    opener.current = null;
    if (!element) return;
    requestAnimationFrame(() => {
      if (element.isConnected) element.focus();
      else dispatch(requestPaneFocus());
    });
  }, [open, dispatch]);
  if (!dialog) return null;
  switch (dialog.kind) {
    case "addProject":
      return <AddProjectDialog onClose={close} />;
    case "newTaskGroup":
      return <NewTaskGroupDialog onClose={close} />;
    case "newTask":
      return <NewTaskDialog projectId={dialog.projectId} prompt={dialog.prompt} onClose={close} />;
    case "projectSettings":
      return <ProjectSettingsDialog projectId={dialog.projectId} onClose={close} />;
    case "deleteTask":
      return <DeleteTaskDialog taskId={dialog.taskId} onClose={close} />;
    case "removeProject":
      return <RemoveProjectDialog projectId={dialog.projectId} onClose={close} />;
    case "archiveGroupOthers":
      return <ArchiveGroupOthersDialog groupId={dialog.groupId} onClose={close} />;
  }
}
