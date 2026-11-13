use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::csp::crypto::decode_qr_url;
use crate::csp::framing::MsgType;
use crate::csp::session::{clear_session, load_session, session_path};
use crate::csp::CSPConnection;
use crate::csp_process;
use crate::input_hook;
use crate::qr;
use crate::settings;
use crate::state::AppState;
use crate::status::{self, Phase};

const QR_PREFIX: &str = "https://companion.clip-studio.com/";

// Kept for backward-compatibility with the ALT+click hook path; mirrored from
// settings.restrict_to_csp on load.
pub static RESTRICT_TO_CSP: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone)]
pub struct ConnectionStatus {
    pub status: String, // "disconnected" | "connected"
    pub message: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct PortableInfo {
    pub exe_dir: Option<String>,
    pub settings_path: Option<String>,
    pub session_path: String,
    pub exe_dir_writable: bool,
}

#[derive(Serialize, Clone)]
pub struct AppSnapshot {
    pub settings: crate::settings::Settings,
    pub phase: crate::status::PhasePayload,
    pub portable: PortableInfo,
    pub csp_running: bool,
    pub connected: bool,
}

fn emit_status(app: &AppHandle, status: &str, message: Option<String>) {
    let _ = app.emit(
        "connection-status",
        ConnectionStatus {
            status: status.to_string(),
            message,
        },
    );
}

fn portable_info() -> PortableInfo {
    PortableInfo {
        exe_dir: settings::exe_dir().map(|p| p.display().to_string()),
        settings_path: settings::settings_path().map(|p| p.display().to_string()),
        session_path: session_path().display().to_string(),
        exe_dir_writable: settings::exe_dir_is_writable(),
    }
}

#[tauri::command]
pub fn get_app_snapshot(state: State<'_, AppState>) -> AppSnapshot {
    let phase = status::current();
    let connected = state
        .csp
        .try_lock()
        .map(|slot| slot.as_ref().is_some_and(|c| c.connected))
        .unwrap_or(phase.phase == "connected");
    AppSnapshot {
        settings: state.settings.get(),
        phase,
        portable: portable_info(),
        csp_running: csp_process::is_running(),
        connected,
    }
}

pub fn show_status_settings(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[tauri::command]
pub fn open_status_settings(app: AppHandle) {
    show_status_settings(&app);
}

#[tauri::command]
pub fn close_status_settings(app: AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.hide();
    }
}

#[tauri::command]
pub fn mark_welcome_seen(state: State<'_, AppState>) {
    if !state.settings.get().has_seen_welcome {
        state.settings.update(|s| s.has_seen_welcome = true);
    }
}

#[derive(Serialize, Clone)]
pub struct RgbTuple {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

#[derive(Serialize, Clone)]
pub struct ColorUpdate {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    /// 0 = main/foreground, 1 = sub/background — which slot CSP currently has
    /// selected. Frontend uses it for the status label.
    pub slot: u8,
    pub sample_request: u64,
}

fn emit_color(app: &AppHandle, rgb: (u8, u8, u8), slot: u8, sample_request: u64) {
    let _ = app.emit(
        "color-update",
        ColorUpdate {
            r: rgb.0,
            g: rgb.1,
            b: rgb.2,
            slot,
            sample_request,
        },
    );
}

#[tauri::command]
pub fn try_reconnect_session(app: AppHandle, state: State<'_, AppState>) -> bool {
    let already_connected = state
        .csp
        .lock()
        .unwrap()
        .as_ref()
        .map(|c| c.connected)
        .unwrap_or(false);
    if already_connected {
        return true;
    }

    if !csp_process::is_running() {
        // Skip silently — the csp_process watcher will invoke us again once
        // CSP appears, and we don't want to ECONNREFUSED-log on every launch
        // while CSP is closed.
        return false;
    }
    let Some(sess) = load_session() else {
        return false;
    };
    println!(
        "[SESSION] Trying saved session {}:{}...",
        sess.host, sess.port
    );
    let mut conn = CSPConnection::new(sess.host, sess.port, sess.password, sess.generation, true);
    status::set(&app, Phase::Reconnecting);
    match conn.connect() {
        Ok(()) if conn.connected => {
            let host = conn.host.clone();
            if let Some(h) = state.qr_scan.lock().unwrap().take() {
                h.stop();
            }
            let mut slot = state.csp.lock().unwrap();
            *slot = Some(conn);
            emit_status(&app, "connected", Some("reconnected".into()));
            status::set(&app, Phase::Connected(host));
            println!("[SESSION] Reconnected without QR.");
            true
        }
        Ok(()) => {
            // Auth failure: session is genuinely bad, forget it.
            clear_session();
            false
        }
        Err(e) => {
            // Network-level failure (CSP not ready, port moved, router change).
            // Keep the session — the next attempt may succeed; the QR-scan
            // fallback will recover if it doesn't.
            println!("[SESSION] Saved session failed (keeping): {e}");
            false
        }
    }
}

#[tauri::command]
pub fn connect_via_qr_url(
    url: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let cfg = decode_qr_url(&url)?;
    let host = cfg.ips.first().cloned().ok_or("no IP")?;
    println!(
        "[QR] IP: {:?}, Port: {}, Gen: {}",
        cfg.ips, cfg.port, cfg.generation
    );
    let mut conn = CSPConnection::new(host, cfg.port, cfg.password, cfg.generation, false);
    conn.connect()?;
    if !conn.connected {
        return Err("connection lost after auth".into());
    }
    let host = conn.host.clone();
    let mut slot = state.csp.lock().unwrap();
    *slot = Some(conn);
    emit_status(&app, "connected", Some("qr".into()));
    status::set(&app, Phase::Connected(host));
    Ok(())
}

#[tauri::command]
pub async fn get_csp_color(app: AppHandle) -> Option<RgbTuple> {
    let worker_app = app.clone();
    let (rgb, idx, sample_request) = tauri::async_runtime::spawn_blocking(move || {
        let state: State<'_, AppState> = worker_app.state();
        let mut slot = state.csp.lock().unwrap();
        let conn = slot.as_mut()?;
        let rgb = conn.get_color_rgb()?;
        let idx = conn.color_index();
        // Advance only after a fresh color was read, while holding the same
        // connection lock used by writes. A failed read never strands callers
        // on a generation that the frontend did not receive.
        let sample_request = COLOR_SAMPLE_REQUEST.fetch_add(1, Ordering::AcqRel) + 1;
        Some((rgb, idx, sample_request))
    })
    .await
    .ok()??;
    emit_color(&app, rgb, idx, sample_request);
    Some(RgbTuple {
        r: rgb.0,
        g: rgb.1,
        b: rgb.2,
    })
}

#[tauri::command]
pub async fn poll_csp_color(app: AppHandle, sample_request: u64) -> Option<ColorUpdate> {
    let Some(window) = app.get_webview_window("main") else {
        passive_sync_diagnostic("main window is unavailable");
        return None;
    };
    if !window.is_visible().unwrap_or(false) {
        passive_sync_diagnostic("main window is hidden");
        return None;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state: State<'_, AppState> = app.state();
        if !is_current_color_request(sample_request, &COLOR_SAMPLE_REQUEST) {
            passive_sync_diagnostic("poll discarded because its sample generation is stale");
            return None;
        }
        if !state.settings.get().palette_pinned {
            passive_sync_diagnostic("poll skipped because the palette is unpinned");
            return None;
        }
        if !input_hook::is_csp_foreground() {
            passive_sync_diagnostic("poll skipped because CSP is not foreground");
            return None;
        }
        // Skip a tick when an explicit sample, write or heartbeat owns the
        // connection. Passive reads never reserve a write generation.
        let mut connection = match state.csp.try_lock() {
            Ok(connection) => connection,
            Err(_) => {
                passive_sync_diagnostic("poll skipped because the CSP connection is busy");
                return None;
            }
        };
        let Some(conn) = connection.as_mut().filter(|conn| conn.connected) else {
            passive_sync_diagnostic("poll skipped because CSP is disconnected");
            return None;
        };
        let (r, g, b) = match conn.poll_color_rgb() {
            Ok(rgb) => rgb,
            Err(reason) => {
                passive_sync_diagnostic(reason);
                return None;
            }
        };
        if !is_current_color_request(sample_request, &COLOR_SAMPLE_REQUEST)
            || !state.settings.get().palette_pinned
            || !input_hook::is_csp_foreground()
            || !window.is_visible().unwrap_or(false)
        {
            passive_sync_diagnostic(
                "poll result discarded because foreground, visibility, pin, or generation changed",
            );
            return None;
        }
        passive_sync_diagnostic("CSP color read completed");
        Some(ColorUpdate {
            r,
            g,
            b,
            slot: conn.color_index(),
            sample_request,
        })
    })
    .await
    .ok()?
}

#[tauri::command]
pub async fn set_csp_color(
    hex: String,
    sample_request: u64,
    preserved_hue: Option<f64>,
    app: AppHandle,
) -> Result<bool, String> {
    if hex.len() != 7
        || !hex.starts_with('#')
        || !hex.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
    {
        return Err("invalid_color".into());
    }
    if !is_current_color_request(sample_request, &COLOR_SAMPLE_REQUEST) {
        return Ok(false);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state: State<'_, AppState> = app.state();
        let mut slot = state.csp.lock().unwrap();
        // A new sample may have begun while this IPC command waited for the
        // connection lock. Drop the old drag color before it can overwrite it.
        if !is_current_color_request(sample_request, &COLOR_SAMPLE_REQUEST) {
            return Ok(false);
        }
        let conn = slot
            .as_mut()
            .filter(|c| c.connected)
            .ok_or("not_connected")?;
        let response = conn.set_color_hex_with_hue(&hex, preserved_hue);
        // A successful acknowledgement is still superseded if a newer sample
        // began while the synchronous CSP request was on the wire. The sample
        // worker follows under this mutex and reads the authoritative CSP state.
        if !is_current_color_request(sample_request, &COLOR_SAMPLE_REQUEST) {
            return Ok(false);
        }
        match response {
            Some(reply) if reply.msg_type == MsgType::Success => Ok(true),
            Some(_) => Err("color_rejected".into()),
            None => Err("color_no_response".into()),
        }
    })
    .await
    .map_err(|_| "color_worker_failed".to_string())?
}

#[tauri::command]
pub fn connection_status(state: State<'_, AppState>) -> &'static str {
    let slot = state.csp.lock().unwrap();
    match slot.as_ref() {
        Some(c) if c.connected => "connected",
        _ => "disconnected",
    }
}

#[tauri::command]
pub fn disconnect_csp(app: AppHandle, state: State<'_, AppState>) {
    let mut slot = state.csp.lock().unwrap();
    if let Some(c) = slot.as_mut() {
        c.disconnect();
    }
    *slot = None;
    status::set(&app, Phase::Disconnected("user".into()));
}

#[tauri::command]
pub fn disconnect_and_scan_qr(app: AppHandle, state: State<'_, AppState>) {
    clear_session();

    if let Some(h) = state.qr_scan.lock().unwrap().take() {
        h.stop();
    }

    {
        let mut slot = state.csp.lock().unwrap();
        if let Some(mut conn) = slot.take() {
            conn.disconnect();
        }
    }

    emit_status(&app, "disconnected", Some("saved pairing cleared".into()));

    if !csp_process::is_running() {
        emit_scan_status(&app, false, Some("waiting for CSP process"));
        status::set(&app, Phase::WaitingForCsp);
        println!("[QR] pairing cleared; waiting for CSP process");
        return;
    }

    start_qr_scan(app, state);
}

#[derive(Serialize, Clone)]
pub struct ShowPalettePayload {
    pub x: i32,
    pub y: i32,
    pub r: Option<u8>,
    pub g: Option<u8>,
    pub b: Option<u8>,
    pub slot: Option<u8>,
    pub after_eyedropper: bool,
    pub sample_request: u64,
    pub show_request: u64,
}

#[derive(Default)]
struct PaletteVisibility {
    request: u64,
    pending: Option<bool>,
}

impl PaletteVisibility {
    fn request(&mut self, visible: bool) -> u64 {
        self.request += 1;
        self.pending = Some(visible);
        self.request
    }

    fn finish(&mut self, request: u64) {
        if self.request == request {
            self.pending = None;
        }
    }
}

static PALETTE_VISIBILITY: std::sync::Mutex<PaletteVisibility> =
    std::sync::Mutex::new(PaletteVisibility {
        request: 0,
        pending: None,
    });
static COLOR_SAMPLE_REQUEST: AtomicU64 = AtomicU64::new(0);
static LAST_PASSIVE_SYNC_DIAGNOSTIC: AtomicU64 = AtomicU64::new(0);

fn passive_sync_diagnostic(reason: &'static str) {
    let interval = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        / 30;
    let interval = interval.max(1);
    if LAST_PASSIVE_SYNC_DIAGNOSTIC.swap(interval, Ordering::Relaxed) != interval {
        eprintln!("[CSP color sync] {reason}");
    }
}

fn is_current_color_request(sample_request: u64, latest: &AtomicU64) -> bool {
    sample_request == latest.load(Ordering::Acquire)
}

pub fn sample_and_show(app: &AppHandle, x: i32, y: i32) {
    if RESTRICT_TO_CSP.load(Ordering::Relaxed) && !input_hook::is_csp_foreground() {
        return;
    }

    sample_and_show_unrestricted(app, x, y, false);
}

fn sample_and_show_unrestricted(app: &AppHandle, x: i32, y: i32, after_eyedropper: bool) {
    sample_palette(app, x, y, after_eyedropper, false);
}

fn sample_palette(app: &AppHandle, x: i32, y: i32, after_eyedropper: bool, sync_only: bool) {
    let request = {
        let mut visibility = PALETTE_VISIBILITY.lock().unwrap();
        if sync_only {
            visibility.request
        } else {
            visibility.request(true)
        }
    };
    let sample_request = COLOR_SAMPLE_REQUEST.fetch_add(1, Ordering::AcqRel) + 1;
    let app_bg = app.clone();
    std::thread::spawn(move || {
        // Let CSP's own eyedropper commit before we sample. Other ways of
        // opening the palette have no eyedropper to wait for.
        if after_eyedropper {
            std::thread::sleep(std::time::Duration::from_millis(180));
        }
        let state: State<'_, AppState> = app_bg.state();
        let (rgb, slot_idx, sample_request) = {
            let mut slot = state.csp.lock().unwrap();
            if PALETTE_VISIBILITY.lock().unwrap().request != request {
                return;
            }
            let (rgb, slot_idx) = if sync_only && !state.settings.get().palette_pinned {
                (None, None)
            } else {
                match slot.as_mut() {
                    Some(c) => (c.get_color_rgb(), Some(c.color_index())),
                    None => (None, None),
                }
            };
            if PALETTE_VISIBILITY.lock().unwrap().request != request {
                return;
            }
            // The reservation at request start invalidates queued old writes.
            // If another successful read completed first, give this later
            // sample a newer generation before releasing the connection lock.
            let sample_request = if rgb.is_some()
                && COLOR_SAMPLE_REQUEST.load(Ordering::Acquire) != sample_request
            {
                COLOR_SAMPLE_REQUEST.fetch_add(1, Ordering::AcqRel) + 1
            } else {
                sample_request
            };
            (rgb, slot_idx, sample_request)
        };
        if PALETTE_VISIBILITY.lock().unwrap().request != request {
            return;
        }
        let _ = app_bg.emit(
            if sync_only {
                "pinned-color-sample"
            } else {
                "show-palette"
            },
            ShowPalettePayload {
                x,
                y,
                r: rgb.map(|c| c.0),
                g: rgb.map(|c| c.1),
                b: rgb.map(|c| c.2),
                slot: slot_idx,
                after_eyedropper,
                sample_request,
                show_request: request,
            },
        );
    });
}

pub fn sample_after_eyedropper(
    app: &AppHandle,
    x: i32,
    y: i32,
    action: input_hook::EyedropperAction,
) {
    sample_palette(
        app,
        x,
        y,
        true,
        action == input_hook::EyedropperAction::SyncPinned,
    );
}

#[tauri::command]
pub fn show_palette_at_cursor(app: AppHandle) {
    let (x, y) = get_cursor_pos();
    sample_and_show_unrestricted(&app, x, y, false);
}

pub fn toggle_palette(app: &AppHandle, x: i32, y: i32) {
    if let Some(win) = app.get_webview_window("main") {
        let visible = win.is_visible().unwrap_or(false);
        if app.state::<AppState>().settings.get().palette_pinned {
            if visible {
                let _ = win.set_focus();
            } else {
                let _ = win.emit("focus-pinned-palette", [x, y]);
            }
            return;
        }
        let hide_request = {
            let mut visibility = PALETTE_VISIBILITY.lock().unwrap();
            visibility
                .pending
                .unwrap_or(visible)
                .then(|| visibility.request(false))
        };
        if let Some(request) = hide_request {
            let _ = win.emit("hide-palette", request);
            return;
        }
    }
    sample_and_show_unrestricted(app, x, y, false);
}

#[tauri::command]
pub fn finish_palette_summon(window: tauri::WebviewWindow, request: u64) {
    if window.label() == "main" {
        PALETTE_VISIBILITY.lock().unwrap().finish(request);
    }
}

#[tauri::command]
pub fn set_palette_pin(app: AppHandle, pinned: Option<bool>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let settings = state.settings.get();
    let enabled = pinned.unwrap_or(settings.palette_pinned);
    if pinned.is_none() && !enabled {
        return Ok(());
    }
    let position = if enabled {
        let win = app
            .get_webview_window("main")
            .ok_or("missing palette window")?;
        let pos = win.outer_position().map_err(|error| error.to_string())?;
        Some([pos.x, pos.y])
    } else {
        settings.pinned_position
    };
    if settings.palette_pinned != enabled || settings.pinned_position != position {
        state.settings.update(|s| {
            s.palette_pinned = enabled;
            s.pinned_position = position;
        });
    }
    Ok(())
}

#[tauri::command]
pub fn set_restrict_to_csp(app: AppHandle, state: State<'_, AppState>, enabled: bool) {
    RESTRICT_TO_CSP.store(enabled, Ordering::Relaxed);
    state.settings.update(|s| s.restrict_to_csp = enabled);
    let _ = app.emit("restrict-to-csp-changed", enabled);
    let _ = app.emit("settings-changed", state.settings.get());
}

#[tauri::command]
pub fn get_restrict_to_csp() -> bool {
    RESTRICT_TO_CSP.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> crate::settings::Settings {
    state.settings.get()
}

#[tauri::command]
pub fn set_language(app: AppHandle, state: State<'_, AppState>, language: String) {
    let language = match language.as_str() {
        "en" => "en",
        "zh-TW" => "zh-TW",
        _ => "ja",
    }
    .to_string();
    state.settings.update(|s| s.language = language.clone());
    status::refresh_tooltip(&app);
    let _ = app.emit("language-changed", language);
    let _ = app.emit("settings-changed", state.settings.get());
}

#[tauri::command]
pub fn set_wheel_type(app: AppHandle, state: State<'_, AppState>, wheel_type: String) {
    if !matches!(
        wheel_type.as_str(),
        "plane" | "oklch" | "hsv" | "hsl" | "lab" | "circle"
    ) {
        return;
    }
    state.settings.update(|s| s.wheel_type = wheel_type.clone());
    let _ = app.emit("wheel-type-changed", wheel_type);
    let _ = app.emit("settings-changed", state.settings.get());
}

#[tauri::command]
pub fn set_circle_model(app: AppHandle, state: State<'_, AppState>, model: String) {
    if !matches!(model.as_str(), "hsv" | "hls") {
        return;
    }
    state.settings.update(|s| s.circle_model = model);
    let _ = app.emit("settings-changed", state.settings.get());
}

#[tauri::command]
pub fn set_plane_options(
    app: AppHandle,
    state: State<'_, AppState>,
    view: Option<String>,
    size: Option<String>,
    background: Option<String>,
    shadow: Option<bool>,
) -> Result<(), String> {
    let view = view.filter(|value| matches!(value.as_str(), "focused" | "full"));
    let size = size.filter(|value| matches!(value.as_str(), "small" | "medium" | "large"));
    if background
        .as_deref()
        .is_some_and(|value| !crate::settings::valid_plane_background(value))
    {
        return Err("Invalid plane background".into());
    }
    if view.is_none() && size.is_none() && background.is_none() && shadow.is_none() {
        return Ok(());
    }
    state.settings.update(|s| {
        if let Some(view) = view {
            s.plane_view = view;
        }
        if let Some(size) = size {
            s.plane_size = size;
        }
        if let Some(background) = background {
            s.plane_background = background;
        }
        if let Some(shadow) = shadow {
            s.plane_shadow = shadow;
        }
    });
    let _ = app.emit("settings-changed", state.settings.get());
    Ok(())
}

#[tauri::command]
pub fn set_palette_offset(app: AppHandle, state: State<'_, AppState>, offset: String) {
    state.settings.update(|s| s.palette_offset = offset.clone());
    let _ = app.emit("palette-offset-changed", offset);
    let _ = app.emit("settings-changed", state.settings.get());
}

#[tauri::command]
pub fn set_global_hotkey(
    app: AppHandle,
    state: State<'_, AppState>,
    hotkey: String,
) -> Result<(), String> {
    let current = state.settings.get();
    if current.global_hotkey == hotkey {
        let _ = app.emit("global-hotkey-changed", hotkey);
        return Ok(());
    }
    input_hook::validate_shortcut(&hotkey)?;
    if input_hook::shortcuts_conflict(&hotkey, current.eyedropper_hotkey.as_deref().unwrap_or(""))
        || current
            .palette_shortcuts
            .values()
            .any(|key| input_hook::shortcuts_conflict(&hotkey, key))
    {
        return Err("shortcut_duplicate".into());
    }

    state.settings.update(|s| s.global_hotkey = hotkey.clone());
    let _ = app.emit("global-hotkey-changed", hotkey);
    let _ = app.emit("settings-changed", state.settings.get());
    Ok(())
}

#[tauri::command]
pub fn set_eyedropper_hotkey(
    app: AppHandle,
    state: State<'_, AppState>,
    hotkey: String,
) -> Result<(), String> {
    input_hook::validate_eyedropper_shortcut(&hotkey)?;
    let current = state.settings.get();
    if input_hook::shortcuts_conflict(&hotkey, &current.global_hotkey)
        || current
            .palette_shortcuts
            .values()
            .any(|key| input_hook::shortcuts_conflict(&hotkey, key))
    {
        return Err("shortcut_duplicate".into());
    }
    state
        .settings
        .update(|s| s.eyedropper_hotkey = Some(hotkey));
    let _ = app.emit("settings-changed", state.settings.get());
    Ok(())
}

#[tauri::command]
pub fn set_palette_shortcut(
    app: AppHandle,
    state: State<'_, AppState>,
    action: String,
    hotkey: String,
) -> Result<(), String> {
    if !settings::PALETTE_SHORTCUTS
        .iter()
        .any(|(name, _)| *name == action)
    {
        return Err("shortcut_invalid".into());
    }
    input_hook::validate_palette_shortcut(&hotkey)?;
    let current = state.settings.get();
    if input_hook::shortcuts_conflict(&hotkey, &current.global_hotkey)
        || input_hook::shortcuts_conflict(
            &hotkey,
            current.eyedropper_hotkey.as_deref().unwrap_or(""),
        )
        || current
            .palette_shortcuts
            .iter()
            .any(|(key, value)| key != &action && input_hook::shortcuts_conflict(&hotkey, value))
    {
        return Err("shortcut_duplicate".into());
    }
    state.settings.update(|s| {
        s.palette_shortcuts.insert(action, hotkey);
    });
    let _ = app.emit("settings-changed", state.settings.get());
    Ok(())
}

#[tauri::command]
pub fn set_color_step(
    app: AppHandle,
    state: State<'_, AppState>,
    axis: settings::ColorStep,
    value: f64,
) -> Result<(), String> {
    state.settings.update_color_step(axis, value)?;
    let _ = app.emit("settings-changed", state.settings.get());
    Ok(())
}

#[tauri::command]
pub fn set_cycle_modes(
    app: AppHandle,
    state: State<'_, AppState>,
    modes: Vec<String>,
) -> Result<(), String> {
    let modes = settings::normalize_cycle_modes(&modes);
    if modes.is_empty() {
        return Err("At least one palette mode must be enabled".into());
    }
    state.settings.update(|s| s.cycle_modes = modes);
    let _ = app.emit("settings-changed", state.settings.get());
    Ok(())
}

fn emit_scan_status(app: &AppHandle, scanning: bool, message: Option<&str>) {
    #[derive(Serialize, Clone)]
    struct ScanStatus<'a> {
        scanning: bool,
        message: Option<&'a str>,
    }
    let _ = app.emit("qr-scan-status", ScanStatus { scanning, message });
}

/// Connect using a freshly decoded QR URL. Runs on the caller's thread (blocking
/// is fine — scan thread already spawned us a separate context).
fn connect_with_url(app: &AppHandle, url: &str) {
    let state: State<'_, AppState> = app.state();
    match decode_qr_url(url) {
        Ok(cfg) => {
            let Some(host) = cfg.ips.first().cloned() else {
                emit_scan_status(app, false, Some("QR had no IPs"));
                return;
            };
            println!(
                "[QR] scanned — IP: {:?}, Port: {}, Gen: {}",
                cfg.ips, cfg.port, cfg.generation
            );
            let mut conn = CSPConnection::new(host, cfg.port, cfg.password, cfg.generation, false);
            match conn.connect() {
                Ok(()) if conn.connected => {
                    let host = conn.host.clone();
                    if let Some(h) = state.qr_scan.lock().unwrap().take() {
                        h.stop();
                    }
                    let mut slot = state.csp.lock().unwrap();
                    *slot = Some(conn);
                    emit_status(app, "connected", Some("qr-scan".into()));
                    emit_scan_status(app, false, Some("connected"));
                    status::set(app, Phase::Connected(host));
                }
                Ok(()) => emit_scan_status(app, false, Some("auth failed")),
                Err(e) => {
                    println!("[QR] connect failed: {e}");
                    emit_scan_status(app, false, Some("connect failed"));
                }
            }
        }
        Err(e) => {
            println!("[QR] decode failed: {e}");
            emit_scan_status(app, false, Some("decode failed"));
        }
    }
}

/// Start a background monitor scan for the CSP companion QR. Idempotent — if a
/// scan is already running, replaces it. Skipped when CSP isn't detected; the
/// csp_process watcher will call us again once CSP appears.
#[tauri::command]
pub fn start_qr_scan(app: AppHandle, state: State<'_, AppState>) {
    let already_connected = state
        .csp
        .lock()
        .unwrap()
        .as_ref()
        .map(|c| c.connected)
        .unwrap_or(false);
    if already_connected {
        emit_scan_status(&app, false, Some("already connected"));
        return;
    }

    if !csp_process::is_running() {
        emit_scan_status(&app, false, Some("waiting for CSP process"));
        println!("[QR] skipped — CSP not running");
        return;
    }
    {
        let mut slot = state.qr_scan.lock().unwrap();
        if let Some(existing) = slot.take() {
            existing.stop();
        }
    }
    let app_cb = app.clone();
    let handle = qr::spawn_scan(QR_PREFIX.to_string(), 1500, move |url| {
        println!("[QR] found URL on screen");
        connect_with_url(&app_cb, &url);
    });
    *state.qr_scan.lock().unwrap() = Some(handle);
    emit_scan_status(&app, true, Some("scanning"));
    status::set(&app, Phase::Scanning);
    println!("[QR] scan started");
}

#[tauri::command]
pub fn stop_qr_scan(state: State<'_, AppState>) {
    if let Some(h) = state.qr_scan.lock().unwrap().take() {
        h.stop();
    }
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

#[cfg(test)]
mod color_request_tests {
    use super::*;

    #[test]
    fn newer_palette_request_survives_a_late_window_acknowledgement() {
        let mut visibility = PaletteVisibility::default();
        let open = visibility.request(true);
        let close = visibility.request(false);
        visibility.finish(open);
        assert_eq!(visibility.pending, Some(false));
        let reopen = visibility.request(true);
        visibility.finish(close);
        assert_eq!(visibility.pending, Some(true));
        visibility.finish(reopen);
        assert_eq!(visibility.pending, None);
    }

    #[test]
    fn a_new_sample_invalidates_color_writes_queued_under_the_previous_generation() {
        let latest = AtomicU64::new(7);
        assert!(is_current_color_request(7, &latest));

        latest.fetch_add(1, Ordering::AcqRel);

        assert!(!is_current_color_request(7, &latest));
        assert!(is_current_color_request(8, &latest));
    }
}
