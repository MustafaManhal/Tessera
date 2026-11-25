(async () => {
  const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
  const evidence = { source: "native WebView window.__TAURI_INTERNALS__.invoke", checks: [], created: [] };
  const check = (condition, message) => {
    if (!condition) throw Error(message);
    evidence.checks.push(message);
  };
  try {
    if (window.__TESSERA_GROUP_SMOKE__) {
      const fixture = await invoke("group_smoke_fixture");
      evidence.group = await invoke("task_group_create", {
        input: {
          project_id: fixture.project_id,
          prompt: "Offline comparison",
          base_branch: "main",
          name: "Native group",
          profile_ids: [fixture.profile_id, fixture.profile_id],
        },
      });
      const files = await invoke("group_smoke_fixture");
      check(
        evidence.group.tasks.length === 2 && files.paths.length >= 2 && files.paths.every((p) => p.exists),
        "Both group worktrees exist on disk.",
      );
      evidence.resume = await invoke("agent_resume", { agentSessionId: fixture.session_id });
      check(
        evidence.resume.args.join(" ") === "--resume fixture-external-id",
        "Resume renders the captured external ID.",
      );
      evidence.files = files.paths;
      evidence.ok = true;
      return;
    }

    if (window.__TESSERA_HOOKS_SMOKE__) {
      evidence.before = await invoke("hooks_smoke_files");
      evidence.hooks = {};
      for (const agentId of ["claude", "codex", "gemini"]) {
        const preview = await invoke("hooks_preview", { agentId });
        check(preview.state === "none" && preview.diff.includes("+"), `${agentId}: preview returns additions.`);
        const installed = await invoke("hooks_install", { agentId });
        check(installed.state === "installed", `${agentId}: install reports installed.`);
        const twice = await invoke("hooks_install", { agentId });
        check(twice.diff === "", `${agentId}: second install is idempotent.`);
        const catalog = await invoke("agent_catalog", { rescan: false });
        check(
          catalog.find((row) => row.id === agentId)?.hooks_state === "installed",
          `${agentId}: catalog reads installed state.`,
        );
        evidence.hooks[agentId] = { preview, installed_file: (await invoke("hooks_smoke_files"))[agentId] };
        const removed = await invoke("hooks_remove", { agentId });
        check(removed.state === "none", `${agentId}: remove reports none.`);
      }
      evidence.after = await invoke("hooks_smoke_files");
      check(
        JSON.stringify(evidence.before) === JSON.stringify(evidence.after),
        "All three removals restore every original byte.",
      );
      evidence.ok = true;
      return;
    }
    const events = [];
    const handler = window.__TAURI_INTERNALS__.transformCallback((event) => events.push(event));
    await invoke("plugin:event|listen", { event: "agents:changed", target: { kind: "Any" }, handler });
    evidence.catalog = await invoke("agent_catalog", { rescan: true });
    const started = performance.now();
    const cached = await invoke("agent_catalog", { rescan: false });
    evidence.cached_ms = performance.now() - started;
    check(cached.length === evidence.catalog.length, "Cached catalog returns the same rows.");
    const agent = evidence.catalog.find((a) => a.installed && a.has_skip_permissions);
    check(!!agent, "An installed agent supports the permission opt-in test.");
    const before = await invoke("agent_profiles_list", { agentId: agent.id });
    check(before.length === 1 && before[0].is_default, "First discovery creates one default profile.");
    const profile = {
      id: null,
      agent_id: agent.id,
      name: "Task 24 smoke",
      model: null,
      extra_args: [],
      env: { TESSERA_PLAIN_OPTION: "visible-value" },
      skip_permissions: false,
      is_default: false,
    };
    const saved = await invoke("agent_profile_save", { profile });
    evidence.created.push(saved.id);
    const preview = await invoke("agent_command_preview", { profileId: saved.id, prompt: "literal prompt" });
    evidence.preview = preview;
    check(
      !preview.skip_permissions && preview.env_keys[0] === "TESSERA_PLAIN_OPTION",
      "Preview preserves opt-in and returns environment keys.",
    );
    check(!JSON.stringify(preview).includes("visible-value"), "Preview omits environment values.");
    const enabled = await invoke("agent_profile_save", {
      profile: { ...profile, id: saved.id, skip_permissions: true },
    });
    const enabledPreview = await invoke("agent_command_preview", { profileId: enabled.id, prompt: null });
    check(
      enabledPreview.skip_permissions && enabledPreview.args.length > preview.args.length - 2,
      "Explicit permission opt-in adds bypass arguments.",
    );
    for (const [name, args, code] of [
      ["agent_profile_save", { profile: { ...profile, name: " " } }, "agent.profile_invalid"],
      ["agent_profile_save", { profile: { ...profile, env: { "BAD-KEY": "x" } } }, "agent.profile_invalid"],
      ["agent_profile_save", { profile: { ...profile, agent_id: "missing" } }, "agent.unknown"],
      ["agent_profile_delete", { id: "missing" }, "agent.profile_not_found"],
    ]) {
      let error;
      try {
        await invoke(name, args);
      } catch (e) {
        error = e;
      }
      check(error?.code === code, `${name} returns ${code}.`);
    }
    await invoke("agent_profile_delete", { id: saved.id });
    evidence.created = [];
    const after = await invoke("agent_profiles_list", { agentId: agent.id });
    check(after.length === before.length, "Profile deletion restores the original profile count.");
    check(
      events.length >= 4 && events.every((e) => e.payload === null),
      "Rescan and profile changes emit unit agents:changed events.",
    );
    evidence.event_count = events.length;
    const sessions = [];
    const sessionHandler = window.__TAURI_INTERNALS__.transformCallback((event) => sessions.push(event.payload));
    await invoke("plugin:event|listen", {
      event: "agent:session_changed",
      target: { kind: "Any" },
      handler: sessionHandler,
    });
    const plan = await invoke("agent_start", {
      input: { task_id: null, profile_id: before[0].id, prompt: null, cwd: null },
    });
    evidence.launch_plan = plan;
    check(plan.stdin === null && plan.type_after_ready === null, "Installed agent test plan has no prompt.");
    check(
      plan.env.TESSERA_AGENT_SESSION_ID === plan.agent_session_id &&
        plan.env.TESSERA_AGENT === plan.agent_id &&
        !("TESSERA_SESSION_ID" in plan.env),
      "Launch plan reserves agent IDs and leaves PTY session identity to the host.",
    );
    const attached = await invoke("agent_session_attach", {
      agentSessionId: plan.agent_session_id,
      paneSessionId: "task26-smoke-plan-only",
      paneId: "task26-smoke-pane",
    });
    check(
      attached.status === "working" && attached.status_source === "launch",
      "Attach records the working lifecycle state.",
    );
    const replacement = await invoke("agent_restart", { agentSessionId: plan.agent_session_id });
    const rows = await invoke("agent_sessions_list", { taskId: null });
    check(
      replacement.agent_session_id !== plan.agent_session_id &&
        rows.find((row) => row.id === plan.agent_session_id)?.status === "exited",
      "Restart records a new session and ends the old one.",
    );
    const failed = await invoke("agent_session_exited", { agentSessionId: replacement.agent_session_id, exitCode: 3 });
    const duplicate = await invoke("agent_session_exited", {
      agentSessionId: replacement.agent_session_id,
      exitCode: 0,
    });
    check(
      failed.status === "error" && JSON.stringify(failed) === JSON.stringify(duplicate),
      "Nonzero exit and duplicate callbacks are idempotent.",
    );
    check(
      sessions.some((row) => row.id === plan.agent_session_id && row.status === "starting") &&
        sessions.some((row) => row.id === replacement.agent_session_id && row.status === "error"),
      "Lifecycle events carry the unwrapped AgentSession payload.",
    );
    evidence.session_event_count = sessions.length;
    if (window.__TESSERA_API_SMOKE__) evidence.api_fixture = await invoke("agent_smoke_fixture");
    evidence.ok = true;
  } catch (e) {
    evidence.ok = false;
    evidence.error = String(e?.message ?? JSON.stringify(e));
  } finally {
    for (const id of evidence.created) await invoke("agent_profile_delete", { id }).catch(() => {});
    console.log("Task 24/26 native IPC acceptance", evidence);
    await invoke("agent_smoke_result", { result: evidence });
  }
})();
