import { commands, unwrap } from "@tessera/ipc";
import { invoke } from "@tauri-apps/api/core";
import { store } from "../store";
import { loadProjects } from "../projects/thunks";
import { openTaskTab } from "../sidebar/taskTabs";
import { reviewClient } from "./client";
import { reviewVisibility, toggleReview } from "./model";
export async function run(taskId: string) {
  const result: Record<string, unknown> = { source: "native debug WebView", taskId, ok: false };
  try {
    await store.dispatch(loadProjects());
    await store.dispatch(openTaskTab(taskId));
    if (!reviewVisibility.get()) toggleReview();
    const client = reviewClient();
    result.files = await client.files(taskId);
    result.diff = await client.diff(taskId, "example.ts");
    const comment = await unwrap(
      commands.reviewCommentAdd({
        task_id: taskId,
        file_path: "example.ts",
        side: "head",
        line_start: 1,
        line_end: 1,
        code_excerpt: "export const value = 2;",
        body: "Native review fixture",
      }),
    );
    await unwrap(commands.reviewCommentUpdate(comment.id, "Native edited comment", false));
    const batch = await unwrap(commands.reviewCommentsPrepare(taskId));
    result.commentPrompt = batch.text;
    await unwrap(commands.reviewCommentDelete(comment.id));
    const hunks = await unwrap(commands.gitReviewHunks(taskId, "example.ts", false));
    if (hunks.length !== 1 || !hunks[0]) throw Error("Expected one native fixture hunk");
    await unwrap(commands.gitStage(taskId, "example.ts", hunks[0]));
    result.staged = await unwrap(commands.gitReviewIndex(taskId));
    const stagedHunks = await unwrap(commands.gitReviewHunks(taskId, "example.ts", true));
    if (stagedHunks.length !== 1 || !stagedHunks[0]) throw Error("Expected one staged fixture hunk");
    await unwrap(commands.gitUnstage(taskId, "example.ts", stagedHunks[0]));
    result.unstaged = await unwrap(commands.gitReviewIndex(taskId));
    result.workingContentPreserved =
      JSON.stringify(await client.diff(taskId, "example.ts")) === JSON.stringify(result.diff);
    const refused = await commands.gitDiscard(taskId, "example.ts", null, false);
    result.discardRequiresConfirmation = refused.status === "error" && refused.error.code === "git.confirm_required";
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !document.querySelector("[data-review-diff] .cm-content"))
      await new Promise((resolve) => setTimeout(resolve, 50));
    const panel = document.querySelector("[data-review-panel]");
    result.panel = panel?.textContent;
    result.ok =
      !!panel?.textContent?.includes("example.ts") &&
      !!document.querySelector("[data-review-diff] .cm-content") &&
      batch.text.includes("Native edited comment") &&
      result.workingContentPreserved === true &&
      result.discardRequiresConfirmation === true &&
      (result.staged as { staged: boolean }[]).some((f) => f.staged) &&
      (result.unstaged as { staged: boolean; unstaged: boolean }[]).some((f) => !f.staged && f.unstaged);
  } catch (cause) {
    result.error = cause instanceof Error ? cause.message : String(cause);
  }
  await invoke("review_smoke_result", { result });
}
