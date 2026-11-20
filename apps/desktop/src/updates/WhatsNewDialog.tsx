// What's new (FR-75): the notes of the running version (the newest entry when the version has none). Opened once after
// an update, it lists every version since the one used before, so skipping releases loses nothing. Also opens from
// the palette and Settings, Updates.
import { commands, unwrap } from "@tessera/ipc";
import { Dialog, DialogContent, DialogDescription, DialogTitle, t } from "@tessera/ui";
import { useEffect, useState } from "react";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { setWhatsNewOpen } from "../store/uiSlice";
import { setWhatsNewSince, whatsNewSince } from "./state";
import { RELEASES, releasesBetween } from "./whatsnew";

export function WhatsNewDialog() {
  const open = useAppSelector((s) => s.ui.whatsNewOpen);
  const dispatch = useAppDispatch();
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    void unwrap(commands.appInfo())
      .then((info) => setVersion(info.version))
      .catch(() => setVersion(null));
  }, [open]);
  const current = RELEASES.find((release) => release.version === version) ?? RELEASES[0];
  const from = whatsNewSince();
  const since = from && version ? releasesBetween(from, version) : [];
  const ordered = since.length > 0 ? since : current ? [current] : [];
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Opened again later (palette, Settings), it shows the running version only.
        if (!next) setWhatsNewSince(null);
        dispatch(setWhatsNewOpen(next));
      }}
    >
      {open && (
        <DialogContent
          className="max-h-[calc(100vh-4rem)] max-w-xl overflow-y-auto"
          data-whats-new
          // The close button would take the focus and its tooltip the first Esc; focus the dialog itself.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus();
          }}
        >
          <DialogTitle>{t("whatsNew.title")}</DialogTitle>
          <DialogDescription className="sr-only">{t("whatsNew.title")}</DialogDescription>
          {ordered.map((release) => (
            <section key={release.version} className="flex flex-col gap-1" data-release={release.version}>
              <h3 className="m-0 text-base font-semibold">
                {t("whatsNew.version", { version: release.version })}
                <span className="ms-2 text-xs font-normal text-muted">{release.date}</span>
              </h3>
              <ul className="m-0 flex list-disc flex-col gap-1 ps-5 text-sm">
                {release.highlights.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          ))}
        </DialogContent>
      )}
    </Dialog>
  );
}
