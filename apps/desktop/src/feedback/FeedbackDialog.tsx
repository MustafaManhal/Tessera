// biome-ignore-all lint/a11y/useSemanticElements: the kind picker is a segmented control of icon buttons (the APG radio group pattern on buttons).
// Send feedback: report a problem, suggest a feature, ask for a better look, with screenshots. Nothing is sent until the
// person presses Send, the dialog shows what goes along (the optional technical details can be read first), no account
// is needed and the contact field is optional. If the server cannot be reached the same text can go to GitHub instead.
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Icons,
  Input,
  Switch,
  t,
} from "@tessera/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { buildErrorReport } from "../diagnostics/report";
import { Field, FormError, TextArea } from "../projects/dialogs/Field";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { announce, setFeedbackOpen } from "../store/uiSlice";
import { openExternal } from "../terminal/open";
import { isImageFile, MAX_SCREENSHOTS, shrinkImage } from "./images";
import { issueUrl } from "./issueUrl";
import { feedbackClient } from "./service";
import { type FeedbackAttachment, FeedbackError, type FeedbackKind } from "./types";

const KINDS: {
  kind: FeedbackKind;
  label: "feedback.kind.bug" | "feedback.kind.idea" | "feedback.kind.design" | "feedback.kind.other";
  icon: typeof Icons.Bug;
}[] = [
  { kind: "bug", label: "feedback.kind.bug", icon: Icons.Bug },
  { kind: "idea", label: "feedback.kind.idea", icon: Icons.Lightbulb },
  { kind: "design", label: "feedback.kind.design", icon: Icons.Palette },
  { kind: "other", label: "feedback.kind.other", icon: Icons.MessageSquare },
];

interface Shot extends FeedbackAttachment {
  id: number;
  url: string;
}

export function FeedbackDialog() {
  const open = useAppSelector((s) => s.ui.feedbackOpen);
  return open ? <Form /> : null;
}

function Form() {
  const dispatch = useAppDispatch();
  const close = useCallback(() => dispatch(setFeedbackOpen(false)), [dispatch]);
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [contact, setContact] = useState("");
  const [includeReport, setIncludeReport] = useState(true);
  const [showReport, setShowReport] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [shotError, setShotError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code: string } | null>(null);
  const [sentId, setSentId] = useState<string | null>(null);
  const nextShot = useRef(1);
  // The count of attached screenshots as of now, so several files added at once are counted one by one.
  const shotCount = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const switchId = useId();

  // Technical details default to on for a problem and off for an idea.
  useEffect(() => setIncludeReport(kind === "bug"), [kind]);
  useEffect(() => {
    if (!showReport || report !== null) return;
    void buildErrorReport("").then(setReport);
  }, [showReport, report]);
  // Thumbnails keep their address until the form closes (not each time the list changes).
  const latestShots = useRef<Shot[]>([]);
  latestShots.current = shots;
  useEffect(
    () => () => {
      for (const shot of latestShots.current) URL.revokeObjectURL(shot.url);
    },
    [],
  );

  const addFiles = useCallback(async (files: File[]) => {
    setShotError(null);
    const images = files.filter(isImageFile);
    if (images.length === 0 && files.length > 0) return setShotError(t("feedback.shotNotImage"));
    for (const file of images) {
      if (shotCount.current >= MAX_SCREENSHOTS) return setShotError(t("feedback.shotMax", { count: MAX_SCREENSHOTS }));
      shotCount.current += 1;
      try {
        const shrunk = await shrinkImage(file);
        const url = URL.createObjectURL(file);
        setShots((current) => [...current, { ...shrunk, id: nextShot.current++, url }]);
      } catch (cause) {
        shotCount.current -= 1;
        setShotError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  }, []);

  const ready = title.trim().length >= 3 && body.trim().length >= 10;

  const send = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const sent = await feedbackClient().send({
        kind,
        title: title.trim(),
        body: body.trim(),
        contact: contact.trim(),
        include_report: includeReport,
        attachments: shots.map(({ name, mime, data_base64 }) => ({ name, mime, data_base64 })),
      });
      setSentId(sent.id);
      dispatch(announce(t("feedback.sentAnnounce")));
    } catch (cause) {
      const error = cause as FeedbackError;
      setFailure({
        message: error.message || String(cause),
        code: error instanceof FeedbackError ? error.code : "feedback.network",
      });
    } finally {
      setBusy(false);
    }
  };

  const openOnGithub = async () => {
    const text = includeReport ? (report ?? (await buildErrorReport(""))) : "";
    await openExternal(issueUrl({ kind, title, body, report: text }));
  };

  const copyText = async () => {
    const text = includeReport ? (report ?? (await buildErrorReport(""))) : "";
    await navigator.clipboard.writeText(`${title}\n\n${body}${text ? `\n\n${text}` : ""}`).catch(() => {});
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && close()}>
      <DialogContent
        className="max-h-[calc(100vh-3rem)] max-w-xl overflow-y-auto"
        data-feedback-dialog
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void addFiles([...event.dataTransfer.files]);
        }}
        onPaste={(event) => {
          const images = [...event.clipboardData.files].filter(isImageFile);
          if (images.length > 0) {
            event.preventDefault();
            void addFiles(images);
          }
        }}
      >
        {sentId ? (
          <div className="flex flex-col gap-3" data-feedback-sent>
            <DialogTitle>{t("feedback.thanksTitle")}</DialogTitle>
            <DialogDescription>{t("feedback.thanksBody")}</DialogDescription>
            <p className="m-0 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm">
              {t("feedback.reference")}{" "}
              <span className="font-mono" data-feedback-id>
                {sentId}
              </span>
            </p>
            <DialogFooter>
              <Button variant="primary" onClick={close}>
                {t("feedback.done")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (ready && !busy) void send();
            }}
          >
            <div>
              <DialogTitle>{t("feedback.title")}</DialogTitle>
              <DialogDescription className="mt-1">{t("feedback.intro")}</DialogDescription>
            </div>
            <div
              role="radiogroup"
              aria-label={t("feedback.kind")}
              className="grid grid-cols-2 gap-2 sm:grid-cols-4"
              data-feedback-kinds
            >
              {KINDS.map((item) => {
                const on = item.kind === kind;
                return (
                  <button
                    key={item.kind}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    data-feedback-kind={item.kind}
                    onClick={() => setKind(item.kind)}
                    className={`flex cursor-pointer flex-col items-center gap-1 rounded-md border px-2 py-2 text-sm ${on ? "border-accent-ink bg-accent/10 text-fg" : "border-border bg-surface-2 text-muted hover:text-fg"}`}
                  >
                    <item.icon size={16} aria-hidden />
                    {t(item.label)}
                  </button>
                );
              })}
            </div>
            <Field label={t("feedback.summary")}>
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  autoFocus
                  maxLength={140}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              )}
            </Field>
            <Field label={t("feedback.details")} hint={t(`feedback.detailsHint.${kind}` as "feedback.detailsHint.bug")}>
              {({ id, describedBy }) => (
                <TextArea
                  id={id}
                  aria-describedby={describedBy}
                  className="min-h-28"
                  maxLength={8000}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              )}
            </Field>
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{t("feedback.screenshots")}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={Icons.ImagePlus}
                  disabled={shots.length >= MAX_SCREENSHOTS}
                  onClick={() => fileInput.current?.click()}
                >
                  {t("feedback.addScreenshot")}
                </Button>
                <span className="text-xs text-muted">{t("feedback.screenshotsHint", { count: MAX_SCREENSHOTS })}</span>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  data-feedback-file
                  onChange={(event) => {
                    void addFiles([...(event.target.files ?? [])]);
                    event.target.value = "";
                  }}
                />
              </div>
              {shots.length > 0 && (
                <ul className="m-0 flex list-none flex-wrap gap-2 p-0" data-feedback-shots>
                  {shots.map((shot) => (
                    <li key={shot.id} className="relative" data-feedback-shot>
                      <img
                        src={shot.url}
                        alt={shot.name}
                        className="h-20 w-32 rounded-md border border-border object-cover"
                      />
                      <button
                        type="button"
                        aria-label={t("feedback.removeScreenshot", { name: shot.name })}
                        className="absolute -end-1.5 -top-1.5 flex size-5 cursor-pointer items-center justify-center rounded-full border border-border bg-surface text-fg"
                        onClick={() => {
                          shotCount.current -= 1;
                          setShots((current) => current.filter((s) => s.id !== shot.id));
                        }}
                      >
                        <Icons.X size={12} aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {shotError && (
                <p role="alert" data-feedback-shot-error className="m-0 text-xs text-danger">
                  {shotError}
                </p>
              )}
            </div>
            <Field label={t("feedback.contact")} hint={t("feedback.contactHint")}>
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  maxLength={200}
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                />
              )}
            </Field>
            <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-2 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <label htmlFor={switchId} className="text-sm font-medium">
                    {t("feedback.includeReport")}
                  </label>
                  <span className="text-xs text-muted">{t("feedback.includeReportHint")}</span>
                </div>
                <Switch id={switchId} checked={includeReport} onCheckedChange={setIncludeReport} />
              </div>
              <button
                type="button"
                data-feedback-preview
                aria-expanded={showReport}
                className="cursor-pointer self-start border-0 bg-transparent p-0 text-xs text-accent-ink underline"
                onClick={() => setShowReport((v) => !v)}
              >
                {showReport ? t("feedback.hideReport") : t("feedback.showReport")}
              </button>
              {showReport && (
                <pre
                  className="m-0 max-h-40 overflow-auto whitespace-pre-wrap rounded-sm bg-surface p-2 font-mono text-xs"
                  data-feedback-report
                >
                  {report ?? t("button.loading")}
                </pre>
              )}
            </div>
            <p className="m-0 text-xs text-muted">{t("feedback.privacy")}</p>
            {failure && (
              <div
                role="alert"
                data-feedback-error={failure.code}
                className="flex flex-col gap-2 rounded-md border border-border bg-st-error-tint px-3 py-2 text-sm"
              >
                <span>{failure.message}</span>
                {(failure.code === "feedback.network" || failure.code === "feedback.too_many") && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={Icons.ExternalLink}
                      data-feedback-github
                      onClick={() => void openOnGithub()}
                    >
                      {t("feedback.openGithub")}
                    </Button>
                    <Button size="sm" variant="ghost" icon={Icons.Copy} onClick={() => void copyText()}>
                      {t("feedback.copyText")}
                    </Button>
                  </div>
                )}
              </div>
            )}
            <FormError message={null} />
            <DialogFooter>
              <Button variant="ghost" disabled={busy} onClick={close}>
                {t("button.cancel")}
              </Button>
              <Button variant="primary" type="submit" icon={Icons.Send} disabled={!ready || busy} data-feedback-send>
                {busy ? t("feedback.sending") : t("feedback.send")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
