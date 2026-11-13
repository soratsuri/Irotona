pub mod color;
pub mod commands;
pub mod csp;
pub mod csp_process;
pub mod input_hook;
mod palette_drag;
pub mod qr;
pub mod settings;
pub mod state;
pub mod status;
pub mod tray;

use std::thread;
use std::time::Duration;

use tauri::{Emitter, Listener, Manager, WindowEvent};

use state::AppState;
use status::Phase;

fn cli_qr_url() -> Option<String> {
    std::env::args()
        .nth(1)
        .filter(|a| a.starts_with("https://"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Second launch: surface the running app instead of staying silent.
            commands::show_status_settings(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::new())
        .setup(|app| {
            // Apply persisted settings to in-memory flags.
            let startup_settings = {
                let state: tauri::State<'_, AppState> = app.state();
                let s = state.settings.get();
                commands::RESTRICT_TO_CSP
                    .store(s.restrict_to_csp, std::sync::atomic::Ordering::Relaxed);
                s
            };

            // System tray.
            if let Err(e) = tray::install(&app.handle()) {
                eprintln!("[TRAY] install failed: {e}");
            }
            status::set(&app.handle(), Phase::WaitingForCsp);

            // The existing mouse hook observes the selected chord during a click.
            let eyedropper_settings_handle = app.handle().clone();
            let hook_handle = app.handle().clone();
            input_hook::install_eyedropper_click(
                move || {
                    let state: tauri::State<'_, AppState> = eyedropper_settings_handle.state();
                    let settings = state.settings.get();
                    (
                        settings.eyedropper_hotkey.unwrap_or_default(),
                        settings.palette_pinned,
                    )
                },
                move |x, y, action| commands::sample_after_eyedropper(&hook_handle, x, y, action),
            );

            let shortcut_settings_handle = app.handle().clone();
            let shortcut_action_handle = app.handle().clone();
            #[cfg(target_os = "windows")]
            let palette_hwnd = window_handle(app.handle(), "main");
            #[cfg(target_os = "windows")]
            let settings_hwnd = window_handle(app.handle(), "settings");
            input_hook::install_shortcut(
                move || {
                    let state: tauri::State<'_, AppState> = shortcut_settings_handle.state();
                    state.settings.get().global_hotkey
                },
                move || {
                    #[cfg(target_os = "windows")]
                    {
                        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
                        let foreground = unsafe { GetForegroundWindow() }.0 as isize;
                        if foreground == settings_hwnd
                            || (foreground != palette_hwnd
                                && (input_hook::is_text_focused()
                                    || (commands::RESTRICT_TO_CSP
                                        .load(std::sync::atomic::Ordering::Relaxed)
                                        && !input_hook::is_csp_foreground())))
                        {
                            return false;
                        }
                    }
                    true
                },
                move || {
                    let (x, y) = get_cursor_pos();
                    let app = shortcut_action_handle.clone();
                    let _ = shortcut_action_handle.run_on_main_thread(move || {
                        commands::toggle_palette(&app, x, y);
                    });
                },
            );

            // Wire tray menu events to app-level actions.
            let toggle_handle = app.handle().clone();
            app.listen("tray-toggle-restrict", move |_| {
                let cur = commands::RESTRICT_TO_CSP.load(std::sync::atomic::Ordering::Relaxed);
                commands::RESTRICT_TO_CSP.store(!cur, std::sync::atomic::Ordering::Relaxed);
                let _ = toggle_handle.emit("restrict-to-csp-changed", !cur);
            });

            let show_handle = app.handle().clone();
            app.listen("tray-show-palette", move |_| {
                // Tray left-click → sample at last known cursor via OS.
                let (x, y) = get_cursor_pos();
                commands::sample_and_show(&show_handle, x, y);
            });

            let rescan_handle = app.handle().clone();
            app.listen("tray-rescan-qr", move |_| {
                let state: tauri::State<'_, AppState> = rescan_handle.state();
                commands::disconnect_and_scan_qr(rescan_handle.clone(), state);
            });

            // CSP process watcher — pauses/resumes QR scanning as the user
            // opens and closes Clip Studio Paint.
            let proc_handle = app.handle().clone();
            csp_process::spawn_watcher(move |running| {
                let _ = proc_handle.emit("csp-process-status", running);
                let state: tauri::State<'_, AppState> = proc_handle.state();
                if running {
                    let connected = state
                        .csp
                        .lock()
                        .unwrap()
                        .as_ref()
                        .map(|c| c.connected)
                        .unwrap_or(false);
                    if !connected {
                        // CSP just appeared. Give it a few seconds to finish
                        // booting its Companion server, then try the saved
                        // session first (new generation, same IP) and only
                        // fall back to a full QR scan if that fails.
                        let app = proc_handle.clone();
                        thread::spawn(move || {
                            thread::sleep(Duration::from_secs(4));
                            let ok = {
                                let st: tauri::State<'_, AppState> = app.state();
                                commands::try_reconnect_session(app.clone(), st)
                            };
                            if !ok {
                                let app2 = app.clone();
                                let st: tauri::State<'_, AppState> = app.state();
                                commands::start_qr_scan(app2, st);
                            }
                        });
                    }
                } else {
                    if let Some(h) = state.qr_scan.lock().unwrap().take() {
                        h.stop();
                    }
                    let was_connected = {
                        let mut slot = state.csp.lock().unwrap();
                        let had = slot.is_some();
                        if let Some(mut c) = slot.take() {
                            c.disconnect();
                        }
                        had
                    };
                    let _ = proc_handle.emit(
                        "connection-status",
                        commands::ConnectionStatus {
                            status: "disconnected".into(),
                            message: Some("CSP not running".into()),
                        },
                    );
                    if was_connected {
                        status::set(&proc_handle, Phase::Disconnected("CSP closed".into()));
                    } else {
                        status::set(&proc_handle, Phase::WaitingForCsp);
                    }
                }
            });

            // Heartbeat thread — also watches for dropped connections and
            // auto-starts a QR re-scan when the socket dies (subject to CSP
            // process gating).
            let hb_handle = app.handle().clone();
            thread::spawn(move || loop {
                thread::sleep(Duration::from_secs(3));
                let state: tauri::State<'_, AppState> = hb_handle.state();
                let dropped = {
                    let mut slot = state.csp.lock().unwrap();
                    if let Some(conn) = slot.as_mut() {
                        conn.heartbeat();
                        if !conn.connected {
                            *slot = None;
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                };
                if dropped {
                    let _ = hb_handle.emit(
                        "connection-status",
                        commands::ConnectionStatus {
                            status: "disconnected".into(),
                            message: Some("socket dropped".into()),
                        },
                    );
                    status::set(&hb_handle, Phase::Disconnected("socket dropped".into()));
                    let scan_state: tauri::State<'_, AppState> = hb_handle.state();
                    commands::start_qr_scan(hb_handle.clone(), scan_state);
                }
            });

            // CLI arg: a QR URL bypasses the scan entirely.
            if let Some(url) = cli_qr_url() {
                let url_handle = app.handle().clone();
                thread::spawn(move || {
                    let state: tauri::State<'_, AppState> = url_handle.state();
                    if let Err(e) = commands::connect_via_qr_url(url, url_handle.clone(), state) {
                        eprintln!("[CLI] connect_via_qr_url failed: {e}");
                    }
                });
            }

            // Hide the main window when it loses focus (click-outside-to-dismiss).
            if let Some(win) = app.get_webview_window("main") {
                palette_drag::observe(&win);
                let win_clone = win.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::Focused(false) = event {
                        if palette_drag::protects_focus()
                            || win_clone.state::<AppState>().settings.get().palette_pinned
                        {
                            return;
                        }
                        let window = win_clone.clone();
                        // Allow a native caption press to enter the move loop
                        // before treating the focus change as an outside click.
                        thread::spawn(move || {
                            thread::sleep(Duration::from_millis(85));
                            if !palette_drag::protects_focus()
                                && !window.state::<AppState>().settings.get().palette_pinned
                                && !window.is_focused().unwrap_or(true)
                            {
                                let _ = window.hide();
                            }
                        });
                    }
                });
            }

            // Settings window closes to tray; the palette window keeps its own
            // click-outside-to-hide behavior above.
            if let Some(win) = app.get_webview_window("settings") {
                let win_clone = win.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win_clone.hide();
                    }
                });
            }

            if cli_qr_url().is_none() {
                commands::show_status_settings(&app.handle());
            } else if startup_settings.notify_on_startup {
                status::notify_startup(&app.handle(), &startup_settings.global_hotkey);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_snapshot,
            commands::open_status_settings,
            commands::close_status_settings,
            commands::mark_welcome_seen,
            commands::try_reconnect_session,
            commands::connect_via_qr_url,
            commands::get_csp_color,
            commands::poll_csp_color,
            commands::set_csp_color,
            commands::connection_status,
            commands::disconnect_csp,
            commands::disconnect_and_scan_qr,
            commands::set_restrict_to_csp,
            commands::get_restrict_to_csp,
            commands::get_settings,
            commands::set_wheel_type,
            commands::set_circle_model,
            commands::set_plane_options,
            commands::set_palette_pin,
            commands::set_palette_offset,
            commands::set_eyedropper_hotkey,
            commands::set_cycle_modes,
            commands::set_language,
            commands::set_global_hotkey,
            commands::set_palette_shortcut,
            commands::set_color_step,
            commands::show_palette_at_cursor,
            commands::finish_palette_summon,
            commands::start_qr_scan,
            commands::stop_qr_scan,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(target_os = "windows")]
fn get_cursor_pos() -> (i32, i32) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    unsafe {
        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);
        (pt.x, pt.y)
    }
}

#[cfg(not(target_os = "windows"))]
fn get_cursor_pos() -> (i32, i32) {
    (100, 100)
}

#[cfg(target_os = "windows")]
fn window_handle(app: &tauri::AppHandle, label: &str) -> isize {
    app.get_webview_window(label)
        .and_then(|window| window.hwnd().ok())
        .map_or(0, |hwnd| hwnd.0 as isize)
}
