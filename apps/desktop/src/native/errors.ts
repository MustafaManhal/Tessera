import { t, type StringKey } from "@tessera/ui";
import { notifications } from "../notify";

export function reportNativeCommandError(title: StringKey, error: unknown): void {
  notifications().toastNow({
    kind: "error",
    title: t(title, { message: error instanceof Error ? error.message : String(error) }),
  });
}
