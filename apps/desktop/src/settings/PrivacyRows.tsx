// Settings, Advanced: diagnostics and privacy (FR-74). Open the logs folder, copy an error report (never uploaded),
// and the optional anonymous usage statistics switch (off by default, nothing is sent in this version).
import { commands, unwrap } from "@tessera/ipc";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button, Icons, Switch, t, useToast } from "@tessera/ui";
import { useEffect, useId, useState } from "react";
import { buildErrorReport } from "../diagnostics/report";
import { getUsageStats, setUsageStats } from "../diagnostics/privacy";
import { isNativeRuntime } from "../native/runtime";

export function PrivacyRows() {
  const { toast } = useToast();
  const statsId = useId();
  const [stats, setStats] = useState(false);

  useEffect(() => {
    void getUsageStats()
      .then(setStats)
      .catch(() => {});
  }, []);

  const openLogs = async () => {
    try {
      const info = await unwrap(commands.appInfo());
      await revealItemInDir(info.log_dir);
    } catch (cause) {
      toast({
        kind: "error",
        title: t("about.openLogsFailed"),
        description: cause instanceof Error ? cause.message : undefined,
      });
    }
  };
  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(await buildErrorReport(""));
      toast({ kind: "success", title: t("diagnostics.reportCopied") });
    } catch {
      toast({ kind: "error", title: t("about.copyFailed") });
    }
  };

  return (
    <div className="flex flex-col gap-3 pt-3" data-privacy-rows>
      <h4 className="text-sm font-medium">{t("diagnostics.title")}</h4>
      <p className="text-sm text-muted">{t("diagnostics.explain")}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon={Icons.FolderOpen} disabled={!isNativeRuntime()} onClick={() => void openLogs()}>
          {t("about.openLogs")}
        </Button>
        <Button size="sm" icon={Icons.Copy} data-copy-report onClick={() => void copyReport()}>
          {t("diagnostics.copyReport")}
        </Button>
      </div>
      <div
        className="flex items-start justify-between gap-4 border-b border-border pb-3"
        data-setting="privacy.usageStats"
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <label htmlFor={statsId} className="text-base font-medium">
            {t("privacy.usageStats")}
          </label>
          <p className="text-sm text-muted">{t("privacy.usageStatsHint")}</p>
        </div>
        <Switch
          id={statsId}
          checked={stats}
          onCheckedChange={(checked) => {
            setStats(checked);
            void setUsageStats(checked)
              .then(setStats)
              .catch(() => setStats(!checked));
          }}
        />
      </div>
    </div>
  );
}
