// Shared by the prompt bar and review: a single bracketed-paste path, with delivery acknowledgements.
import { commands, unwrap } from "@tessera/ipc";
import { paneTerminal } from "../terminal/panes";
import { stripControlCharacters } from "../terminal/paste";
import { prompts } from "./client";
export interface PromptTarget {
  sessionId: string;
  paneId: string;
}
export function sendPromptToAgents(text: string, targets: PromptTarget[]): string[] {
  const safe = stripControlCharacters(text);
  const payload = new TextEncoder().encode(`\x1b[200~${safe}\x1b[201~\r`);
  const delivered: string[] = [];
  for (const target of targets) {
    const terminal = paneTerminal(target.paneId);
    if (!terminal?.writeInput(payload)) continue;
    delivered.push(target.sessionId);
    void unwrap(commands.agentEventAppend(target.sessionId, "prompt_sent", JSON.stringify({ text: safe }))).catch(
      () => {},
    );
  }
  if (delivered.length)
    void prompts()
      .historyAdd(safe, delivered)
      .catch(() => {});
  return delivered;
}
