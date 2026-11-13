import { commands, unwrap } from "@tessera/ipc";
import { isNativeRuntime } from "../native/runtime";
export interface ReviewComment {
  id: string;
  task_id: string;
  file_path: string;
  side: "base" | "head";
  line_start: number;
  line_end: number;
  code_excerpt: string;
  body: string;
  sent_at: number | null;
  resolved: boolean;
  created_at: number;
}
export type CommentInput = Omit<ReviewComment, "id" | "sent_at" | "resolved" | "created_at">;
export interface CommentReceipt {
  id: string;
  body: string;
}
export interface CommentBatch {
  text: string;
  comments: ReviewComment[];
}
export interface CommentsClient {
  list(taskId: string): Promise<ReviewComment[]>;
  add(input: CommentInput): Promise<ReviewComment>;
  update(id: string, body: string, resolved: boolean): Promise<ReviewComment>;
  remove(id: string): Promise<void>;
  prepare(taskId: string): Promise<CommentBatch>;
  sent(taskId: string, receipts: CommentReceipt[]): Promise<ReviewComment[]>;
}
export class TauriCommentsClient implements CommentsClient {
  async list(taskId: string) {
    return unwrap(commands.reviewCommentsList(taskId)) as Promise<ReviewComment[]>;
  }
  async add(input: CommentInput) {
    return unwrap(commands.reviewCommentAdd(input)) as Promise<ReviewComment>;
  }
  async update(id: string, body: string, resolved: boolean) {
    return unwrap(commands.reviewCommentUpdate(id, body, resolved)) as Promise<ReviewComment>;
  }
  async remove(id: string) {
    await unwrap(commands.reviewCommentDelete(id));
  }
  async prepare(taskId: string) {
    return unwrap(commands.reviewCommentsPrepare(taskId)) as Promise<CommentBatch>;
  }
  async sent(taskId: string, receipts: CommentReceipt[]) {
    return unwrap(commands.reviewCommentsSend(taskId, receipts)) as Promise<ReviewComment[]>;
  }
}
export function commentsPrompt(rows: ReviewComment[]): string {
  let text = "Review comments on your changes:";
  for (const c of rows.filter((c) => c.sent_at === null && !c.resolved)) {
    const range = c.line_start === c.line_end ? `${c.line_start}` : `${c.line_start}-${c.line_end}`;
    const lines = c.code_excerpt.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    text += `\n\n${c.file_path}:${range} (${c.side})\n${lines.map((line) => `> ${line}\n`).join("")}${c.body}`;
  }
  return text;
}
export class FakeCommentsClient implements CommentsClient {
  private rows: ReviewComment[] = [];
  private next = 1;
  async list(taskId: string) {
    return structuredClone(this.rows.filter((c) => c.task_id === taskId));
  }
  async add(input: CommentInput) {
    const c: ReviewComment = {
      ...input,
      id: `comment-${this.next++}`,
      created_at: Date.now(),
      sent_at: null,
      resolved: false,
    };
    this.rows.push(c);
    return structuredClone(c);
  }
  private get(id: string) {
    const row = this.rows.find((c) => c.id === id);
    if (!row) throw Error("The review comment could not be found.");
    return row;
  }
  async update(id: string, body: string, resolved: boolean) {
    const row = this.get(id);
    if (row.body !== body) row.sent_at = null;
    row.body = body;
    row.resolved = resolved;
    return structuredClone(row);
  }
  async remove(id: string) {
    this.get(id);
    this.rows = this.rows.filter((c) => c.id !== id);
  }
  async prepare(taskId: string) {
    const comments = (await this.list(taskId)).filter((c) => c.sent_at === null && !c.resolved);
    return { text: commentsPrompt(comments), comments };
  }
  async sent(taskId: string, receipts: CommentReceipt[]) {
    for (const receipt of receipts) {
      const row = this.rows.find((c) => c.id === receipt.id && c.task_id === taskId);
      if (row && row.body === receipt.body && row.sent_at === null) row.sent_at = Date.now();
    }
    return this.list(taskId);
  }
}
declare global {
  interface Window {
    __tesseraComments?: FakeCommentsClient;
  }
}
const fake = new FakeCommentsClient();
if (typeof window !== "undefined" && import.meta.env.DEV && !isNativeRuntime()) window.__tesseraComments = fake;
let native: CommentsClient | undefined;
export function commentsClient(): CommentsClient {
  if (!isNativeRuntime()) return fake;
  native ??= new TauriCommentsClient();
  return native;
}
