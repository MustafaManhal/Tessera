// Add project (FR-26): a folder (typed, pasted or dropped; recent folders as shortcuts), a clone URL with progress and
// Cancel, or a repository on an SSH host (M10.2, FR-63). A folder that is not a git repo offers `git init`. Browse uses
// the dialog plugin behind `folderPicker()`.
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Icons,
  Input,
  Select,
  t,
} from "@tessera/ui";
import { useEffect, useState } from "react";
import { folderPicker } from "../../native/dialog";
import { notifications } from "../../notify";
import { useAppDispatch } from "../../store/hooks";
import { announce } from "../../store/uiSlice";
import { mapProjectsError, type ProjectsError } from "../errors";
import { projectsClient } from "../service";
import { sshClient } from "../../ssh/service";
import type { SshHostInfo } from "../../ssh/types";
import { addProject, addRemoteProject, initAndAddProject, updateProject } from "../thunks";
import type { WorkMode } from "../types";
import { Field, FormError, errorText } from "./Field";

type Tab = "folder" | "clone" | "ssh";
const TABS: Tab[] = ["folder", "clone", "ssh"];
const TAB_LABEL = { folder: "addProject.tabFolder", clone: "addProject.tabClone", ssh: "addProject.tabSsh" } as const;
const RECENT_KEY = "tessera.recentFolders";
const RECENT_MAX = 5;

function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string").slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

function rememberFolder(path: string): void {
  try {
    const next = [path, ...readRecent().filter((entry) => entry !== path)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Private window or blocked storage: recent folders are a convenience only.
  }
}

export function AddProjectDialog({ onClose }: { onClose: () => void }) {
  const dispatch = useAppDispatch();
  const [tab, setTab] = useState<Tab>("folder");
  const [path, setPath] = useState("");
  const [url, setUrl] = useState("");
  const [cloneDir, setCloneDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ProjectsError | null>(null);
  const [progress, setProgress] = useState<{ percent: number | null; message: string } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [mode, setMode] = useState<WorkMode>("worktrees");
  const [recent] = useState(readRecent);
  const [hosts, setHosts] = useState<SshHostInfo[] | null>(null);
  const [hostId, setHostId] = useState("");
  const [remotePath, setRemotePath] = useState("");
  // A callback ref: the dialog content mounts in a portal, after this component's first effect.
  const [zone, setZone] = useState<HTMLDivElement | null>(null);

  // A folder dropped on the dialog (native drop) fills the path.
  useEffect(() => {
    const element = zone;
    if (!element) return;
    const onDrop = (event: Event) => {
      const [first] = (event as CustomEvent<string[]>).detail;
      if (first) {
        setTab("folder");
        setPath(first);
        setFailure(null);
      }
    };
    element.addEventListener("tessera:folder-drop", onDrop);
    return () => element.removeEventListener("tessera:folder-drop", onDrop);
  }, [zone]);

  useEffect(() => {
    let cancelled = false;
    void sshClient()
      .list()
      .then((list) => {
        if (cancelled) return;
        setHosts(list);
        setHostId((current) => current || (list[0]?.id ?? ""));
      })
      .catch(() => !cancelled && setHosts([]));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let off: (() => void) | null = null;
    let cancelled = false;
    void projectsClient()
      .onCloneProgress((event) => setProgress(event))
      .then((stop) => {
        if (cancelled) stop();
        else off = stop;
      });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  /** Applies the chosen way of working to the project that was just added (worktrees is the default). */
  const applyMode = async (project: { id: string }) => {
    if (mode !== "branches") return;
    await dispatch(updateProject(project.id, { work_mode: "branches" })).catch(() => {});
  };

  const finish = (name: string, folder: string | null) => {
    if (folder) rememberFolder(folder);
    dispatch(announce(t("addProject.added", { name })));
    notifications().toastNow({ title: t("addProject.added", { name }) });
    onClose();
  };

  const submitFolder = async (init: boolean) => {
    const folder = path.trim();
    if (folder === "") {
      setFailure(null);
      setHint(t("form.required"));
      return;
    }
    setHint(null);
    setBusy(true);
    setFailure(null);
    try {
      const project = await dispatch(init ? initAndAddProject(folder) : addProject({ path: folder }));
      await applyMode(project);
      finish(project.name, folder);
    } catch (cause) {
      setFailure(mapProjectsError(cause));
      setBusy(false);
    }
  };

  const submitClone = async () => {
    if (url.trim() === "") {
      setHint(t("form.required"));
      return;
    }
    setHint(null);
    setBusy(true);
    setFailure(null);
    setProgress({ percent: 0, message: "" });
    try {
      const project = await dispatch(
        addProject({ clone_url: url.trim(), ...(cloneDir.trim() ? { clone_dir: cloneDir.trim() } : {}) }),
      );
      await applyMode(project);
      finish(project.name, project.path);
    } catch (cause) {
      const error = mapProjectsError(cause);
      // Cancelling is the user's own choice, not an error.
      setFailure(error.kind === "Cancelled" ? null : error);
      setBusy(false);
      setProgress(null);
    }
  };

  const submitRemote = async () => {
    if (hostId === "" || remotePath.trim() === "") {
      setHint(t("form.required"));
      return;
    }
    setHint(null);
    setBusy(true);
    setFailure(null);
    try {
      const project = await dispatch(addRemoteProject({ host_id: hostId, path: remotePath.trim() }));
      await applyMode(project);
      finish(project.name, null);
    } catch (cause) {
      setFailure(mapProjectsError(cause));
      setBusy(false);
    }
  };

  const submit = () => {
    if (tab === "clone") return submitClone();
    if (tab === "ssh") return submitRemote();
    return submitFolder(false);
  };

  const cancelClone = async () => {
    try {
      await projectsClient().cancelClone();
    } catch (cause) {
      setFailure(mapProjectsError(cause));
    }
  };

  const canInit = failure?.kind === "NotAGitRepo";

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-lg" aria-describedby="add-project-description">
        <DialogTitle>{t("addProject.title")}</DialogTitle>
        <DialogDescription id="add-project-description">{t("addProject.description")}</DialogDescription>
        <div ref={setZone} data-drop-folder className="flex flex-col gap-3">
          <div role="tablist" aria-label={t("addProject.title")} className="flex gap-1 border-b border-border">
            {TABS.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`add-tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`add-panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                disabled={busy}
                className="h-8 cursor-default border-b-2 border-transparent px-3 text-base text-muted aria-selected:border-accent-ink aria-selected:text-fg"
                onClick={() => {
                  setTab(id);
                  setFailure(null);
                  setHint(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                    event.preventDefault();
                    const step = event.key === "ArrowRight" ? 1 : TABS.length - 1;
                    const next = TABS[(TABS.indexOf(id) + step) % TABS.length] ?? "folder";
                    setTab(next);
                    document.getElementById(`add-tab-${next}`)?.focus();
                  }
                }}
              >
                {t(TAB_LABEL[id])}
              </button>
            ))}
          </div>
          {tab === "folder" ? (
            <div role="tabpanel" id="add-panel-folder" aria-labelledby="add-tab-folder" className="flex flex-col gap-2">
              <Field label={t("addProject.folder")} hint={t("addProject.folderHint")} error={hint}>
                {({ id, describedBy }) => (
                  <div className="flex gap-2">
                    <Input
                      id={id}
                      autoFocus
                      value={path}
                      disabled={busy}
                      invalid={hint !== null}
                      aria-describedby={describedBy}
                      placeholder="/Users/you/code/project"
                      spellCheck={false}
                      onChange={(event) => {
                        setPath(event.target.value);
                        setFailure(null);
                        setHint(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void submitFolder(false);
                      }}
                    />
                    <Button
                      icon={Icons.FolderOpen}
                      disabled={busy}
                      onClick={() => {
                        void folderPicker()
                          .pickFolder({ title: t("addProject.browse") })
                          .then((picked) => {
                            if (picked === null) return;
                            setPath(picked);
                            setFailure(null);
                            setHint(null);
                          });
                      }}
                    >
                      {t("addProject.browse")}
                    </Button>
                  </div>
                )}
              </Field>
              {recent.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted">{t("addProject.recent")}</span>
                  <div className="flex flex-wrap gap-1">
                    {recent.map((folder) => (
                      <Button key={folder} size="sm" disabled={busy} onClick={() => setPath(folder)}>
                        {folder}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              {failure && canInit && (
                <div
                  className="flex flex-col gap-2 rounded-md border border-border bg-st-needs-tint px-3 py-2 text-sm"
                  role="alert"
                  data-init-offer
                >
                  <span>{failure.extra.canInit ? t("addProject.notARepo") : t("addProject.notARepoNoInit")}</span>
                  {failure.extra.canInit && (
                    <div>
                      <Button size="sm" icon={Icons.GitBranch} disabled={busy} onClick={() => void submitFolder(true)}>
                        {t("addProject.init")}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : tab === "ssh" ? (
            <div
              role="tabpanel"
              id="add-panel-ssh"
              aria-labelledby="add-tab-ssh"
              className="flex flex-col gap-2"
              data-add-remote
            >
              {hosts !== null && hosts.length === 0 ? (
                <p className="text-sm text-muted">{t("addProject.sshNoHosts")}</p>
              ) : (
                <>
                  <Field label={t("addProject.sshHost")}>
                    {({ id }) => (
                      <Select
                        id={id}
                        value={hostId}
                        disabled={busy || hosts === null}
                        onValueChange={(value) => {
                          setHostId(value);
                          setFailure(null);
                        }}
                        options={(hosts ?? []).map((host) => ({
                          value: host.id,
                          label: host.user
                            ? `${host.alias} (${host.user}@${host.host})`
                            : `${host.alias} (${host.host})`,
                        }))}
                      />
                    )}
                  </Field>
                  <Field label={t("addProject.sshPath")} hint={t("addProject.sshPathHint")} error={hint}>
                    {({ id, describedBy }) => (
                      <Input
                        id={id}
                        autoFocus
                        value={remotePath}
                        disabled={busy}
                        invalid={hint !== null}
                        aria-describedby={describedBy}
                        placeholder="~/code/project"
                        spellCheck={false}
                        onChange={(event) => {
                          setRemotePath(event.target.value);
                          setFailure(null);
                          setHint(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void submitRemote();
                        }}
                      />
                    )}
                  </Field>
                </>
              )}
            </div>
          ) : (
            <div role="tabpanel" id="add-panel-clone" aria-labelledby="add-tab-clone" className="flex flex-col gap-2">
              <Field label={t("addProject.cloneUrl")} hint={t("addProject.cloneUrlHint")} error={hint}>
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    autoFocus
                    value={url}
                    disabled={busy}
                    invalid={hint !== null}
                    aria-describedby={describedBy}
                    spellCheck={false}
                    onChange={(event) => {
                      setUrl(event.target.value);
                      setHint(null);
                      setFailure(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void submitClone();
                    }}
                  />
                )}
              </Field>
              <Field label={t("addProject.cloneInto")}>
                {({ id }) => (
                  <div className="flex gap-2">
                    <Input
                      id={id}
                      value={cloneDir}
                      disabled={busy}
                      placeholder="/Users/you/code"
                      spellCheck={false}
                      onChange={(event) => setCloneDir(event.target.value)}
                    />
                    <Button
                      icon={Icons.FolderOpen}
                      disabled={busy}
                      onClick={() => {
                        void folderPicker()
                          .pickFolder({ title: t("addProject.browse") })
                          .then((picked) => {
                            if (picked !== null) setCloneDir(picked);
                          });
                      }}
                    >
                      {t("addProject.browse")}
                    </Button>
                  </div>
                )}
              </Field>
              {busy && progress && (
                <div className="flex flex-col gap-1" data-clone-progress>
                  <progress
                    aria-label={t("addProject.cloneProgress")}
                    className="h-2 w-full overflow-hidden rounded-full accent-accent"
                    max={100}
                    {...(progress.percent === null ? {} : { value: progress.percent })}
                  />
                  <span className="text-xs text-muted" aria-live="polite">
                    {progress.message || t("addProject.cloning")}
                  </span>
                </div>
              )}
            </div>
          )}
          <Field label={t("addProject.mode")}>
            {({ id, describedBy }) => (
              <Select
                id={id}
                value={mode}
                aria-describedby={describedBy}
                disabled={busy}
                options={[
                  { value: "worktrees", label: t("addProject.modeWorktrees") },
                  { value: "branches", label: t("addProject.modeBranches") },
                ]}
                onValueChange={(next) => setMode(next === "branches" ? "branches" : "worktrees")}
              />
            )}
          </Field>
          {failure && !(canInit && tab === "folder") && <FormError message={errorText(failure)} />}
        </div>
        <DialogFooter>
          {busy && tab === "clone" ? (
            <Button onClick={() => void cancelClone()}>{t("addProject.cancelClone")}</Button>
          ) : (
            <Button onClick={onClose}>{t("form.cancel")}</Button>
          )}
          <Button
            variant="primary"
            icon={tab === "clone" ? Icons.Download : Icons.FolderPlus}
            disabled={busy || (tab === "ssh" && (hosts === null || hosts.length === 0))}
            onClick={() => void submit()}
          >
            {busy
              ? t(tab === "clone" ? "addProject.cloning" : "addProject.adding")
              : t(tab === "clone" ? "addProject.clone" : "addProject.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
