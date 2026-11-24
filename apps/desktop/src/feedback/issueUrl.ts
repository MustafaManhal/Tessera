// When the feedback server cannot be reached, the form offers the same report as a GitHub issue: a prefilled "new issue"
// page. A web address cannot carry images, so the screenshots stay on the person's computer to be dragged in.
import type { FeedbackKind } from "./types";

const REPO = "https://github.com/MustafaManhal/Tessera";
const LABEL: Record<FeedbackKind, string> = { bug: "bug", idea: "enhancement", design: "design", other: "feedback" };
/** Keeps the address well under what browsers and GitHub accept. */
const MAX_BODY = 5_500;

export function issueUrl(input: { kind: FeedbackKind; title: string; body: string; report: string }): string {
  let body = input.body.trim();
  if (input.report.trim() !== "")
    body += `\n\n<details><summary>Technical details</summary>\n\n\`\`\`\n${input.report.trim()}\n\`\`\`\n</details>`;
  if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n…(shortened)`;
  const params = new URLSearchParams({ title: input.title.trim(), body, labels: LABEL[input.kind] });
  return `${REPO}/issues/new?${params.toString()}`;
}
