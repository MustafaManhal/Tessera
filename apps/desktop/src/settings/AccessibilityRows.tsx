// Settings, Appearance: reduce motion and screen reader mode (NFR-10). Per device; see accessibility/prefs.ts.
import { Switch, t } from "@tessera/ui";
import { useId } from "react";
import { setAccessibilityPref, useAccessibilityPrefs } from "../accessibility/prefs";

export function AccessibilityRows() {
  const prefs = useAccessibilityPrefs();
  const motionId = useId();
  const readerId = useId();
  return (
    <div className="flex flex-col pt-3" data-accessibility-rows>
      <h4 className="text-sm font-medium">{t("accessibility.title")}</h4>
      <div
        className="flex items-center justify-between gap-4 border-b border-border py-3"
        data-setting="a11y.reduceMotion"
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <label htmlFor={motionId} className="text-base font-medium">
            {t("accessibility.reduceMotion")}
          </label>
          <p className="text-sm text-muted">{t("accessibility.reduceMotionHint")}</p>
        </div>
        <Switch
          id={motionId}
          checked={prefs.reduceMotion}
          onCheckedChange={(on) => setAccessibilityPref("reduceMotion", on)}
        />
      </div>
      <div
        className="flex items-center justify-between gap-4 border-b border-border py-3"
        data-setting="a11y.screenReader"
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <label htmlFor={readerId} className="text-base font-medium">
            {t("accessibility.screenReader")}
          </label>
          <p className="text-sm text-muted">{t("accessibility.screenReaderHint")}</p>
        </div>
        <Switch
          id={readerId}
          checked={prefs.screenReader}
          onCheckedChange={(on) => setAccessibilityPref("screenReader", on)}
        />
      </div>
    </div>
  );
}
