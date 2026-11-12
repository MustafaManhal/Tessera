// Keeps the update state current (a check on start finds a pending update, the background checker announces new
// ones, installs report progress) and opens What's new once after an update. Renders nothing.
import { commands, unwrap } from "@tessera/ipc";
import { useEffect } from "react";
import { useAppDispatch } from "../store/hooks";
import { setWhatsNewOpen } from "../store/uiSlice";
import { updatesClient } from "./service";
import { setUpdateView } from "./state";
import { notesFor } from "./whatsnew";

const SEEN_KEY = "tessera.lastSeenVersion";

export function UpdatesHost() {
  const dispatch = useAppDispatch();
  useEffect(() => {
    const client = updatesClient();
    void client
      .pending()
      .then((pending) => setUpdateView({ pending }))
      .catch(() => {});
    const stopAvailable = client.onAvailable((pending) => setUpdateView({ pending, installed: false }));
    const stopProgress = client.onProgress((progress) => setUpdateView({ progress: progress.done ? null : progress }));
    // After an update the first start shows the notes of the new version, once. A first run only records the version.
    void unwrap(commands.appInfo())
      .then((info) => {
        try {
          const seen = window.localStorage.getItem(SEEN_KEY);
          window.localStorage.setItem(SEEN_KEY, info.version);
          if (seen && seen !== info.version && notesFor(info.version)) dispatch(setWhatsNewOpen(true));
        } catch {
          // No storage: no automatic notes.
        }
      })
      .catch(() => {});
    return () => {
      stopAvailable();
      stopProgress();
    };
  }, [dispatch]);
  return null;
}
