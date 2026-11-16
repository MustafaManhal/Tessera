// The task and project menus, shared by the right-click menu and the "…" button (one list of entries, two skins).
import { Icons, type MenuItemProps, t } from "@tessera/ui";
import type { ComponentType, ReactNode } from "react";
import { primaryShortcut } from "../actions/registry";
import { getPlatform } from "@tessera/ui";
import type { TaskSummary, Project, RunScript } from "../projects/types";
import type { AppDispatch } from "../store";
import { layout } from "../store/layoutSlice";
import {
  copyBranchAction,
  archiveTaskAction,
  requestDeleteTask,
  restoreTaskAction,
  openTaskInEditorAction,
  revealWorktreeAction,
} from "./taskActions";
import { runScriptAction } from "./runScripts";
import {
  requestBranches,
  requestNewTask,
  requestProjectSettings,
  requestRemoveProject,
  requestWorktrees,
  toggleWorkMode,
  updateProjectMute,
} from "./projectActions";
import { openTaskTab } from "./taskTabs";

type Item = ComponentType<MenuItemProps>;
type Separator = ComponentType<Record<string, never>>;

interface TaskMenuProps {
  Item: Item;
  Separator: Separator;
  task: TaskSummary;
  dispatch: AppDispatch;
  onRename: () => void;
  /** The project's run scripts, one menu entry each. */
  scripts?: RunScript[];
}

export function TaskMenuItems({ Item, Separator, task, dispatch, onRename, scripts = [] }: TaskMenuProps): ReactNode {
  const platform = getPlatform();
  const archived = task.state === "archived";
  return (
    <>
      <Item icon={Icons.SquareTerminal} onSelect={() => dispatch(openTaskTab(task.id))}>
        {t("task.open")}
      </Item>
      <Item icon={Icons.Pencil} shortcut="F2" onSelect={onRename}>
        {t("action.task.rename")}
      </Item>
      <Item icon={Icons.Copy} onSelect={() => void dispatch(copyBranchAction(task.id))}>
        {t("action.task.copyBranch")}
      </Item>
      <Item icon={Icons.Code} onSelect={() => void dispatch(openTaskInEditorAction(task.id))}>
        {t("task.openInEditor")}
      </Item>
      {scripts.map((script) => (
        <Item key={script.id} icon={Icons.Play} onSelect={() => void dispatch(runScriptAction(task.id, script))}>
          {t("task.runScriptEntry", { name: script.name })}
        </Item>
      ))}
      <Item icon={Icons.FolderOpen} onSelect={() => void dispatch(revealWorktreeAction(task.id))}>
        {t("action.task.reveal")}
      </Item>
      <Separator />
      {archived ? (
        <Item icon={Icons.ArchiveRestore} onSelect={() => void dispatch(restoreTaskAction(task.id))}>
          {t("action.task.restore")}
        </Item>
      ) : (
        <Item
          icon={Icons.Archive}
          shortcut={primaryShortcut("task.archive", platform)}
          onSelect={() => void dispatch(archiveTaskAction(task.id))}
        >
          {t("action.task.archive")}
        </Item>
      )}
      <Item icon={Icons.Trash2} shortcut="Delete" onSelect={() => dispatch(requestDeleteTask(task.id))}>
        {t("action.task.delete")}
      </Item>
    </>
  );
}

interface ProjectMenuProps {
  Item: Item;
  Separator: Separator;
  project: Project;
  dispatch: AppDispatch;
  /** Worktrees that were there before Tessera (shown as a menu entry when there are any). */
  foreignWorktrees?: number;
}

export function ProjectMenuItems({
  Item,
  Separator,
  project,
  dispatch,
  foreignWorktrees = 0,
}: ProjectMenuProps): ReactNode {
  const platform = getPlatform();
  return (
    <>
      <Item
        icon={Icons.Plus}
        shortcut={primaryShortcut("task.new", platform)}
        onSelect={() => dispatch(requestNewTask(project.id))}
      >
        {t("action.project.newTask", { name: project.name })}
      </Item>
      <Item
        icon={Icons.SquareTerminal}
        onSelect={() => dispatch(layout({ type: "tab/new", cwd: project.path, title: project.name }))}
      >
        {t("action.project.openFolder")}
      </Item>
      <Separator />
      <Item icon={Icons.GitFork} onSelect={() => dispatch(requestWorktrees(project.id))}>
        {foreignWorktrees > 0
          ? t("action.project.worktreesCount", { count: foreignWorktrees })
          : t("action.project.worktrees")}
      </Item>
      <Item icon={Icons.GitBranch} onSelect={() => dispatch(requestBranches(project.id))}>
        {t("action.project.branches")}
      </Item>
      <Item
        icon={project.work_mode === "branches" ? Icons.GitFork : Icons.GitBranch}
        onSelect={() => void dispatch(toggleWorkMode(project.id))}
      >
        {t(project.work_mode === "branches" ? "action.project.useWorktrees" : "action.project.useBranches")}
      </Item>
      <Separator />
      <Item icon={Icons.Settings2} onSelect={() => dispatch(requestProjectSettings(project.id))}>
        {t("action.project.settings")}
      </Item>
      <Item
        icon={project.is_muted ? Icons.Bell : Icons.BellOff}
        onSelect={() => void dispatch(updateProjectMute(project.id))}
      >
        {t(project.is_muted ? "action.project.unmute" : "action.project.mute")}
      </Item>
      <Separator />
      <Item icon={Icons.Trash2} onSelect={() => dispatch(requestRemoveProject(project.id))}>
        {t("action.project.remove")}
      </Item>
    </>
  );
}
