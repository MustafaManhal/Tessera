// Small form pieces shared by the project dialogs: a labelled field with hint and inline error, a textarea in the
// design system's field style, and the error banner for a failed command.
import { cn, t } from "@tessera/ui";
import { type ComponentProps, type ReactNode, useId } from "react";
import { errorTitleKey, type ProjectsError } from "../errors";

interface FieldProps {
  label: string;
  /** The control; receives the ids to link the label, hint and error. */
  children: (ids: { id: string; describedBy: string }) => ReactNode;
  hint?: string;
  error?: string | null;
  className?: string;
}

export function Field({ label, children, hint, error, className }: FieldProps) {
  const id = useId();
  const describedBy = `${id}-note`;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children({ id, describedBy })}
      <p
        id={describedBy}
        className={cn("min-h-4 text-xs", error ? "text-danger" : "text-muted")}
        role={error ? "alert" : undefined}
      >
        {error ?? hint ?? ""}
      </p>
    </div>
  );
}

export function TextArea({ invalid = false, className, ...props }: ComponentProps<"textarea"> & { invalid?: boolean }) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={cn(
        "min-h-20 w-full min-w-0 resize-y rounded-md border border-border-strong bg-surface-2 px-2 py-1.5 text-base text-fg",
        "placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger",
        className,
      )}
      {...props}
    />
  );
}

/** The sentence for a failed command: the backend's message, with the plain catalog sentence when it sent none. */
export function errorText(error: ProjectsError): string {
  return error.message.trim() !== "" ? error.message : t(errorTitleKey(error.kind));
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" data-form-error className="rounded-md border border-border bg-st-error-tint px-3 py-2 text-sm">
      {message}
    </p>
  );
}
