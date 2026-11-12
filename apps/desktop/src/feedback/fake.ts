import type { FeedbackClient } from "./client";
import { FeedbackError, type FeedbackInput, type FeedbackSent } from "./types";

/** In-memory feedback client for the browser and the UI tests (`window.__tesseraFeedback`). */
export class FakeFeedbackClient implements FeedbackClient {
  sent: FeedbackInput[] = [];
  /** The next send fails with this code (then it works again). */
  failWith: string | null = null;
  delayMs = 0;

  async send(input: FeedbackInput): Promise<FeedbackSent> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failWith) {
      const code = this.failWith;
      this.failWith = null;
      throw new FeedbackError(
        code === "feedback.too_many"
          ? "Too many reports from this connection in the last hour. Try again later."
          : "Could not reach the feedback server: offline",
        code,
      );
    }
    this.sent.push(input);
    return { id: `F-${String(this.sent.length).padStart(8, "0")}` };
  }
}
