// Keeps the update state current (a check on start finds a pending update, the background checker announces new
// ones and downloads them, downloads report progress), asks for a restart when an update is ready, and opens What's
// new once after an update. Renders the restart dialog only.
import { commands, unwrap } from "@tessera/ipc";
import { useEffect } from "react";
import { onboarding } from "../onboarding/client";
import { useAppDispatch } from "../store/hooks";
import { setWhatsNewOpen } from "../store/uiSlice";
import { updatesClient } from "./service";
import { setUpdateView, setWhatsNewSince } from "./state";
import { notesFor } from "./whatsnew";
import { UpdateReadyDialog } from "./UpdateReadyDialog";
import type { UpdateInfo } from "./types";

const SEEN_KEY = "tessera.lastSeenVersion";

export function UpdatesHost() {
  const dispatch = useAppDispatch();
  useEffect(() => {
    const client = updatesClient();
    const ready = (info: UpdateInfo, prompt: boolean) =>
      setUpdateView({
        ready: info,
        installed: true,
        installing: false,
        pending: null,
        progress: null,
        promptOpen: prompt,
      });
    void client
      .ready()
      .then((info) => {
        // Downloaded before this window opened: the chip and Settings offer the restart; no dialog on top of the start.
        if (info) ready(info, false);
        else
          return client.pending().then((pending) => {
            if (pending) setUpdateView({ pending });
          });
      })
      .catch(() => {});
    const stopAvailable = client.onAvailable((pending) => setUpdateView({ pending, installed: false }));
    const stopReady = client.onReady((info) => ready(info, true));
    const stopProgress = client.onProgress((progress) =>
      setUpdateView(progress.done ? { progress: null } : { progress, installing: true }),
    );
    // After an update the first start shows the notes of every version since the last one seen, once. A first run only records the version.
    void unwrap(commands.appInfo())
      .then((info) => {
        try {
          const seen = window.localStorage.getItem(SEEN_KEY);
          window.localStorage.setItem(SEEN_KEY, info.version);
          if (seen && seen !== info.version && notesFor(info.version)) {
            // Never on top of the first-run wizard: someone setting Tessera up does not need the release notes.
            void onboarding()
              .onboardingState()
              .then((state) => {
                if (!state.done) return;
                setWhatsNewSince(seen);
                dispatch(setWhatsNewOpen(true));
              })
              .catch(() => {});
          }
        } catch {
          // No storage: no automatic notes.
        }
      })
      .catch(() => {});
    return () => {
      stopAvailable();
      stopReady();
      stopProgress();
    };
  }, [dispatch]);
  return <UpdateReadyDialog />;
}
