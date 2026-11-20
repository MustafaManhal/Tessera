import type { FeedbackInput, FeedbackSent } from "./types";

export interface FeedbackClient {
  send(input: FeedbackInput): Promise<FeedbackSent>;
}
