import { expect, it } from "vitest";
import { sessionReducer } from "../../src/terminal/session";
import { FakeAgentsClient } from "../../src/agents/fake";
it("relaunch replaces a running terminal generation and ignores its delayed exit", () => {
  const relaunched = sessionReducer({ status: "running", generation: 3, sessionId: "old" }, { type: "relaunch" });
  expect(relaunched).toEqual({ status: "starting", generation: 4 });
  expect(sessionReducer(relaunched, { type: "exited", generation: 3, code: 1 })).toEqual(relaunched);
});
it("resume rejects an uncaptured ID and creates a prompt-free new session with a captured ID", async () => {
  const client = new FakeAgentsClient();
  const profile = (await client.agentProfilesList("claude"))[0];
  if (!profile) throw Error("missing profile");
  const old = await client.agentStart({ task_id: null, profile_id: profile.id, prompt: "first prompt", cwd: "~" });
  await expect(client.agentResume(old.agent_session_id)).rejects.toMatchObject({ code: "agent.resume_unsupported" });
  client.setExternalSessionId(old.agent_session_id, "vendor-id");
  const resumed = await client.agentResume(old.agent_session_id);
  expect(resumed.agent_session_id).not.toBe(old.agent_session_id);
  expect(resumed.args).toEqual(["--resume", "vendor-id"]);
  expect(resumed.stdin).toBeNull();
  expect(resumed.type_after_ready).toBeNull();
});
