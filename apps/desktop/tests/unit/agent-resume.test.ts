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

it("a restored pane resumes the agent conversation, or starts a plain shell when it cannot", async () => {
  const { createAppStore } = await import("../../src/store");
  const { setAgentsClient } = await import("../../src/agents/service");
  const { resumeRestoredAgentPane } = await import("../../src/agents/launch");
  const client = new FakeAgentsClient();
  setAgentsClient(client);
  const store = createAppStore();
  const profile = (await client.agentProfilesList("claude"))[0];
  if (!profile) throw Error("missing profile");

  // No agent ever ran in this pane.
  expect(await store.dispatch(resumeRestoredAgentPane("pane-none"))).toBe("none");

  // An agent ran in the pane but never reported a conversation id: no resume, so no re-run of the first launch.
  const first = await client.agentStart({ task_id: null, profile_id: profile.id, prompt: "p", cwd: "~" });
  await client.agentSessionAttach(first.agent_session_id, "pty-1", "pane-a");
  expect(await store.dispatch(resumeRestoredAgentPane("pane-a"))).toBe("failed");

  // With the captured id, the pane resumes with the agent's own resume command and sends no prompt.
  client.setExternalSessionId(first.agent_session_id, "vendor-id");
  expect(await store.dispatch(resumeRestoredAgentPane("pane-a"))).toBe("resumed");
  const sessions = await client.agentSessionsList(null);
  expect(sessions).toHaveLength(2);
});

it("an agent the user ended is not continued after a restart", async () => {
  const { createAppStore } = await import("../../src/store");
  const { setAgentsClient } = await import("../../src/agents/service");
  const { resumeRestoredAgentPane } = await import("../../src/agents/launch");
  const client = new FakeAgentsClient();
  setAgentsClient(client);
  const store = createAppStore();
  const profile = (await client.agentProfilesList("claude"))[0];
  if (!profile) throw Error("missing profile");
  const run = await client.agentStart({ task_id: null, profile_id: profile.id, prompt: null, cwd: "~" });
  await client.agentSessionAttach(run.agent_session_id, "pty-2", "pane-b");
  client.setExternalSessionId(run.agent_session_id, "vendor-id");
  await client.agentSessionExited(run.agent_session_id, 0);
  expect(await store.dispatch(resumeRestoredAgentPane("pane-b"))).toBe("none");
});

it("an agent typed into a shell pane is kept until it ends or the pane closes", async () => {
  const client = new FakeAgentsClient();
  expect(await client.paneAgentStarted("pane-c", "ls -la", "/w")).toBeNull();
  expect(await client.paneAgentStarted("pane-c", "claude -p 'one shot'", "/w")).toBeNull();
  expect(await client.paneAgentStarted("pane-c", "claude --model opus", "/w")).toBe("claude");
  expect(await client.paneAgentResume("pane-c")).toMatchObject({ agent_id: "claude" });
  await client.paneAgentFinished("pane-c");
  expect(await client.paneAgentResume("pane-c")).toBeNull();
  await client.paneAgentStarted("pane-c", "codex", "/w");
  await client.paneAgentForget("pane-c");
  expect(await client.paneAgentResume("pane-c")).toBeNull();
});
