// Settings that are app-local or OS-specific: restoring tabs at start and secure keyboard entry on macOS.
import { Button, getPlatform, Switch, t } from "@tessera/ui";
import { useId } from "react";
import { runAction } from "../actions/registry";
import { isNativeRuntime } from "../native/runtime";
import { saveRestoreSetting } from "../restore/service";
import { onboarding } from "../onboarding/client";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { setRestoreSession } from "../store/settingsSlice";

export function AppLocalRows() {
  const id = useId();
  const secureId = useId();
  const enabled = useAppSelector((state) => state.settings.restoreSession);
  const secureKeyboardEntry = useAppSelector((state) => state.settings.terminal.secureKeyboardEntry);
  const dispatch = useAppDispatch();
  const platform = getPlatform();
  return (
    <>
      <div
        data-setting="window.restore"
        className="flex items-center justify-between gap-4 border-b border-border py-4"
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <label htmlFor={id} className="text-base font-medium">
            {t("restore.setting")}
          </label>
          <p className="text-sm text-muted">{t("restore.settingHint")}</p>
        </div>
        <Switch
          id={id}
          checked={enabled}
          onCheckedChange={(checked) => {
            saveRestoreSetting(checked);
            dispatch(setRestoreSession(checked));
          }}
        />
      </div>
      <div
        data-setting="onboarding.runAgain"
        className="flex items-center justify-between gap-4 border-b border-border py-4"
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-base font-medium">{t("onboarding.runAgain")}</p>
          <p className="text-sm text-muted">{t("onboarding.welcomeLine")}</p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            void onboarding()
              .onboardingReset()
              .then(() => window.dispatchEvent(new Event("tessera:onboarding-reset")));
          }}
        >
          {t("onboarding.runAgain")}
        </Button>
      </div>
      {platform === "mac" && isNativeRuntime() && (
        <div
          data-setting="terminal.secure_keyboard_entry"
          className="flex items-center justify-between gap-4 border-b border-border py-4"
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            <label htmlFor={secureId} className="text-base font-medium">
              {t("settings.secureKeyboardEntry")}
            </label>
            <p className="text-sm text-muted">{t("settings.secureKeyboardEntryHint")}</p>
          </div>
          <Switch
            id={secureId}
            checked={secureKeyboardEntry}
            onCheckedChange={() => runAction("terminal.secureKeyboardEntry")}
          />
        </div>
      )}
    </>
  );
}
