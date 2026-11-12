// Starts the agent when the scheduler created a task for an automation (`automation:fired`), so the run shows up as an
// ordinary agent pane in the new task's tab. Renders nothing.
import { t } from "@tessera/ui";
import { useEffect } from "react";
import { agentsErrorMessage } from "../agents/errors";
import { startAgent } from "../agents/launch";
import { notifications } from "../notify";
import { useAppDispatch } from "../store/hooks";
import { automationsClient } from "./service";

export function AutomationsHost() {
  const dispatch = useAppDispatch();
  useEffect(
    () =>
      automationsClient().onFired((fired) => {
        notifications().toastNow({ title: t("automations.fired", { name: fired.automation_name }) });
        dispatch(
          startAgent({ profileId: fired.profile_id, prompt: fired.prompt, taskId: fired.task_id, cwd: null }),
        ).catch((cause) =>
          notifications().toastNow({
            kind: "error",
            title: t("agents.launch.failed", { message: agentsErrorMessage(cause) }),
          }),
        );
      }),
    [dispatch],
  );
  return null;
}
