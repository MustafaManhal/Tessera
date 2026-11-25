// The About screen (S-22), shown as a dialog: palette "About Tessera" (`app.about`), its shortcut, or the status bar's
// info button. It calls `app_info` through the typed IPC and shows loading, error (with retry) and the details, with
// "Open logs folder" and "Copy details". Written by worker-1 for M0.4; routed here as a dialog in M1.4.
import { type AppInfo, commands, IpcError, unwrap } from "@tessera/ipc";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  EmptyState,
  Icons,
  t,
  useToast,
} from "@tessera/ui";
import { useCallback, useEffect, useState } from "react";
import { playRecording, pronounceName } from "../native/pronounce";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { setAboutOpen } from "../store/uiSlice";
import { buildErrorReport } from "../diagnostics/report";
import { runAction } from "../actions/registry";
import { Licenses } from "./Licenses";

interface DetailProps {
  label: string;
  value: string;
  /** Paths and versions read better in a mono font; names do not. */
  mono?: boolean;
}

function Detail({ label, value, mono = false }: DetailProps) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className={mono ? "font-mono text-sm break-all select-all" : "text-base break-all"}>{value}</dd>
    </div>
  );
}

/** The name, how to say it, and a button that says it out loud. */
function NameHeader() {
  const { toast } = useToast();
  const hear = () => {
    void playRecording().then((played) => {
      if (!played && !pronounceName()) toast({ kind: "info", title: t("about.pronounceUnavailable") });
    });
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <span className="text-xl font-semibold">Tessera</span>
          <span className="text-base text-muted" lang="en">
            {t("about.pronunciation")}
          </span>
        </div>
        <Button icon={Icons.Volume2} onClick={hear} data-testid="pronounce">
          {t("about.pronounce")}
        </Button>
      </div>
      <p className="text-sm text-muted">{t("about.meaning")}</p>
    </div>
  );
}

/** The About body: loads `app_info` when shown. */
export function About() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setInfo(await unwrap(commands.appInfo()));
    } catch (cause) {
      setInfo(null);
      setError(cause instanceof IpcError ? cause.message : cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <p role="status" className="py-6 text-center text-base text-muted">
        {t("about.loading")}
      </p>
    );
  }

  if (error || !info) {
    return (
      <EmptyState
        icon={Icons.TriangleExclamationPoint}
        message={`${t("about.errorTitle")}. ${error ?? ""}`.trim()}
        action={{ label: t("about.retry"), icon: Icons.RotateCcw, onClick: () => void load() }}
      />
    );
  }

  const build = info.dev_build ? t("about.devBuild") : t("about.releaseBuild");

  const copyDetails = async () => {
    const details = [
      `${t("about.app")}: ${info.name}`,
      `${t("about.version")}: ${info.version}`,
      `${t("about.build")}: ${build}`,
      `${t("about.dataFolder")}: ${info.data_dir}`,
      `${t("about.logsFolder")}: ${info.log_dir}`,
      `${t("about.schema")}: ${info.schema_version}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(details);
      toast({ kind: "success", title: t("about.copied") });
    } catch (cause) {
      toast({
        kind: "error",
        title: t("about.copyFailed"),
        description: cause instanceof Error ? cause.message : undefined,
      });
    }
  };

  const openLogs = async () => {
    try {
      await revealItemInDir(info.log_dir);
    } catch (cause) {
      toast({
        kind: "error",
        title: t("about.openLogsFailed"),
        description: cause instanceof Error ? cause.message : undefined,
      });
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <NameHeader />
      <span className="self-start rounded-full border border-border bg-surface-2 px-2.5 py-0.5 text-sm text-muted">
        {build}
      </span>
      <dl className="flex flex-col gap-3">
        <Detail label={t("about.app")} value={info.name} />
        <Detail label={t("about.version")} value={info.version} mono />
        <Detail label={t("about.dataFolder")} value={info.data_dir} mono />
        <Detail label={t("about.logsFolder")} value={info.log_dir} mono />
        <Detail label={t("about.schema")} value={String(info.schema_version)} mono />
      </dl>
      <Licenses />
      <div className="flex flex-wrap justify-end gap-2">
        <Button icon={Icons.FolderOpen} onClick={() => void openLogs()}>
          {t("about.openLogs")}
        </Button>
        <Button icon={Icons.Copy} onClick={() => void copyDetails()}>
          {t("about.copyDetails")}
        </Button>
        <Button icon={Icons.MessageSquarePlus} onClick={() => runAction("feedback.open")}>
          {t("action.feedback.open")}
        </Button>
        <Button
          icon={Icons.Bug}
          data-copy-report
          onClick={() =>
            void buildErrorReport("")
              .then((report) => navigator.clipboard.writeText(report))
              .then(() => toast({ kind: "success", title: t("diagnostics.reportCopied") }))
              .catch(() => toast({ kind: "error", title: t("about.copyFailed") }))
          }
        >
          {t("diagnostics.copyReport")}
        </Button>
      </div>
    </div>
  );
}

/** The About dialog, opened from the store (`ui.aboutOpen`). */
export function AboutDialog() {
  const open = useAppSelector((state) => state.ui.aboutOpen);
  const dispatch = useAppDispatch();
  return (
    <Dialog open={open} onOpenChange={(next) => dispatch(setAboutOpen(next))}>
      {open && (
        <DialogContent
          className="max-w-xl"
          // While loading, the close button is the only control; focusing it would open its tooltip and the first Esc
          // would close the tooltip instead of the dialog. Focus the dialog itself.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus();
          }}
        >
          <DialogTitle>{t("about.title")}</DialogTitle>
          <DialogDescription className="sr-only">{t("about.title")}</DialogDescription>
          <About />
        </DialogContent>
      )}
    </Dialog>
  );
}

export default About;
