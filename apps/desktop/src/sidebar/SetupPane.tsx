// The "setup" pane of a task tab (S-02 states, FR-28): a terminal in the task's worktree with the project's setup
// script in front of it until the user decides. Approving stores the script's hash (`project_approve_setup`) and runs
// the script in this terminal; Skip leaves the terminal alone. A failure shows its exit code and leaves the tab usable.
import { Button, Icons, t } from "@tessera/ui";
import { type Ref, useEffect, useRef, useState } from "react";
import { approveSetup } from "../projects/thunks";
import { mapProjectsError } from "../projects/errors";
import type { PaneContentHandle, PaneContentProps } from "../shell/pane/PaneContent";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { setupPhase } from "../store/projectsSlice";
import { paneTerminal } from "../terminal/panes";
import { TerminalPane } from "../terminal/TerminalPane";

export function SetupPane(props: PaneContentProps & { ref?: Ref<PaneContentHandle> }) {
  const { paneId, info } = props;
  const taskId = info.taskId ?? "";
  const dispatch = useAppDispatch();
  const setup = useAppSelector((state) => state.projects.setups[taskId]);
  const task = useAppSelector((state) => state.projects.tasks[taskId]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  /** The id of the last block before the script ran: only later blocks are the script's. */
  const baseline = useRef(0);

  // The script runs in this pane's terminal once it exists. It is over when a block that began after the start has
  // finished and no newer one appears for a moment (a script with several lines is several blocks).
  const phase = setup?.phase;
  useEffect(() => {
    if (phase !== "running") return;
    let last = -1;
    const timer = setInterval(() => {
      if (!started.current) return;
      const block = paneTerminal(paneId)?.blocks.current();
      if (!block || block.id <= baseline.current) return;
      const finished = block.status === "success" || block.status === "failure";
      if (!finished) {
        last = -1;
        return;
      }
      if (last === block.id) {
        clearInterval(timer);
        dispatch(setupPhase({ taskId, phase: block.exitCode ? "failed" : "done", exitCode: block.exitCode ?? 0 }));
      }
      last = block.id;
    }, 150);
    return () => clearInterval(timer);
  }, [phase, paneId, taskId, dispatch]);
  useEffect(() => {
    if (phase !== "running" || started.current || !setup?.info.script) return;
    const script = setup.info.script;
    let cancelled = false;
    const tick = () => {
      const terminal = paneTerminal(paneId);
      if (cancelled) return;
      if (!terminal) {
        setTimeout(tick, 50);
        return;
      }
      started.current = true;
      baseline.current = terminal.blocks.current()?.id ?? 0;
      terminal.insert(`${script.replace(/\r?\n/g, "\r")}\r`);
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [phase, setup?.info.script, paneId]);

  const approve = async () => {
    if (!task) return;
    setBusy(true);
    setError(null);
    try {
      await dispatch(approveSetup(task.project_id));
      dispatch(setupPhase({ taskId, phase: "running" }));
    } catch (cause) {
      setError(t("setup.approveFailed", { message: mapProjectsError(cause).message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative h-full min-h-0">
      <TerminalPane {...props} />
      {setup && phase === "approve" && (
        <section
          aria-label={t("setup.title")}
          data-setup-approval
          className="absolute inset-x-3 top-3 z-10 flex max-h-[calc(100%-1.5rem)] flex-col gap-2 overflow-auto rounded-lg border border-border bg-surface p-3 text-base text-fg shadow-popover"
        >
          <div className="flex items-center gap-2 font-medium">
            <Icons.ShieldAlert size={16} className="shrink-0 text-st-needs" aria-hidden />
            {t("setup.title")}
          </div>
          <p className="text-sm text-muted">{t("setup.explain")}</p>
          <pre className="max-h-32 overflow-auto rounded-md border border-border bg-surface-2 p-2 font-mono text-sm whitespace-pre-wrap break-all">
            {setup.info.script}
          </pre>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>{t("setup.shell", { shell: setup.info.shell ?? "sh" })}</span>
            <code className="rounded-sm bg-surface-2 px-1 py-0.5 font-mono">
              {t("setup.hash", { hash: setup.info.hash ?? "" })}
            </code>
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" onClick={() => dispatch(setupPhase({ taskId, phase: "skipped" }))}>
              {t("setup.skip")}
            </Button>
            <Button size="sm" variant="primary" icon={Icons.Play} disabled={busy} onClick={() => void approve()}>
              {t("setup.approve")}
            </Button>
          </div>
        </section>
      )}
      {setup && phase && phase !== "approve" && (
        <output
          data-setup-status={phase}
          className="absolute inset-x-3 bottom-3 z-10 flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg shadow-popover"
        >
          {phase === "running" && (
            <Icons.LoaderCircle
              size={14}
              className="animate-spin text-st-working motion-reduce:animate-none"
              aria-hidden
            />
          )}
          {phase === "done" && <Icons.Check size={14} className="text-st-done" aria-hidden />}
          {phase === "failed" && <Icons.TriangleAlert size={14} className="text-st-error" aria-hidden />}
          {phase === "skipped" && <Icons.SkipForward size={14} className="text-muted" aria-hidden />}
          <span className="min-w-0 flex-1">
            {phase === "running"
              ? t("setup.running")
              : phase === "done"
                ? t("setup.done")
                : phase === "failed"
                  ? t("setup.failed", { code: setup.exitCode ?? "?" })
                  : t("setup.skipped")}
          </span>
        </output>
      )}
    </div>
  );
}
