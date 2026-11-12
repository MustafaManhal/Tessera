import { commands, unwrap } from "@tessera/ipc";
import type { FeedbackClient } from "./client";
import { FeedbackError, type FeedbackInput, type FeedbackSent } from "./types";

export class TauriFeedbackClient implements FeedbackClient {
  async send(input: FeedbackInput): Promise<FeedbackSent> {
    try {
      return await unwrap(commands.feedbackSend(input));
    } catch (cause) {
      const error = cause as { code?: string; message?: string };
      throw new FeedbackError(error?.message || String(cause), error?.code ?? "feedback.network");
    }
  }
}
