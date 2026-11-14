// Gates the first-run wizard: renders <Onboarding/> until `onboarding_done` is set in kv.

import { useEffect, useState } from "react";
import { onboarding } from "./client";
import { type ComponentType, lazy, Suspense } from "react";

// First run only: the wizard is not part of the start bundle.
const Onboarding: ComponentType<{ onDone: () => void }> = lazy(() =>
  import("./Onboarding").then((m) => ({ default: m.Onboarding })),
);

export function OnboardingHost() {
  const [needed, setNeeded] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    void onboarding()
      .onboardingState()
      .then((state) => {
        if (alive) setNeeded(!state.done);
      })
      .catch(() => {
        if (alive) setNeeded(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Also watch for a reset from Settings → "Run setup again" (same-window flag flip).
  useEffect(() => {
    const onReset = () => setNeeded(true);
    window.addEventListener("tessera:onboarding-reset", onReset);
    return () => window.removeEventListener("tessera:onboarding-reset", onReset);
  }, []);

  if (needed !== true) return null;
  return (
    <Suspense fallback={null}>
      <Onboarding onDone={() => setNeeded(false)} />
    </Suspense>
  );
}
