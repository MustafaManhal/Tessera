import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentPaneExited,
  agentPaneOutput,
  agentPaneSpawned,
  deliverPrompt,
  paneRemoved,
  restartAgentPane,
  startAgent,
  stopAgentPane,
} from "../../src/agents/launch";
import { FakeAgentsClient } from "../../src/agents/fake";
import { setAgentsClient } from "../../src/agents/service";
import type { AgentLaunch } from "../../src/agents/types";
import { paneIds, sequentialIds } from "../../src/layout";
import { createAppStore, type AppStore } from "../../src/store";
import { layout } from "../../src/store/layoutSlice";

// Prompt delivery and the launcher thunks against the in-memory fake client and a real store, so the layout,
// the sessions slice and the listener middleware all run as they do in the app.

const encoder = new TextEncoder();
const collect = (writes: string[]) => (text: string) => {
  writes.push(text);
};

const plan = (overrides: Partial<AgentLaunch> = {}): AgentLaunch => ({
  agent_session_id: "as_1",
  agent_id: "agent",
  agent_name: "Agent",
  icon: "Bot",
  profile_id: "prof_1",
  profile_name: "Default",
  task_id: null,
  cwd: null,
  program: "agent",
  args: [],
  env: {},
  stdin: null,
  type_after_ready: null,
  ready_pattern: null,
  skip_permissions: false,
  ...overrides,
});

describe("deliverPrompt", () => {
  it("writes a stdin prompt once and finishes", async () => {
    const writes: string[] = [];
    const delivery = deliverPrompt(plan({ stdin: "fix the bug\n" }), (text) => {
      writes.push(text);
    });
    await expect(delivery.done).resolves.toBe("stdin");
    expect(writes).toEqual(["fix the bug\n"]);
    delivery.feed(encoder.encode("anything"));
    expect(writes).toHaveLength(1);
  });

  it("delivers nothing when the plan has no prompt (arg and flag modes already carry it)", async () => {
    const writes: string[] = [];
    const delivery = deliverPrompt(plan(), (text) => {
      writes.push(text);
    });
    await expect(delivery.done).resolves.toBe("none");
    expect(writes).toEqual([]);
  });

  it("types the prompt as a bracketed paste plus Enter once the ready line prints", async () => {
    const writes: string[] = [];
    const delivery = deliverPrompt(
      plan({ type_after_ready: "fix the flaky test", ready_pattern: "ready for input" }),
      (text) => {
        writes.push(text);
      },
    );
    delivery.feed(encoder.encode("agent banner\n"));
    expect(writes).toEqual([]);
    delivery.feed(encoder.encode("all set, ready for input\n"));
    await expect(delivery.done).resolves.toBe("typed");
    expect(writes).toEqual(["\x1b[200~fix the flaky test\x1b[201~", "\r"]);
  });

  it("matches the ready pattern across chunk boundaries", async () => {
    const writes: string[] = [];
    const delivery = deliverPrompt(plan({ type_after_ready: "go", ready_pattern: "read..line" }), collect(writes));
    delivery.feed(encoder.encode("rea"));
    delivery.feed(encoder.encode("dy li"));
    delivery.feed(encoder.encode("ne\n"));
    await expect(delivery.done).resolves.toBe("typed");
    expect(writes).toHaveLength(2);
  });

  it("sends anyway and reports a timeout when the ready line never comes", async () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const onTimeout = vi.fn();
      const delivery = deliverPrompt(
        plan({ type_after_ready: "go", ready_pattern: "never comes" }),
        (text) => {
          writes.push(text);
        },
        { timeoutMs: 50, onTimeout },
      );
      await vi.advanceTimersByTimeAsync(60);
      await expect(delivery.done).resolves.toBe("timeout");
      expect(onTimeout).toHaveBeenCalledOnce();
      expect(writes).toEqual(["\x1b[200~go\x1b[201~", "\r"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a pattern that does not compile as no pattern and sends at once", async () => {
    const writes: string[] = [];
    const delivery = deliverPrompt(plan({ type_after_ready: "go", ready_pattern: "([unclosed" }), collect(writes));
    await expect(delivery.done).resolves.toBe("typed");
    expect(writes).toEqual(["\x1b[200~go\x1b[201~", "\r"]);
  });

  it("cancel stops a pending type delivery without sending", async () => {
    const writes: string[] = [];
    const delivery = deliverPrompt(plan({ type_after_ready: "go", ready_pattern: "ready" }), collect(writes));
    delivery.cancel();
    await expect(delivery.done).resolves.toBe("none");
    delivery.feed(encoder.encode("ready"));
    expect(writes).toEqual([]);
  });
});

describe("launcher thunks", () => {
  let client: FakeAgentsClient;
  let store: AppStore;

  beforeEach(() => {
    client = new FakeAgentsClient();
    setAgentsClient(client);
    store = createAppStore({ env: { newId: sequentialIds("n") } });
  });

  const launches = () => store.getState().agentSessions.launches;
  const calls = (method: string) => client.calls.filter((call) => call.method === method);

  async function launchedPane(taskId: string | null = null): Promise<{ paneId: string; plan: AgentLaunch }> {
    const [profile] = await client.agentProfilesList("claude");
    const plan = await store.dispatch(
      startAgent({ profileId: profile?.id as string, prompt: "fix the bug", taskId, cwd: null }),
    );
    const paneId = Object.keys(launches())[0] as string;
    return { paneId, plan };
  }

  it("startAgent with no task opens a new agent tab bound to the plan", async () => {
    const { paneId, plan } = await launchedPane();
    const state = store.getState();
    const tab = state.layout.tabs.find((candidate) => Object.keys(state.layout.panes).includes(candidate.focusedPane));
    expect(tab?.root.type).toBe("pane");
    expect(state.layout.panes[paneId]?.launch).toEqual({
      program: plan.program,
      args: plan.args,
      env: plan.env,
    });
    expect(launches()[paneId]?.agent_session_id).toBe(plan.agent_session_id);
    expect(calls("agentStart")).toHaveLength(1);
  });

  it("startAgent in a task opens its own tab and keeps the task id", async () => {
    store.dispatch(layout({ type: "tab/new", cwd: "/repo", taskId: "task_1", title: "Work" }));
    const { paneId } = await launchedPane("task_1");
    const state = store.getState();
    expect(state.layout.panes[paneId]?.taskId).toBe("task_1");
    const taskTab = state.layout.tabs.find((tab) => paneIds(tab.root).includes(paneId));
    expect(taskTab?.root.type).toBe("pane"); // its own tab, not a split of the task's terminal
    expect(state.layout.tabs).toHaveLength(3); // the first tab, the task, the agent
    expect(calls("agentStart")[0]?.args[0]).toMatchObject({ task_id: "task_1" });
  });

  it("agentPaneSpawned attaches the session and delivers a type-mode prompt after the ready line", async () => {
    const [gemini] = await client.agentProfilesList("gemini");
    const plan = await store.dispatch(
      startAgent({ profileId: gemini?.id as string, prompt: "hello gemini", taskId: null, cwd: null }),
    );
    expect(plan.type_after_ready).toBe("hello gemini");
    const paneId = Object.keys(launches())[0] as string;
    const writes: string[] = [];
    const session = await store.dispatch(
      agentPaneSpawned({
        paneId,
        paneSessionId: "pty_1",
        write: (text) => {
          writes.push(text);
        },
      }),
    );
    expect(session?.status).toBe("working");
    expect(calls("agentSessionAttach")).toHaveLength(1);
    expect(writes).toEqual([]);
    agentPaneOutput(paneId, encoder.encode("banner: Type help.\r\n"));
    await vi.waitFor(() => expect(writes).toEqual(["\x1b[200~hello gemini\x1b[201~", "\r"]));
  });

  it("agentPaneExited reports the exit once, however often it is called", async () => {
    const { paneId } = await launchedPane();
    await store.dispatch(agentPaneSpawned({ paneId, paneSessionId: "pty_1", write: null }));
    const first = await store.dispatch(agentPaneExited(paneId, 0));
    expect(first?.status).toBe("exited");
    const second = await store.dispatch(agentPaneExited(paneId, 1));
    expect(second?.status).toBe("exited");
    expect(second?.exit_code).toBe(0);
    expect(calls("agentSessionExited")).toHaveLength(1);
  });

  it("restartAgentPane asks for a new plan and makes the terminal respawn in place", async () => {
    const { paneId } = await launchedPane();
    const before = store.getState().layout.panes[paneId];
    const plan = await store.dispatch(restartAgentPane(paneId));
    expect(plan).not.toBeNull();
    expect(calls("agentRestart")).toHaveLength(1);
    const after = store.getState().layout.panes[paneId];
    expect(after?.restartKey).toBe((before?.restartKey ?? 0) + 1);
    expect(after?.launch?.program).toBe(plan?.program);
  });

  it("stopAgentPane kills the bound PTY session", async () => {
    const { paneId } = await launchedPane();
    await store.dispatch(agentPaneSpawned({ paneId, paneSessionId: "pty_9", write: null }));
    const kill = vi.fn(async () => {});
    await store.dispatch(stopAgentPane(paneId, kill));
    expect(kill).toHaveBeenCalledWith("pty_9");
  });

  it("paneRemoved reports the exit the dead PTY cannot and forgets the launch", async () => {
    const { paneId } = await launchedPane();
    await store.dispatch(agentPaneSpawned({ paneId, paneSessionId: "pty_1", write: null }));
    store.dispatch(layout({ type: "pane/close", paneId }));
    await vi.waitFor(() => expect(Object.keys(launches())).toHaveLength(0));
    await vi.waitFor(() => expect(calls("agentSessionExited")).toHaveLength(1));
    // A second sweep finds nothing left to report.
    await store.dispatch(paneRemoved(paneId));
    expect(calls("agentSessionExited")).toHaveLength(1);
  });
});

describe("stripEscapes (ConPTY wraps output in escape sequences)", () => {
  it("leaves the visible text so a ready pattern matches", async () => {
    const { stripEscapes, deliverPrompt } = await import("../../src/agents/launch");
    const conpty = "\x1b[?25l\x1b[2J\x1b[m\x1b[H>\x1b]0;agent\x07\x1b[?25h";
    expect(stripEscapes(conpty)).toBe(">");
    const writes: string[] = [];
    const delivery = deliverPrompt(
      { stdin: null, type_after_ready: "hello", ready_pattern: "(?m)^>\\r?$", agent_name: "Fake" },
      (text) => {
        writes.push(text);
      },
      { timeoutMs: 1_000 },
    );
    delivery.feed(new TextEncoder().encode(conpty));
    await expect(delivery.done).resolves.toBe("typed");
    expect(writes).toEqual(["\x1b[200~hello\x1b[201~", "\r"]);
  });
});
