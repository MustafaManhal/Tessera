//! Tessera desktop app: builds the Tauri app, registers plugins and IPC commands.
//!
//! Startup order (M0.4): resolve the data folder, create it, start logging,
//! write the dev-only TypeScript bindings and config schema, load `config.toml`
//! (never fatal), open the database and share both through `AppState`. A
//! database failure is returned from `setup`, so Tauri exits with the error
//! instead of running with a half-initialised app.

mod agent_commands;
mod agent_launch_commands;
#[cfg(debug_assertions)]
mod agent_smoke;
mod agent_status;
mod agent_types;
mod automation_commands;
#[cfg(debug_assertions)]
mod backend_smoke;
mod benchmark;
mod board_commands;
mod cli_commands;
mod commands;
mod diagnostics_commands;
mod editor_commands;
mod error;
mod feedback_commands;
mod git_commands;
mod github_commands;
mod hooks_commands;
mod import_commands;
mod issue_commands;
mod local_api;
mod logging;
mod mcp_commands;
mod menu_commands;
mod native_commands;
#[cfg(debug_assertions)]
mod native_smoke;
mod notification_commands;
#[cfg(debug_assertions)]
mod onboarding_smoke;
mod pr_commands;
#[cfg(debug_assertions)]
mod pr_smoke;
mod project_commands;
pub mod project_types;
mod prompt_commands;
mod pty_commands;
mod quick_terminal;
mod remote_projects;
mod restore_commands;
mod review_commands;
mod sessions;
mod settings_commands;
mod settings_types;
mod ssh_commands;
mod startup;
mod state;
mod sync_commands;
mod task_commands;
mod task_group_commands;
mod update_commands;
mod usage_commands;
mod window_commands;
mod window_effects;

#[cfg(debug_assertions)]
use std::path::PathBuf;
use std::sync::Mutex;

#[cfg(debug_assertions)]
use specta_typescript::Typescript;
use tauri::Manager;
use tauri_specta::{Builder, collect_commands, collect_events};
use tessera_store::{DataDirs, Store, data_dir_name};
use tracing_appender::non_blocking::WorkerGuard;

use crate::state::AppState;

/// Keeps the non-blocking log writer alive for the life of the app.
struct LogGuard {
    _guard: WorkerGuard,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let benchmark = std::sync::Arc::new(benchmark::Benchmark::new());
    let builder = Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            commands::app_info,
            hooks_commands::hooks_preview,
            hooks_commands::hooks_install,
            hooks_commands::hooks_remove,
            cli_commands::cli_install_status,
            cli_commands::cli_install,
            cli_commands::cli_uninstall,
            agent_commands::agent_catalog,
            agent_commands::agent_profiles_list,
            agent_commands::agent_profile_save,
            agent_commands::agent_profile_delete,
            agent_commands::agent_command_preview,
            agent_commands::agent_definition_get,
            agent_commands::agent_definition_save,
            agent_commands::agent_definition_delete,
            agent_commands::agent_definition_test,
            agent_launch_commands::agent_start,
            agent_launch_commands::agent_session_attach,
            agent_launch_commands::agent_session_exited,
            agent_launch_commands::agent_observe,
            agent_launch_commands::agent_restart,
            agent_launch_commands::agent_resume,
            agent_launch_commands::agent_sessions_list,
            menu_commands::menu_set,
            menu_commands::menu_list,
            window_commands::window_new,
            window_commands::window_list,
            window_commands::window_close,
            window_commands::window_set_title,
            window_effects::window_set_effect,
            window_commands::window_transfer_tab,
            restore_commands::layout_save,
            restore_commands::layout_load,
            restore_commands::layout_list,
            restore_commands::layout_delete,
            restore_commands::scrollback_load,
            restore_commands::scrollback_save_all,
            notification_commands::notifications_list,
            notification_commands::notifications_mark_read,
            notification_commands::notifications_clear,
            notification_commands::notifications_record,
            github_commands::github_connect_start,
            github_commands::github_connect_poll,
            github_commands::github_import_gh,
            github_commands::github_status,
            github_commands::github_disconnect,
            prompt_commands::prompts_list,
            prompt_commands::prompt_save,
            prompt_commands::prompt_delete,
            prompt_commands::prompt_used,
            prompt_commands::prompt_history_list,
            prompt_commands::prompt_history_add,
            prompt_commands::agent_event_append,
            native_commands::window_set_progress,
            native_commands::window_set_attention_count,
            native_commands::window_focus_main,
            native_commands::secure_keyboard_entry_set,
            native_commands::secure_keyboard_entry_state,
            pty_commands::pty_spawn,
            pty_commands::pty_attach,
            pty_commands::pty_live_session,
            ssh_commands::ssh_hosts_list,
            ssh_commands::ssh_host_save,
            ssh_commands::ssh_host_delete,
            ssh_commands::ssh_password_save,
            ssh_commands::ssh_password_forget,
            ssh_commands::ssh_connect_plan,
            sync_commands::sync_status,
            sync_commands::sync_sign_in_start,
            sync_commands::sync_sign_in_poll,
            sync_commands::sync_recovery_create,
            sync_commands::sync_recovery_enter,
            sync_commands::sync_set_docs,
            sync_commands::sync_sign_out,
            sync_commands::sync_delete_all,
            sync_commands::sync_now,
            pty_commands::pty_resize,
            pty_commands::pty_ack,
            pty_commands::pty_kill,
            pty_commands::shell_list,
            git_commands::git_repo_info,
            git_commands::git_branches,
            git_commands::worktree_remove,
            git_commands::git_status,
            git_commands::worktree_list,
            settings_commands::settings_get,
            project_commands::project_list,
            project_commands::project_add,
            remote_projects::project_add_remote,
            project_commands::project_clone_cancel,
            project_commands::project_git_init,
            project_commands::project_update,
            project_commands::project_remove,
            project_commands::project_approve_setup,
            project_commands::run_script_list,
            project_commands::run_script_add,
            project_commands::run_script_update,
            project_commands::run_script_remove,
            review_commands::review_files,
            review_commands::git_review_index,
            review_commands::git_review_hunks,
            review_commands::git_stage,
            review_commands::git_unstage,
            review_commands::git_discard,
            review_commands::git_commit,
            review_commands::review_comments_list,
            review_commands::review_comment_add,
            review_commands::review_comment_update,
            review_commands::review_comment_delete,
            review_commands::review_comments_prepare,
            review_commands::review_comments_send,
            review_commands::review_file_diff,
            task_commands::task_create,
            task_group_commands::task_group_create,
            task_group_commands::task_groups_list,
            task_group_commands::task_group_pick,
            automation_commands::automations_list,
            automation_commands::automation_save,
            automation_commands::automation_delete,
            automation_commands::automation_runs,
            automation_commands::automation_run_now,
            issue_commands::linear_connect,
            issue_commands::linear_status,
            issue_commands::linear_disconnect,
            issue_commands::issues_list,
            mcp_commands::manager_call,
            issue_commands::task_set_issue,
            board_commands::board_tasks,
            board_commands::task_set_column,
            diagnostics_commands::diagnostics_report,
            feedback_commands::feedback_send,
            diagnostics_commands::privacy_settings,
            diagnostics_commands::privacy_set_usage_stats,
            update_commands::update_settings,
            update_commands::update_settings_set,
            update_commands::update_check,
            update_commands::update_pending,
            update_commands::update_install,
            update_commands::app_relaunch,
            usage_commands::task_usage,
            usage_commands::handoff_summary,
            import_commands::import_sources,
            import_commands::import_preview,
            import_commands::import_apply,
            import_commands::onboarding_state,
            import_commands::onboarding_complete,
            import_commands::onboarding_reset,
            pr_commands::pr_create,
            pr_commands::pr_refresh,
            pr_commands::pr_checks,
            pr_commands::pr_failure_log,
            pr_commands::pr_merge,
            pr_commands::pr_merge_local,
            task_commands::task_list,
            task_commands::task_archive,
            task_commands::task_restore,
            task_commands::task_delete,
            task_commands::task_rename,
            task_commands::task_ports,
            editor_commands::open_in_editor,
            editor_commands::reveal_in_files,
            settings_commands::settings_set,
            quick_terminal::quick_terminal_toggle,
            quick_terminal::quick_terminal_hide,
            quick_terminal::quick_terminal_visible,
            quick_terminal::quick_terminal_set_reduced_motion
        ])
        .events(collect_events![
            task_commands::TaskChanged,
            review_commands::ReviewGitChanged,
            task_group_commands::TaskGroupInfo,
            update_commands::UpdateAvailable,
            update_commands::UpdateProgress,
            automation_commands::AutomationFired,
            automation_commands::AutomationChanged,
            agent_commands::AgentsChanged,
            agent_launch_commands::AgentSessionChanged,
            window_commands::TabTransferred,
            menu_commands::MenuAction,
            settings_commands::ConfigChanged,
            settings_commands::ConfigErrorEvent
        ]);

    benchmark.record("commands_ready");
    let experiments = startup::Experiments::from_environment();
    let mut context = tauri::generate_context!();
    if experiments.hidden || experiments.force_visible {
        for window in &mut context.config_mut().app.windows {
            if window.label == "main" {
                window.visible = experiments.force_visible;
            }
        }
    }
    for window in &mut context.config_mut().app.windows {
        window.decorations = !cfg!(target_os = "windows");
        if window.label == "main" {
            // Build after settings load so fully opaque windows use the normal native surface.
            window.create = false;
        }
    }
    let mut application = tauri::Builder::default()
        .plugin(benchmark::plugin())
        .on_menu_event(|app, event| menu_commands::on_action(app, event.id().as_ref()));
    if !experiments.deferred {
        application = application
            .plugin(tauri_plugin_opener::init())
            .plugin(tauri_plugin_notification::init())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(quick_terminal::plugin());
        #[cfg(target_os = "macos")]
        {
            application = application.plugin(tauri_nspanel::init());
        }
    }
    #[cfg(debug_assertions)]
    if std::env::var_os("TESSERA_AGENT_SMOKE_ROOT").is_some() {
        application = application.plugin(agent_smoke::plugin());
    }
    application
        .manage(experiments)
        .invoke_handler({
            // `pty_write` takes a raw body, which tauri-specta cannot type, so it is routed by hand.
            let typed = builder.invoke_handler();
            let raw_write: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> =
                Box::new(tauri::generate_handler![
                    pty_commands::pty_write,
                    benchmark::benchmark_dom_ready,
                    benchmark::benchmark_first_paint,
                    benchmark::benchmark_mark
                ]);
            move |invoke| {
                #[cfg(debug_assertions)]
                if invoke.message.command() == "review_smoke_result" {
                    return review_commands::handle_smoke(invoke);
                }
                #[cfg(debug_assertions)]
                if matches!(
                    invoke.message.command(),
                    "group_smoke_fixture" | "agent_smoke_result" | "agent_smoke_fixture" | "hooks_smoke_files"
                ) {
                    return agent_smoke::handle(invoke);
                }
                if matches!(
                    invoke.message.command(),
                    "pty_write" | "benchmark_dom_ready" | "benchmark_first_paint" | "benchmark_mark"
                ) {
                    raw_write(invoke)
                } else {
                    typed(invoke)
                }
            }
        })
        .setup(move |app| {
            benchmark.record("setup_begin");
            app.manage(benchmark);
            setup(app, &builder)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == quick_terminal::LABEL {
                // Hidden, never closed; its geometry follows the active screen, so it is not saved.
                quick_terminal::on_window_event(window, event);
                return;
            }
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                window_commands::save_geometry(window, true);
            } else if matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)) {
                window_commands::save_geometry(window, false);
            }
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                restore_commands::save_on_close(window.app_handle());
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                quick_terminal::release_with_last_window(window.app_handle(), window.label());
                if let Some(state) = window.try_state::<AppState>() {
                    // Closing one of several windows ends its sessions; the last window closing means the app quits,
                    // and daemon sessions then wait for the next start.
                    let last = !window
                        .app_handle()
                        .webview_windows()
                        .into_keys()
                        .any(|label| label != window.label() && label != quick_terminal::LABEL);
                    state.sessions.window_closed(window.label(), last);
                    if last
                        && !window
                            .try_state::<settings_commands::Settings>()
                            .is_some_and(|settings| settings.keep_sessions_running())
                    {
                        state.sessions.end_background_sessions();
                    }
                }
                if let Some(effects) = window.try_state::<window_effects::WindowEffects>() {
                    effects.remove(window.label());
                }
            }
            if let tauri::WindowEvent::Focused(active) = event
                && let Some(secure) = window.try_state::<native_commands::SecureKeyboard>()
            {
                secure.focus(
                    *active
                        || window
                            .app_handle()
                            .webview_windows()
                            .values()
                            .any(|other| other.label() != window.label() && other.is_focused().unwrap_or(false)),
                );
            }
        })
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                restore_commands::save_on_close(app);
            }
            if matches!(event, tauri::RunEvent::Exit) {
                // On macOS the app menu's Quit item (Cmd+Q) reaches AppKit's `terminate:`, which destroys the loop
                // without an `ExitRequested`; saving here covers that path. The gate shares one budget across both.
                restore_commands::save_on_close(app);
                if let Some(state) = app.try_state::<AppState>()
                    && !app
                        .try_state::<settings_commands::Settings>()
                        .is_some_and(|settings| settings.keep_sessions_running())
                {
                    // Nothing was asked to keep running: do not leave the session daemon behind.
                    state.sessions.end_background_sessions();
                }
                app.state::<native_commands::SecureKeyboard>().shutdown();
                local_api::stop(app);
            }
        });
}

fn setup(app: &mut tauri::App, builder: &Builder<tauri::Wry>) -> Result<(), Box<dyn std::error::Error>> {
    let benchmark = app.state::<std::sync::Arc<benchmark::Benchmark>>();
    benchmark.record("data_dirs_begin");
    let data_root = match benchmark.data_root() {
        Some(root) => root,
        None => app.path().data_dir()?.join(data_dir_name(cfg!(debug_assertions))),
    };
    let dirs = DataDirs::from_root(data_root);
    dirs.create()?;

    benchmark.record("data_dirs_ready");
    let pty = tessera_pty::PtyHost::new();
    // Connect to (or start) the session daemon while the rest of setup and the webview load run.
    let sessions = std::sync::Arc::new(sessions::Sessions::new(pty.clone(), &dirs.root));
    sessions.connect_in_background();
    benchmark.record("login_environment_begin");
    let probe_bench = std::sync::Arc::clone(&benchmark);
    pty.start_login_environment_observed(&dirs.root, std::sync::Arc::new(move |phase| probe_bench.record(phase)));
    benchmark.record("login_environment_background_started");
    let prepared_host = pty.clone();
    let prepared_bench = std::sync::Arc::clone(&benchmark);
    if let Err(error) = std::thread::Builder::new()
        .name("tessera-session-prewarm".into())
        .spawn(move || {
            prepared_bench.record("session_prewarm_begin");
            if let Err(error) = prepared_host.prewarm_default_session() {
                tracing::warn!(%error,"session prewarm unavailable; spawn will prepare its own");
            }
            prepared_bench.record("session_prewarm_ready");
        })
    {
        tracing::warn!(%error,"could not start session prewarm");
    }
    let script_root = dirs.root.clone();
    let script_bench = std::sync::Arc::clone(&benchmark);
    if let Err(error) = std::thread::Builder::new()
        .name("tessera-shell-scripts".into())
        .spawn(move || {
            script_bench.record("shell_scripts_prewarm_begin");
            if let Err(error) = tessera_shell::write_scripts(&script_root) {
                tracing::warn!(%error,"shell integration prewarm failed");
            }
            script_bench.record("shell_scripts_prewarm_ready");
        })
    {
        tracing::warn!(%error,"could not start shell integration prewarm");
    }

    benchmark.record("logging_begin");
    let log_guard = logging::init_logging(&dirs)?;
    app.manage(LogGuard { _guard: log_guard });

    benchmark.record("logging_ready");
    #[cfg(debug_assertions)]
    export_dev_artifacts(builder);

    builder.mount_events(app);
    benchmark.record("config_begin");
    app.manage(settings_commands::Settings::start(&dirs.config, app.handle().clone())?);

    benchmark.record("config_ready");
    benchmark.record("store_begin");
    let store = match Store::open_observed(&dirs, &|phase| benchmark.record(phase)) {
        Ok(store) => store,
        Err(error) => {
            tracing::error!(error = %error, "could not open the database");
            return Err(error.into());
        }
    };
    benchmark.record("store_ready");
    // The inbox keeps 14 days (05-backend-schema): prune once at start.
    if let Err(error) = store.notifications().prune(tessera_store::repositories::now_seconds()) {
        tracing::warn!(%error, "could not prune old notifications");
    }
    app.manage(project_commands::Clones::default());
    app.manage(pr_commands::PrCache::default());
    app.manage(agent_commands::Agents::default());
    app.manage(hooks_commands::Hooks::default());
    app.manage(agent_status::AgentEngines::default());
    app.manage(task_commands::Tasks::default());
    app.manage(restore_commands::SnapshotGate::default());
    app.manage(AppState {
        store: Mutex::new(store),
        dirs,
        pty,
        sessions,
    });

    local_api::start(app.handle());
    #[cfg(debug_assertions)]
    review_commands::start_smoke(app.handle());
    #[cfg(debug_assertions)]
    mcp_commands::start_smoke(app.handle());
    app.manage(menu_commands::MenuRegistry::default());
    app.manage(window_commands::WindowLabels::default());
    app.manage(window_commands::GeometryThrottle::default());
    app.manage(window_effects::WindowEffects::default());
    app.manage(quick_terminal::QuickTerminal::default());
    if let Some(main) = app.config().app.windows.iter().find(|window| window.label == "main") {
        window_effects::builder(app.handle(), main)
            .map_err(|error| std::io::Error::other(error.message))?
            .build()?;
        benchmark.record("window");
    }
    if let Err(error) = window_commands::restore_windows(app.handle()) {
        tracing::warn!(code = error.code, "could not restore native windows");
    }
    let secure = native_commands::SecureKeyboard::default();
    secure.focus(
        app.get_webview_window("main")
            .and_then(|w| w.is_focused().ok())
            .unwrap_or(false),
    );
    app.manage(secure);
    benchmark.record("watchers_begin");
    task_commands::reconcile_watchers(app.handle());
    sync_commands::start_background(app.handle());
    remote_projects::install(app.handle());
    automation_commands::start(app.handle());
    app.manage(update_commands::UpdateState::default());
    update_commands::start(app.handle());
    benchmark.record("watchers_ready");
    // Debug-only harnesses: none of this exists in a release build.
    #[cfg(debug_assertions)]
    {
        backend_smoke::start(app.handle());
        agent_smoke::custom_agent_smoke(app.handle());
        pr_smoke::start(app.handle());
        onboarding_smoke::start(app.handle());
        native_smoke::start(app.handle());
    }

    if app
        .try_state::<tauri_plugin_global_shortcut::GlobalShortcut<tauri::Wry>>()
        .is_some()
    {
        quick_terminal::start(app.handle());
    }
    benchmark.start(app.handle());
    benchmark.record("setup_complete");
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        dev_build = cfg!(debug_assertions),
        "Tessera started"
    );
    Ok(())
}

/// Writes the generated TypeScript bindings and the config JSON Schema into
/// `packages/ipc` in a debug build. The repo root comes from the compile-time
/// manifest path, so it works from any working directory.
///
/// A failure only logs: the app is still usable, and `pnpm check` catches a
/// stale or missing generated file.
#[cfg(debug_assertions)]
fn export_dev_artifacts(builder: &Builder<tauri::Wry>) {
    let root = repo_root();

    let bindings_path = root.join("packages/ipc/src/bindings.ts");
    if let Some(parent) = bindings_path.parent()
        && let Err(error) = std::fs::create_dir_all(parent)
    {
        tracing::error!(path = %parent.display(), %error, "could not create the IPC bindings folder");
        return;
    }
    match builder.export(Typescript::default(), &bindings_path) {
        Ok(()) => tracing::info!(path = %bindings_path.display(), "wrote TypeScript IPC bindings"),
        Err(error) => {
            tracing::error!(path = %bindings_path.display(), %error, "could not write IPC bindings");
        }
    }

    let schema_path = root.join("packages/ipc/schema/config.schema.json");
    if let Some(parent) = schema_path.parent()
        && let Err(error) = std::fs::create_dir_all(parent)
    {
        tracing::error!(path = %parent.display(), %error, "could not create the schema folder");
        return;
    }
    match std::fs::write(&schema_path, format!("{}\n", tessera_store::config_json_schema())) {
        Ok(()) => tracing::info!(path = %schema_path.display(), "wrote the config JSON Schema"),
        Err(error) => {
            tracing::error!(path = %schema_path.display(), %error, "could not write the config JSON Schema");
        }
    }
}

#[cfg(debug_assertions)]
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
