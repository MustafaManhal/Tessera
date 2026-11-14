//! Opt-in debug-only native command harness; no listener or interface exists in release builds.
use tauri::Manager;

pub fn start(app: &tauri::AppHandle) {
    let Some(root) = std::env::var_os("TESSERA_NATIVE_SMOKE_ROOT").map(std::path::PathBuf::from) else {
        return;
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let mut previous = String::new();
        while let Ok(text) = std::fs::read_to_string(root.join("request.json")) {
            if text != previous {
                previous = text.clone();
                let request: serde_json::Value = match serde_json::from_str(&text) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                let handle = app.clone();
                let out = root.join("response.json");
                if app.run_on_main_thread(move || {
                    use crate::native_commands::*;
                    let result = (|| -> Result<serde_json::Value, crate::error::AppError> {
                        match request["command"].as_str().unwrap_or("") {
                            "progress" => { window_set_progress(handle.clone(), serde_json::from_value(request["state"].clone()).map_err(|e| crate::error::AppError::new("smoke.input", e.to_string()))?, request["value"].as_f64().unwrap_or(50.0))?; }
                            "secure" => { secure_keyboard_entry_set(handle.state(), request["enabled"].as_bool().unwrap_or(false))?; }
                            "focus" => { if let Some(window) = handle.get_webview_window("main") { window.center().map_err(|e| crate::error::AppError::new("smoke.center", e.to_string()))?; } window_focus_main(handle.clone())?; }
                            "minimize" => { if let Some(w) = handle.get_webview_window("main") { w.minimize().map_err(|e| crate::error::AppError::new("smoke.minimize", e.to_string()))?; } }
                            "terminal_input" => {
                                let state = handle.state::<crate::state::AppState>();
                                let id = state.sessions.list().last().copied().ok_or_else(||crate::error::AppError::new("smoke.no_terminal", "No terminal has mounted."))?;
                                state.sessions.write(&id, b"echo TESSERA13_READY\r")?;
                            }
                            "menu" => {
                                use tauri::Listener;
                                let out=std::path::PathBuf::from(std::env::var_os("TESSERA_NATIVE_SMOKE_ROOT").unwrap()).join("menu-action.json");
                                for window in handle.webview_windows().into_values() {
                                    let out=out.clone();
                                    let label=window.label().to_owned();
                                    window.listen("menu:action",move |event|{let _=std::fs::write(&out,serde_json::json!({"window_id":label,"payload":event.payload()}).to_string());});
                                }
                                crate::menu_commands::menu_set(handle.clone(),vec![crate::menu_commands::ActionMenuItem{id:"tab.new".into(),label:"Task 16: New Tab".into(),accelerator:Some("Mod+Shift+N".into()),group:"File".into()},crate::menu_commands::ActionMenuItem{id:"pane.splitRight".into(),label:"Task 16: Split Right".into(),accelerator:Some("Mod+D".into()),group:"View".into()}])?;
                                let menu=handle.menu().unwrap();
                                let groups=menu.items().unwrap().iter().filter_map(|item|item.as_submenu().and_then(|m|m.text().ok())).collect::<Vec<_>>();
                                return Ok(serde_json::json!({"groups":groups}));
                            }
                            "menu_dispatch" => {
                                crate::menu_commands::on_action(&handle,"tessera.action.tab.new");
                            }
                            "windows_new" => {
                                let id=crate::window_commands::new_window(&handle)?;
                                crate::window_commands::window_set_title(handle.clone(),id.clone(),"Tessera task 16 secondary".into())?;
                                if let Some(main)=handle.get_webview_window("main") {
                                    crate::restore_commands::layout_save(handle.state(),"main".into(),"{}".into(),None)?;
                                    crate::window_commands::save_geometry(&main.as_ref().window(),true);
                                }
                                return Ok(serde_json::json!({"new_window":id,"windows":crate::window_commands::window_list(handle.clone())?}));
                            }
                            "transfer_close" => {
                                use tauri::Listener;
                                let source=handle.webview_windows().into_keys().find(|id|id!="main").ok_or_else(||crate::error::AppError::new("smoke.no_secondary","No secondary window"))?;
                                let target=handle.get_webview_window("main").unwrap();
                                let received=std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
                                let event=received.clone();
                                let listener=target.listen("tab:transferred",move |e|{*event.lock().unwrap()=Some(e.payload().to_owned());});
                                crate::window_commands::window_transfer_tab(handle.clone(),source.clone(),"main".into(),"{\"id\":\"fixture-tab\"}".into())?;
                                target.unlisten(listener);
                                crate::window_commands::window_close(handle.clone(),source)?;
                                return Ok(serde_json::json!({"received":*received.lock().unwrap(),"sessions":handle.state::<crate::state::AppState>().sessions.list().iter().map(|id|id.as_string()).collect::<Vec<_>>()}));
                            }
                            "windows_state" => {
                                return Ok(serde_json::json!({"windows":crate::window_commands::window_list(handle.clone())?,"sessions":handle.state::<crate::state::AppState>().sessions.list().iter().map(|id|id.as_string()).collect::<Vec<_>>()}));
                            }
                            "spawn" => {
                                let state=handle.state::<crate::state::AppState>();
                                let id=state.pty.spawn(tessera_pty::SpawnSpec::new(std::env::temp_dir()))?;
                                state.pty.write(&id,b"echo TESSERA16_RESTORE\r")?;
                                return Ok(serde_json::json!({"session_id":id.as_string()}));
                            }
                            "restore" => {
                                use crate::restore_commands::*;
                                layout_save(handle.state(), "smoke16".into(), "{ \"version\": 1, \"tabs\": [] }".into(), None)?;
                                let saved = layout_load(handle.state(), Some("smoke16".into()))?;
                                let completed = save_on_close(&handle);
                                let state=handle.state::<crate::state::AppState>();
                                let ids=state.sessions.list();
                                let bytes=ids.iter().map(|id|scrollback_load(handle.state(),id.as_string()).map(|b|b.as_bytes().len())).collect::<Result<Vec<_>,_>>()?;
                                return Ok(serde_json::json!({"layouts":saved,"completed":completed,"history_bytes":bytes}));
                            }
                            "exit" => { handle.exit(0); }
                            _ => {},
                        }
                        let terminal_echo = {
                            let state=handle.state::<crate::state::AppState>();
                            state.sessions.list().iter().any(|id|state.sessions.snapshot(id).is_ok_and(|bytes| bytes.windows(15).filter(|part|*part==b"TESSERA13_READY").count() >= 2))
                        };
                        Ok(serde_json::json!({"terminal_echo":terminal_echo,"session_daemon":handle.state::<crate::state::AppState>().sessions.uses_daemon(),"secure": secure_keyboard_entry_state(), "focused": handle.get_webview_window("main").and_then(|w| w.is_focused().ok()), "visible": handle.get_webview_window("main").and_then(|w|w.is_visible().ok()), "minimized":handle.get_webview_window("main").and_then(|w|w.is_minimized().ok())}))
                    })();
                    let response = serde_json::json!({"sequence": request["sequence"], "pid":std::process::id(), "result": result});
                    if let Err(error) = std::fs::write(out, response.to_string()) { tracing::error!(%error,"native smoke response failed"); }
                }).is_err() { break; }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    });
}
