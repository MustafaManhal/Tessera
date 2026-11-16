// "Copy error report" (FR-74): the text is built by the backend (version, system, the last log lines, all with
// credentials removed) and only ever copied to the clipboard by the user. Outside the native app there is no log, so
// the report holds what the page knows.
import { commands, unwrap } from "@tessera/ipc";
import { isNativeRuntime } from "../native/runtime";

export async function buildErrorReport(title: string, message = ""): Promise<string> {
  if (isNativeRuntime()) {
    try {
      return await unwrap(commands.diagnosticsReport(title, message));
    } catch {
      // Fall through to the short report.
    }
  }
  return ["Tessera error report", `Error: ${title}`, message ? `Details: ${message}` : ""].filter(Boolean).join("\n");
}
