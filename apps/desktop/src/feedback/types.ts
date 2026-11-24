// The feedback form (reports, ideas, screenshots). Mirrors the Rust `FeedbackInput`.
export type FeedbackKind = "bug" | "idea" | "design" | "other";

export interface FeedbackAttachment {
  name: string;
  mime: "image/jpeg" | "image/png" | "image/webp";
  data_base64: string;
}

export interface FeedbackInput {
  kind: FeedbackKind;
  title: string;
  body: string;
  contact: string;
  include_report: boolean;
  attachments: FeedbackAttachment[];
}

export interface FeedbackSent {
  id: string;
}

/** An error with a sentence for people and a code the form can react to. */
export class FeedbackError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}
