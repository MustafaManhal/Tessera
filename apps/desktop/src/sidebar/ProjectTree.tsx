// The sidebar's project tree (S-02, WAI-ARIA tree): project groups with their task rows and a collapsed "Archived"
// section. Keyboard: Up/Down move, Right/Left expand and collapse (or step into the group / out to the parent),
// Home/End, Enter opens a task or toggles a group, F2 renames, Delete deletes, `/` focuses the filter,
// Alt+Shift+Up/Down reorders a project. Pointer: click opens, right click or "…" opens the menu, drag moves a project.
// biome-ignore-all lint/a11y/useKeyWithClickEvents: the tree element handles the keys for every item (APG tree).
// biome-ignore-all lint/a11y/useSemanticElements: tree, treeitem and group are the APG tree pattern on lists.
// biome-ignore-all lint/a11y/noNoninteractiveElementToInteractiveRole: an APG tree is a list with the tree role.
import {
  cn,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  EmptyState,
  getPlatform,
  IconButton,
  Icons,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  type MenuItemProps,
  t,
} from "@tessera/ui";
import { groupStatus } from "../projects/groups";
import { projectsClient } from "../projects/service";
import {
  type ComponentType,
  type DragEvent,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { primaryShortcut } from "../actions/registry";
import { type Project, type RunScript, type TaskSummary, remoteHost } from "../projects/types";
import { loadProjects, reorderProjects } from "../projects/thunks";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import {
  isCollapsed,
  type ProjectGroup,
  selectGroups,
  selectProjectsFilter,
  selectProjectDisplayOrder,
  selectProjectsStatus,
  selectStatusFilter,
  toggleCollapsed,
} from "../store/projectsSlice";
import { announce, setCompareGroup, setProjectDialog } from "../store/uiSlice";
import { FilterMenu, OPEN_FILTER_EVENT } from "./FilterMenu";
import { ProjectMenuItems, TaskMenuItems } from "./menus";
import { renameTaskAction, requestDeleteTask } from "./taskActions";
import { requestNewTask, requestWorktrees, saveTaskOrder } from "./projectActions";
import { useForeignWorktrees } from "../projects/useCheckouts";
import { openTaskTab, findTaskTab } from "./taskTabs";
import { useAppStore } from "../store/hooks";
import { TaskAgentStatus, useTaskAgentSummary } from "./TaskAgentStatus";
import { TaskPrChips } from "../pulls/TaskPrChips";

const CItem = ContextMenuItem as unknown as ComponentType<MenuItemProps>;
const CSep = ContextMenuSeparator as unknown as ComponentType<Record<string, never>>;
const MItem = MenuItem as ComponentType<MenuItemProps>;
const MSep = MenuSeparator as unknown as ComponentType<Record<string, never>>;

type NodeKind = "project" | "task" | "archived";
interface TreeNode {
  key: string;
  kind: NodeKind;
  id: string;
  /** The project this node belongs to. */
  projectId: string;
  level: 1 | 2;
  parent: string | null;
  expandable: boolean;
  expanded: boolean;
}

const projectKey = (id: string) => `p:${id}`;
const taskKey = (id: string) => `t:${id}`;
const archivedKey = (id: string) => `a:${id}`;

function flatten(groups: ProjectGroup[], collapsed: Record<string, boolean>, filtering: boolean): TreeNode[] {
  const out: TreeNode[] = [];
  for (const { project, tasks, archived } of groups) {
    const open = !isCollapsed({ collapsed }, project.id);
    out.push({
      key: projectKey(project.id),
      kind: "project",
      id: project.id,
      projectId: project.id,
      level: 1,
      parent: null,
      expandable: true,
      expanded: open,
    });
    if (!open) continue;
    for (const task of tasks) {
      out.push({
        key: taskKey(task.id),
        kind: "task",
        id: task.id,
        projectId: project.id,
        level: 2,
        parent: projectKey(project.id),
        expandable: false,
        expanded: false,
      });
    }
    if (archived.length > 0) {
      const archivedOpen = filtering || !isCollapsed({ collapsed }, `archived:${project.id}`);
      out.push({
        key: archivedKey(project.id),
        kind: "archived",
        id: project.id,
        projectId: project.id,
        level: 2,
        parent: projectKey(project.id),
        expandable: true,
        expanded: archivedOpen,
      });
      if (archivedOpen) {
        for (const task of archived) {
          out.push({
            key: taskKey(task.id),
            kind: "task",
            id: task.id,
            projectId: project.id,
            level: 2,
            parent: archivedKey(project.id),
            expandable: false,
            expanded: false,
          });
        }
      }
    }
  }
  return out;
}

export function ProjectTree({ filterTrailing, title }: { filterTrailing?: ReactNode; title?: string } = {}) {
  const dispatch = useAppDispatch();
  const store = useAppStore();
  const status = useAppSelector(selectProjectsStatus);
  const error = useAppSelector((state) => state.projects.error);
  const groups = useAppSelector(selectGroups);
  const filter = useAppSelector(selectProjectsFilter);
  const collapsed = useAppSelector((state) => state.projects.collapsed);
  const tasks = useAppSelector((state) => state.projects.tasks);
  const taskGroups = useAppSelector((state) => state.projects.groups);
  const agentSessions = useAppSelector((state) => state.agentSessions.sessions);
  const hasProjects = useAppSelector((state) => state.projects.order.length > 0);
  const openTabs = useAppSelector((state) => state.layout.tabs.length);
  const activeTask = useAppSelector((state) => {
    const tab = state.layout.tabs.find((candidate) => candidate.id === state.layout.activeTab);
    return tab ? (state.layout.panes[tab.focusedPane]?.taskId ?? null) : null;
  });
  const platform = getPlatform();
  const statusFilter = useAppSelector(selectStatusFilter);
  const filtering = filter.trim() !== "" || statusFilter !== "all";
  const nodes = useMemo(() => flatten(groups, collapsed, filtering), [groups, collapsed, filtering]);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null>(null);
  const [draggingTask, setDraggingTask] = useState<{ id: string; projectId: string } | null>(null);
  const [dropBeforeTask, setDropBeforeTask] = useState<string | null>(null);
  const treeRef = useRef<HTMLUListElement>(null);
  const moveFocusToDom = useRef(false);
  const [focusTick, setFocusTick] = useState(0);
  void openTabs;

  // The roving tab stop: the focused node if it still exists, else the open task, else the first node.
  const tabStop =
    nodes.find((node) => node.key === focusKey)?.key ??
    (activeTask ? nodes.find((node) => node.key === taskKey(activeTask))?.key : undefined) ??
    nodes[0]?.key ??
    null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `focusTick` re-runs this when the same node is focused again.
  useEffect(() => {
    if (!moveFocusToDom.current || !focusKey) return;
    moveFocusToDom.current = false;
    treeRef.current?.querySelector<HTMLElement>(`[data-tree-key="${CSS.escape(focusKey)}"]`)?.focus();
  }, [focusKey, focusTick]);

  if (status === "idle" || status === "loading") {
    return (
      <p className="px-3 py-4 text-sm text-muted" role="status">
        {t("sidebar.loading")}
      </p>
    );
  }
  if (status === "error") {
    return (
      <EmptyState
        className="flex-1"
        icon={Icons.TriangleAlert}
        message={error ?? t("sidebar.loadFailed")}
        action={{ label: t("sidebar.retry"), icon: Icons.RotateCcw, onClick: () => void dispatch(loadProjects()) }}
      />
    );
  }
  if (!hasProjects) {
    return (
      <EmptyState
        className="flex-1"
        icon={Icons.FolderGit2}
        message={t("sidebar.empty")}
        action={{
          label: t("sidebar.addProject"),
          icon: Icons.Plus,
          onClick: () => dispatch(setProjectDialog({ kind: "addProject" })),
        }}
      />
    );
  }

  const focusNode = (key: string | null | undefined) => {
    if (!key) return;
    moveFocusToDom.current = true;
    setFocusKey(key);
    setFocusTick((tick) => tick + 1);
  };

  const activate = (node: TreeNode) => {
    if (node.kind === "task") dispatch(openTaskTab(node.id));
    else dispatch(toggleCollapsed({ key: node.kind === "archived" ? `archived:${node.id}` : node.id }));
  };

  const reorder = (projectId: string, offset: number) => {
    const order = selectProjectDisplayOrder(store.getState());
    const from = order.indexOf(projectId);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= order.length) return;
    const next = [...order];
    next.splice(to, 0, ...next.splice(from, 1));
    void dispatch(reorderProjects(next)).catch(() => {});
    const name = store.getState().projects.projects[projectId]?.name ?? "";
    dispatch(announce(t("sidebar.moved", { name, position: to + 1, count: order.length })));
  };

  /** The ids of a project's tasks as shown (archived ones are not part of the order). */
  const shownTasks = (projectId: string) =>
    groups.find((g) => g.project.id === projectId)?.tasks.map((t) => t.id) ?? [];

  const moveTask = (taskId: string, projectId: string, offset: number) => {
    const ids = shownTasks(projectId);
    const from = ids.indexOf(taskId);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= ids.length) return;
    const next = [...ids];
    next.splice(to, 0, ...next.splice(from, 1));
    dispatch(saveTaskOrder(projectId, next));
    const name = store.getState().projects.tasks[taskId]?.name ?? "";
    dispatch(announce(t("sidebar.moved", { name, position: to + 1, count: ids.length })));
  };

  const onDropTask = (event: DragEvent, targetId: string, projectId: string) => {
    if (!draggingTask || draggingTask.projectId !== projectId || draggingTask.id === targetId) return;
    event.preventDefault();
    const ids = shownTasks(projectId).filter((id) => id !== draggingTask.id);
    const at = ids.indexOf(targetId);
    ids.splice(at < 0 ? ids.length : at, 0, draggingTask.id);
    dispatch(saveTaskOrder(projectId, ids));
    setDraggingTask(null);
    setDropBeforeTask(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (renaming) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-tree-key]");
    const key = target?.dataset.treeKey;
    if (!key || event.ctrlKey || event.metaKey) return;
    const index = nodes.findIndex((node) => node.key === key);
    const node = nodes[index];
    if (!node) return;
    const go = (to: number) => {
      event.preventDefault();
      focusNode(nodes[Math.max(0, Math.min(nodes.length - 1, to))]?.key);
    };
    if (
      event.altKey &&
      event.shiftKey &&
      node.kind === "project" &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      event.preventDefault();
      reorder(node.id, event.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (
      event.altKey &&
      event.shiftKey &&
      node.kind === "task" &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      event.preventDefault();
      const projectId = store.getState().projects.tasks[node.id]?.project_id;
      if (projectId) moveTask(node.id, projectId, event.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (event.altKey) return;
    switch (event.key) {
      case "ArrowDown":
        return go(index + 1);
      case "ArrowUp":
        return go(index - 1);
      case "Home":
        return go(0);
      case "End":
        return go(nodes.length - 1);
      case "ArrowRight":
        event.preventDefault();
        if (node.expandable && !node.expanded) activate(node);
        else if (node.expanded) go(index + 1);
        return;
      case "ArrowLeft":
        event.preventDefault();
        if (node.expandable && node.expanded) activate(node);
        else if (node.parent) focusNode(node.parent);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        activate(node);
        return;
      case "F2":
        if (node.kind === "task") {
          event.preventDefault();
          setRenaming(node.id);
        }
        return;
      case "Delete":
      case "Backspace":
        if (node.kind === "task") {
          event.preventDefault();
          dispatch(requestDeleteTask(node.id));
        }
        return;
      case "/":
        event.preventDefault();
        window.dispatchEvent(new Event(OPEN_FILTER_EVENT));
        return;
    }
  };

  const onDragOverProject = (event: DragEvent, projectId: string) => {
    if (!dragging || dragging === projectId) return;
    event.preventDefault();
    setDropBefore(projectId);
  };
  const onDropProject = (event: DragEvent, projectId: string) => {
    if (!dragging) return;
    event.preventDefault();
    const order = selectProjectDisplayOrder(store.getState()).filter((id) => id !== dragging);
    const at = order.indexOf(projectId);
    order.splice(at < 0 ? order.length : at, 0, dragging);
    void dispatch(reorderProjects(order)).catch(() => {});
    setDragging(null);
    setDropBefore(null);
  };

  return (
    <>
      <FilterMenu onArrowDown={() => focusNode(tabStop)} trailing={filterTrailing} title={title} />
      {filtering && groups.length === 0 ? (
        <p className="px-3 py-2 text-sm text-muted" role="status">
          {t("sidebar.noMatches", { query: filter })}
        </p>
      ) : (
        <ul
          ref={treeRef}
          role="tree"
          aria-label={t("sidebar.tree")}
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
          onKeyDown={onKeyDown}
        >
          {groups.map(({ project, tasks: own, archived }) => {
            const open = !isCollapsed({ collapsed }, project.id);
            const pKey = projectKey(project.id);
            const archivedOpen = filtering || !isCollapsed({ collapsed }, `archived:${project.id}`);
            return (
              <li
                key={project.id}
                role="none"
                className={cn("mt-2 first:mt-0", dropBefore === project.id && "border-t-2 border-accent-ink")}
              >
                <ProjectRow
                  project={project}
                  open={open}
                  tabStop={tabStop === pKey}
                  active={activeTask !== null && tasks[activeTask]?.project_id === project.id}
                  count={own.length}
                  platform={platform}
                  onFocus={() => setFocusKey(pKey)}
                  onToggle={() => dispatch(toggleCollapsed({ key: project.id }))}
                  onDragStart={() => setDragging(project.id)}
                  onDragEnd={() => {
                    setDragging(null);
                    setDropBefore(null);
                  }}
                  onDragOver={(event) => onDragOverProject(event, project.id)}
                  onDrop={(event) => onDropProject(event, project.id)}
                />
                {open && (
                  <ul role="group" className="m-0 mt-0.5 flex list-none flex-col gap-0.5 p-0">
                    {own.length === 0 && archived.length === 0 && (
                      <li role="none" className="ps-9 pe-2 py-2 text-xs text-muted">
                        {t("sidebar.noTasks")}
                      </li>
                    )}
                    {own.map((task) => {
                      const gid = task.group_id && taskGroups[task.group_id] ? task.group_id : null;
                      const isFirst = gid !== null && own.find((t) => t.group_id === gid)?.id === task.id;
                      const group = gid ? taskGroups[gid] : null;
                      const gstatus = group ? groupStatus(group, tasks, agentSessions) : null;
                      return (
                        <Fragment key={task.id}>
                          {isFirst && group && gstatus && (
                            <li role="none" data-task-group={group.id} className="ms-3">
                              <div
                                data-tree-key={`g:${group.id}`}
                                className="group flex min-h-7 items-center gap-1.5 rounded-md px-2 py-0.5 text-xs text-muted hover:bg-surface-2"
                              >
                                <Icons.Layers size={13} aria-hidden />
                                <span className="min-w-0 flex-1 truncate font-medium text-fg/80">{group.name}</span>
                                {group.picked_task_id && (
                                  <span className="shrink-0 text-accent-ink">{t("taskGroup.picked")}</span>
                                )}
                                <span className="shrink-0">
                                  {t("taskGroup.status", {
                                    working: gstatus.working,
                                    needs: gstatus.needs,
                                    idle: gstatus.idle,
                                    done: gstatus.done,
                                  })}
                                </span>
                                <Menu>
                                  <MenuTrigger asChild>
                                    <IconButton
                                      size="sm"
                                      icon={Icons.Ellipsis}
                                      tabIndex={-1}
                                      label={t("task.more", { name: group.name })}
                                      className="opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100"
                                    />
                                  </MenuTrigger>
                                  <MenuContent align="start">
                                    <MItem onSelect={() => dispatch(setCompareGroup(group.id))}>
                                      {t("compare.open")}
                                    </MItem>
                                    <MSep />
                                    {own
                                      .filter((m) => m.group_id === group.id)
                                      .map((member) => (
                                        <MItem
                                          key={member.id}
                                          onSelect={() =>
                                            void projectsClient()
                                              .taskGroupPick(group.id, member.id)
                                              .catch(() => {})
                                          }
                                        >
                                          {t("taskGroup.pick")}: {member.name}
                                          {group.picked_task_id === member.id ? ` (${t("taskGroup.picked")})` : ""}
                                        </MItem>
                                      ))}
                                    <MSep />
                                    <MItem
                                      disabled={!group.picked_task_id}
                                      onSelect={() =>
                                        dispatch(setProjectDialog({ kind: "archiveGroupOthers", groupId: group.id }))
                                      }
                                    >
                                      {t("taskGroup.archiveOthers", {
                                        count: own.filter(
                                          (m) => m.group_id === group.id && m.id !== group.picked_task_id,
                                        ).length,
                                      })}
                                    </MItem>
                                  </MenuContent>
                                </Menu>
                              </div>
                            </li>
                          )}
                          <TaskRow
                            key={task.id}
                            task={task}
                            base={task.base_branch}
                            tabStop={tabStop === taskKey(task.id)}
                            current={activeTask === task.id}
                            opened={findTaskTab(store.getState(), task.id) !== undefined}
                            renaming={renaming === task.id}
                            muted={project.is_muted}
                            dropBefore={dropBeforeTask === task.id}
                            onDragStart={() => setDraggingTask({ id: task.id, projectId: project.id })}
                            onDragEnd={() => {
                              setDraggingTask(null);
                              setDropBeforeTask(null);
                            }}
                            onDragOver={(event) => {
                              if (!draggingTask || draggingTask.projectId !== project.id || draggingTask.id === task.id)
                                return;
                              event.preventDefault();
                              setDropBeforeTask(task.id);
                            }}
                            onDrop={(event) => onDropTask(event, task.id, project.id)}
                            onFocus={() => setFocusKey(taskKey(task.id))}
                            onRename={() => setRenaming(task.id)}
                            onRenamed={(name) => {
                              setRenaming(null);
                              if (name !== null) void dispatch(renameTaskAction(task.id, name));
                              focusNode(taskKey(task.id));
                            }}
                          />
                        </Fragment>
                      );
                    })}
                    {archived.length > 0 && (
                      <li role="none">
                        <div
                          role="treeitem"
                          tabIndex={tabStop === archivedKey(project.id) ? 0 : -1}
                          aria-level={2}
                          aria-expanded={archivedOpen}
                          data-tree-key={archivedKey(project.id)}
                          className="flex h-7 cursor-default items-center gap-2 rounded-md ps-7 pe-2 text-xs text-muted hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus"
                          onFocus={() => setFocusKey(archivedKey(project.id))}
                          onClick={() => dispatch(toggleCollapsed({ key: `archived:${project.id}` }))}
                        >
                          {archivedOpen ? (
                            <Icons.ChevronDown size={14} aria-hidden />
                          ) : (
                            <Icons.ChevronRight size={14} aria-hidden />
                          )}
                          <Icons.Archive size={14} aria-hidden />
                          {t("sidebar.archived", { count: archived.length })}
                        </div>
                        {archivedOpen && (
                          <ul role="group" className="m-0 list-none p-0">
                            {archived.map((task) => (
                              <TaskRow
                                key={task.id}
                                task={task}
                                base={task.base_branch}
                                tabStop={tabStop === taskKey(task.id)}
                                current={activeTask === task.id}
                                opened={false}
                                renaming={renaming === task.id}
                                muted={project.is_muted}
                                onFocus={() => setFocusKey(taskKey(task.id))}
                                onRename={() => setRenaming(task.id)}
                                onRenamed={(name) => {
                                  setRenaming(null);
                                  if (name !== null) void dispatch(renameTaskAction(task.id, name));
                                  focusNode(taskKey(task.id));
                                }}
                              />
                            ))}
                          </ul>
                        )}
                      </li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <span className="sr-only">{Object.keys(tasks).length}</span>
    </>
  );
}

interface ProjectRowProps {
  project: Project;
  open: boolean;
  tabStop: boolean;
  /** The task in front belongs to this project. */
  active: boolean;
  count: number;
  platform: ReturnType<typeof getPlatform>;
  onFocus: () => void;
  onToggle: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
}

function ProjectRow({ project, open, tabStop, active, count, platform, onFocus, onToggle, ...drag }: ProjectRowProps) {
  const dispatch = useAppDispatch();
  const foreign = useForeignWorktrees(project);
  const key = projectKey(project.id);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="treeitem"
          aria-level={1}
          aria-expanded={open}
          aria-label={project.is_muted ? `${project.name}, ${t("sidebar.muted")}` : project.name}
          tabIndex={tabStop ? 0 : -1}
          data-tree-key={key}
          data-project={project.id}
          draggable
          title={`${project.path}\n${t("sidebar.dragProject", { name: project.name })}`}
          className={cn(
            "group flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm font-semibold hover:bg-surface-2",
            active && "bg-accent/10 text-accent-ink hover:bg-accent/15",
            "focus-visible:outline-2 focus-visible:outline-focus",
            project.is_muted && "opacity-60",
          )}
          onFocus={onFocus}
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("button")) return;
            onToggle();
          }}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", project.id);
            drag.onDragStart();
          }}
          onDragEnd={drag.onDragEnd}
          onDragOver={drag.onDragOver}
          onDrop={drag.onDrop}
        >
          {open ? <Icons.ChevronDown size={14} aria-hidden /> : <Icons.ChevronRight size={14} aria-hidden />}
          {/* A cloud for a project on an SSH host, a folder for one on this computer. */}
          {remoteHost(project.path) ? (
            <Icons.Cloud size={14} className="shrink-0 text-accent-ink" aria-hidden data-project-icon="remote" />
          ) : open ? (
            <Icons.FolderOpen size={14} className="shrink-0" aria-hidden data-project-icon="folder" />
          ) : (
            <Icons.Folder size={14} className="shrink-0" aria-hidden data-project-icon="folder" />
          )}
          <span className="min-w-0 flex-1 truncate" data-project-name data-active={active || undefined}>
            {project.name}
          </span>
          {remoteHost(project.path) && (
            <span
              className="flex shrink-0 items-center gap-0.5 text-xs font-normal text-muted"
              title={t("sidebar.onHost", { host: remoteHost(project.path) ?? "" })}
              data-remote-project
            >
              <Icons.Server size={12} aria-hidden />
              {remoteHost(project.path)}
            </span>
          )}
          {project.is_muted && <Icons.BellOff size={12} className="shrink-0 text-muted" aria-hidden />}
          {foreign.length > 0 && (
            <IconButton
              size="sm"
              icon={Icons.TriangleAlert}
              tabIndex={-1}
              data-existing-worktrees-badge
              label={
                foreign.length === 1
                  ? t("worktrees.existing.badgeOne")
                  : t("worktrees.existing.badge", { count: foreign.length })
              }
              className="text-st-needs"
              onClick={() => dispatch(requestWorktrees(project.id))}
            />
          )}
          <span className="text-xs font-normal text-muted" aria-hidden>
            {count}
          </span>
          <IconButton
            size="sm"
            icon={Icons.Plus}
            tabIndex={-1}
            label={t("action.project.newTask", { name: project.name })}
            shortcut={primaryShortcut("task.new", platform)}
            className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus:opacity-100"
            onClick={() => dispatch(requestNewTask(project.id))}
          />
          <Menu>
            <MenuTrigger asChild>
              <IconButton
                size="sm"
                icon={Icons.Ellipsis}
                tabIndex={-1}
                label={t("project.more", { name: project.name })}
                className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100"
              />
            </MenuTrigger>
            <MenuContent align="start">
              <ProjectMenuItems
                Item={MItem}
                Separator={MSep}
                project={project}
                dispatch={dispatch}
                foreignWorktrees={foreign.length}
              />
            </MenuContent>
          </Menu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ProjectMenuItems
          Item={CItem}
          Separator={CSep}
          project={project}
          dispatch={dispatch}
          foreignWorktrees={foreign.length}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface TaskRowProps {
  task: TaskSummary;
  base: string;
  tabStop: boolean;
  current: boolean;
  opened: boolean;
  renaming: boolean;
  muted: boolean;
  dropBefore?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDragOver?: (event: DragEvent) => void;
  onDrop?: (event: DragEvent) => void;
  onFocus: () => void;
  onRename: () => void;
  onRenamed: (name: string | null) => void;
}

const NO_SCRIPTS: RunScript[] = [];

function TaskRow({
  task,
  base,
  tabStop,
  current,
  opened,
  renaming,
  muted,
  dropBefore = false,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onFocus,
  onRename,
  onRenamed,
}: TaskRowProps) {
  const dispatch = useAppDispatch();
  const scripts = useAppSelector((state) => state.projects.scripts[task.project_id]) ?? NO_SCRIPTS;
  const archived = task.state === "archived";
  const agentSummary = useTaskAgentSummary(task.id);
  const stateLabel =
    task.state === "setting_up" ? t("task.state.setting_up") : task.state === "error" ? t("task.state.error") : null;
  const parts = [
    t("task.onBranch", { branch: task.branch }),
    task.ahead ? t("task.ahead", { count: task.ahead, base }) : null,
    task.behind ? t("task.behind", { count: task.behind, base }) : null,
    task.changed_files ? t("task.files", { count: task.changed_files }) : null,
    task.ports.length > 0 ? t("task.ports", { ports: task.ports.join(", ") }) : null,
    task.uses_main_checkout ? t("task.mainCheckout") : null,
    stateLabel,
    archived ? t("task.state.archived") : null,
  ].filter(Boolean);
  return (
    <li role="none" className={cn(dropBefore && "border-t-2 border-accent-ink")}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="treeitem"
            draggable={!archived && !renaming && onDragStart !== undefined}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragOver={onDragOver}
            onDrop={onDrop}
            aria-level={2}
            aria-selected={current}
            aria-current={current ? "true" : undefined}
            aria-label={`${task.name}, ${agentSummary ?? t("task.noAgent")}${parts.length ? `, ${parts.join(", ")}` : ""}`}
            tabIndex={tabStop ? 0 : -1}
            data-tree-key={taskKey(task.id)}
            data-task={task.id}
            data-state={task.state}
            className={cn(
              "group relative flex min-h-10 cursor-default flex-col justify-center gap-1 rounded-md ps-7 pe-2 py-1.5 hover:bg-surface-2",
              "focus-visible:outline-2 focus-visible:outline-focus",
              current && "bg-surface-3 hover:bg-surface-3",
              (muted || archived) && "opacity-70",
            )}
            onFocus={onFocus}
            onClick={(event) => {
              if ((event.target as HTMLElement).closest("button, input")) return;
              if (!renaming) dispatch(openTaskTab(task.id));
            }}
          >
            {opened && <span aria-hidden className="absolute inset-y-1.5 start-1.5 w-0.5 rounded-full bg-accent-ink" />}
            <div className="flex min-w-0 items-center gap-1.5">
              <StatusDot state={task.state} />
              {renaming ? (
                <RenameField initial={task.name} onDone={onRenamed} />
              ) : (
                <span className="min-w-0 flex-1 truncate text-base">{task.name}</span>
              )}
              {!!task.ahead && (
                <span className="flex shrink-0 items-center text-xs text-muted" aria-hidden>
                  <Icons.ArrowUp size={12} />
                  {task.ahead}
                </span>
              )}
              {!!task.behind && (
                <span className="flex shrink-0 items-center text-xs text-muted" aria-hidden>
                  <Icons.ArrowDown size={12} />
                  {task.behind}
                </span>
              )}
              <TaskPrChips taskId={task.id} />
              <Menu>
                <MenuTrigger asChild>
                  <IconButton
                    size="sm"
                    icon={Icons.Ellipsis}
                    tabIndex={-1}
                    label={t("task.more", { name: task.name })}
                    className="-my-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100"
                  />
                </MenuTrigger>
                <MenuContent align="start">
                  <TaskMenuItems
                    Item={MItem}
                    Separator={MSep}
                    task={task}
                    dispatch={dispatch}
                    onRename={onRename}
                    scripts={scripts}
                  />
                </MenuContent>
              </Menu>
            </div>
            <TaskAgentStatus taskId={task.id} />
            <div className="flex min-w-0 items-center gap-1.5 ps-3.5 text-xs text-muted" aria-hidden>
              <span
                className="flex min-w-0 items-center gap-1 truncate rounded-sm bg-surface-2 px-1 font-mono"
                title={task.uses_main_checkout ? `${task.branch} · ${t("task.mainCheckoutTip")}` : task.branch}
                data-task-branch={task.branch}
              >
                <Icons.GitBranch size={12} className="shrink-0" />
                <span className="truncate">{task.branch}</span>
                {task.uses_main_checkout && <Icons.FolderGit2 size={12} className="shrink-0 text-muted" />}
              </span>
              {!!task.changed_files && (
                <span className="flex shrink-0 items-center gap-0.5">
                  <Icons.FileDiff size={12} />
                  {task.changed_files}
                </span>
              )}
              {task.ports.length > 0 && (
                <span className="shrink-0 rounded-sm bg-surface-2 px-1 font-mono">:{task.ports[0]}</span>
              )}
              {stateLabel && <span className="shrink-0">{stateLabel}</span>}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <TaskMenuItems
            Item={CItem}
            Separator={CSep}
            task={task}
            dispatch={dispatch}
            onRename={onRename}
            scripts={scripts}
          />
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}

/** The status slot: a neutral dot until agents exist (M6); setup and errors already show. */
function StatusDot({ state }: { state: TaskSummary["state"] }) {
  if (state === "setting_up")
    return (
      <Icons.LoaderCircle
        size={12}
        className="shrink-0 animate-spin text-st-working motion-reduce:animate-none"
        aria-hidden
      />
    );
  if (state === "error") return <Icons.TriangleAlert size={12} className="shrink-0 text-st-error" aria-hidden />;
  return <Icons.Circle size={10} className="shrink-0 text-st-off" aria-hidden />;
}

function RenameField({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <Input
      autoFocus
      defaultValue={initial}
      aria-label={t("task.rename")}
      className="h-6 flex-1"
      onFocus={(event) => event.currentTarget.select()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(event.currentTarget.value);
        else if (event.key === "Escape") finish(null);
      }}
      onBlur={(event) => finish(event.currentTarget.value)}
    />
  );
}
