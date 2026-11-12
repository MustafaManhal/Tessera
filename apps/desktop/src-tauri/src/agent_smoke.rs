//! Opt-in debug WebView IPC acceptance. Set TESSERA_AGENT_SMOKE_ROOT to a disposable
//! directory (use TESSERA_BENCH_ROOT too for an isolated database). No model calls.
use tauri::Manager;
#[tauri::command]
fn group_smoke_fixture(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let root = std::path::PathBuf::from(std::env::var_os("TESSERA_BENCH_ROOT").ok_or("No isolated root")?);
    if std::env::var_os("TESSERA_GROUP_SMOKE").is_none() {
        return Err("Disabled".into());
    }
    let repo = root.join("fixture-repo");
    if !repo.exists() {
        std::fs::create_dir_all(&repo).map_err(|e| e.to_string())?;
        for args in [
            vec!["init", "-b", "main"],
            vec![
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "fixture",
            ],
        ] {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).into_owned());
            }
        }
    }
    let state = app.state::<crate::state::AppState>();
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let project = match store
        .projects()
        .list()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|p| std::fs::canonicalize(&p.path).ok() == std::fs::canonicalize(&repo).ok())
    {
        Some(project) => project,
        None => store.project_add_local(&repo, &root).map_err(|e| e.to_string())?,
    };
    let binary = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    std::fs::create_dir_all(state.dirs.root.join("agents")).map_err(|e| e.to_string())?;
    std::fs::write(state.dirs.root.join("agents/resume-fixture.toml"),format!("id='resume-fixture'\nname='Resume fixture'\nbinaries=[{0}]\nversion-cmd=[{0}, '--version']\nprompt-mode='arg'\nresume=[{0}, '--resume', '{{external_session_id}}']\nhooks='none'\nicon='terminal'\ninstall-url='https://example.invalid'\ndocs-url='https://example.invalid'\n",serde_json::to_string(&binary).unwrap())).map_err(|e|e.to_string())?;
    store
        .agent_profiles()
        .ensure_default("resume-fixture")
        .map_err(|e| e.to_string())?;
    let profile = store
        .agent_profiles()
        .list(Some("resume-fixture"))
        .map_err(|e| e.to_string())?[0]
        .id
        .clone();
    let session = store
        .agent_sessions()
        .create(None, "resume-fixture", &profile, None)
        .map_err(|e| e.to_string())?;
    store
        .agent_sessions()
        .set_external_session_id(&session.id, "fixture-external-id")
        .map_err(|e| e.to_string())?;
    store
        .agent_sessions()
        .set_launch_cwd(&session.id, &repo.to_string_lossy())
        .map_err(|e| e.to_string())?;
    let paths = store
        .tasks()
        .list()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter_map(|t| t.worktree_path)
        .map(|p| serde_json::json!({"exists":std::path::Path::new(&p).is_dir(),"path":p}))
        .collect::<Vec<_>>();
    Ok(serde_json::json!({"project_id":project.id,"profile_id":profile,"session_id":session.id,"paths":paths}))
}
#[tauri::command]
fn agent_smoke_result(result: serde_json::Value) -> Result<(), String> {
    let root = std::env::var_os("TESSERA_AGENT_SMOKE_ROOT").ok_or("The agent smoke harness is disabled.")?;
    std::fs::write(
        std::path::PathBuf::from(root).join("agent-smoke.json"),
        serde_json::to_vec_pretty(&result).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
// Read back only the three files in the explicitly isolated hook smoke home.
#[tauri::command]
fn hooks_smoke_files() -> Result<serde_json::Value, String> {
    if std::env::var_os("TESSERA_HOOKS_SMOKE").is_none() || std::env::var_os("TESSERA_BENCH_ROOT").is_none() {
        return Err("The isolated hooks smoke harness is disabled.".into());
    }
    let home = std::path::PathBuf::from(std::env::var_os("TESSERA_HOOKS_HOME").ok_or("Missing isolated hooks home.")?);
    let mut files = serde_json::Map::new();
    for (agent, relative) in [
        ("claude", ".claude/settings.json"),
        ("codex", ".codex/config.toml"),
        ("gemini", ".gemini/settings.json"),
    ] {
        let text = std::fs::read_to_string(home.join(relative)).map_err(|e| e.to_string())?;
        files.insert(agent.into(), text.into());
    }
    Ok(files.into())
}
#[tauri::command]
fn agent_smoke_fixture(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    if std::env::var_os("TESSERA_API_SMOKE").is_none() || std::env::var_os("TESSERA_BENCH_ROOT").is_none() {
        return Err("The isolated API smoke harness is disabled.".into());
    }
    let state = app.state::<crate::state::AppState>();
    let binary = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../target/debug/examples")
        .join(if cfg!(windows) { "fake_agent.exe" } else { "fake_agent" });
    if !binary.is_file() {
        return Err("Build the fake_agent example before running API smoke.".into());
    }
    let row = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        store
            .agent_profiles()
            .ensure_default("api-smoke-fake")
            .map_err(|e| e.to_string())?;
        let profile = store
            .agent_profiles()
            .list(Some("api-smoke-fake"))
            .map_err(|e| e.to_string())?[0]
            .id
            .clone();
        store
            .agent_sessions()
            .create(None, "api-smoke-fake", &profile, None)
            .map_err(|e| e.to_string())?
    };
    let mut spec = tessera_pty::SpawnSpec::new(&state.dirs.root);
    spec.program = Some(binary.to_string_lossy().into_owned());
    spec.args = vec!["--".into(), "Task 28 offline fixture".into()];
    spec.env.insert("FAKE_AGENT_WAIT_MS".into(), "120000".into());
    spec.env.insert("TESSERA_AGENT_SESSION_ID".into(), row.id.clone());
    spec.env.insert("TESSERA_AGENT".into(), "api-smoke-fake".into());
    let id = state.pty.spawn_with_sink(spec, None).map_err(|e| e.to_string())?;
    {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        store
            .agent_sessions()
            .set_pane_session(
                &row.id,
                &id.as_string(),
                "api-smoke-pane",
                tessera_store::agents::now_millis(),
            )
            .map_err(|e| e.to_string())?;
    }
    let pid = state.pty.describe(&id).map_err(|e| e.to_string())?.pid;
    let endpoint = tessera_api::Endpoint::new(&state.dirs.root);
    let result = serde_json::json!({"agent_session_id":row.id,"pane_session_id":id.as_string(),"pid":pid,"socket":endpoint.address,"token_file":endpoint.token_file});
    let stop = std::path::PathBuf::from(std::env::var_os("TESSERA_BENCH_ROOT").unwrap()).join("api-fixture-stop");
    let handle = app.clone();
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
        while !stop.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let state = handle.state::<crate::state::AppState>();
        let _ = state.pty.kill(&id);
        if let Ok(store) = state.store.lock() {
            let _ = store
                .agent_sessions()
                .mark_exited(&row.id, 0, tessera_store::agents::now_millis());
        }
    });
    Ok(result)
}
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("agent-smoke")
        .on_page_load(|webview, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished || webview.label() != "main" {
                return;
            }
            let handle = webview.app_handle().clone();
            // Run once after app setup and login-env probing have had time to complete.
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(2));
                if let Some(window) = handle.get_webview_window("main") {
                    let script = if std::env::var_os("TESSERA_GROUP_SMOKE").is_some() {
                        format!(
                            "window.__TESSERA_GROUP_SMOKE__ = true;\n{}",
                            include_str!("agent_smoke.js")
                        )
                    } else if std::env::var_os("TESSERA_HOOKS_SMOKE").is_some() {
                        format!(
                            "window.__TESSERA_HOOKS_SMOKE__ = true;\n{}",
                            include_str!("agent_smoke.js")
                        )
                    } else if std::env::var_os("TESSERA_API_SMOKE").is_some() {
                        format!(
                            "window.__TESSERA_API_SMOKE__ = true;\n{}",
                            include_str!("agent_smoke.js")
                        )
                    } else {
                        include_str!("agent_smoke.js").to_string()
                    };
                    let _ = window.eval(&script);
                }
            });
        })
        .build()
}

/// Debug-only app command, routed outside generated production bindings.
pub fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> =
        Box::new(tauri::generate_handler![
            agent_smoke_result,
            group_smoke_fixture,
            agent_smoke_fixture,
            hooks_smoke_files
        ]);
    handler(invoke)
}

/// Opt-in debug-app check for custom agent definitions (FR-34). Set
/// TESSERA_CUSTOM_AGENT_SMOKE_ROOT to a disposable directory; writes
/// custom-agent-smoke.json there. Saves a definition for harmless `git`,
/// runs the real test/catalog commands, then removes its profile and file.
pub fn custom_agent_smoke(app: &tauri::AppHandle) {
    let Some(root) = std::env::var_os("TESSERA_CUSTOM_AGENT_SMOKE_ROOT").map(std::path::PathBuf::from) else {
        return;
    };
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let report = match custom_agent_smoke_run(&handle).await {
            Ok(value) => value,
            Err(error) => serde_json::json!({"ok": false, "error": error}),
        };
        let path = root.join("custom-agent-smoke.json");
        if let Err(error) = std::fs::write(&path, report.to_string()) {
            tracing::error!(%error, "could not write custom agent smoke result");
        }
        tracing::info!(%report, "custom agent smoke finished");
    });
}
async fn custom_agent_smoke_run(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    use crate::agent_commands as commands;
    let input = commands::AgentDefinitionInput {
        id: "git-tool".into(),
        name: "Git Tool".into(),
        binaries: vec!["git".into()],
        version_cmd: vec!["git".into(), "--version".into()],
        prompt_mode: "type".into(),
        model_flag: None,
        resume: vec![],
        yolo_flags: vec![],
        hooks: "none".into(),
        ready_pattern: None,
        install_url: "git".into(),
        docs_url: "https://".into(),
        icon: "terminal".into(),
        allow_override: false,
    };
    commands::agent_definition_save(app.clone(), input.clone())
        .await
        .map_err(|e| format!("save: {e:?}"))?;
    let detection =
        commands::agent_definition_test(app.clone(), vec!["git".into()], vec!["git".into(), "--version".into()])
            .await
            .map_err(|e| format!("test: {e:?}"))?;
    if !detection.found {
        return Err("git was not detected on the login PATH".into());
    }
    let catalog = commands::agent_catalog(app.clone(), true)
        .await
        .map_err(|e| format!("catalog: {e:?}"))?;
    let row = catalog
        .iter()
        .find(|agent| agent.id == "git-tool")
        .ok_or("git-tool missing from the catalog")?;
    if row.source != "user" || !row.installed {
        return Err(format!("unexpected catalog row: {row:?}"));
    }
    // Cleanup: the catalog scan auto-created a default profile, which blocks delete.
    for profile in commands::agent_profiles_list(app.clone(), Some("git-tool".into()))
        .await
        .map_err(|e| format!("profiles: {e:?}"))?
    {
        commands::agent_profile_delete(app.clone(), profile.id)
            .await
            .map_err(|e| format!("profile delete: {e:?}"))?;
    }
    commands::agent_definition_delete(app.clone(), "git-tool".into())
        .await
        .map_err(|e| format!("delete: {e:?}"))?;
    Ok(serde_json::json!({
        "ok": true,
        "saved": input.id,
        "detected": {
            "found": detection.found,
            "binary_path": detection.binary_path,
            "version": detection.version,
        },
        "catalog": {
            "id": row.id,
            "name": row.name,
            "source": row.source,
            "installed": row.installed,
            "version": row.version,
        },
        "cleaned_up": true,
    }))
}
