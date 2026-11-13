use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::{settings::text, state::AppState};
use tauri_plugin_notification::NotificationExt;

/// High-level app state used for tooltips + notifications.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Phase {
    WaitingForCsp,
    Scanning,
    Reconnecting,
    Connected(String),
    Disconnected(String),
}

impl Phase {
    fn localized(&self, lang: &str) -> String {
        let tr = |en, zh, ja| text(lang, en, zh, ja);
        match self {
            Phase::WaitingForCsp => {
                tr("Waiting for CSP", "等待 CSP", "クリスタの起動を待機中").into()
            }
            Phase::Scanning => tr(
                "Scanning for QR…",
                "正在掃描 QR code…",
                "QR コードを検索中…",
            )
            .into(),
            Phase::Reconnecting => tr("Reconnecting…", "重新連線中…", "再接続中…").into(),
            Phase::Connected(host) => format!(
                "{} ({host})",
                tr("Connected to CSP", "已連線至 CSP", "クリスタに接続しました")
            ),
            Phase::Disconnected(reason) => {
                let reason = match reason.as_str() {
                    "CSP closed" => tr("CSP closed", "CSP 已關閉", "クリスタが終了しました"),
                    "socket dropped" => tr("Connection lost", "連線中斷", "通信が切断されました"),
                    "user" => tr(
                        "Manually disconnected",
                        "手動中斷連線",
                        "手動で切断しました",
                    ),
                    _ => tr("Unknown cause", "原因不明", "原因不明"),
                };
                format!("{} ({reason})", tr("Disconnected", "已中斷", "未接続"))
            }
        }
    }

    fn key(&self) -> &'static str {
        match self {
            Phase::WaitingForCsp => "waiting_for_csp",
            Phase::Scanning => "scanning",
            Phase::Reconnecting => "reconnecting",
            Phase::Connected(_) => "connected",
            Phase::Disconnected(_) => "disconnected",
        }
    }

    fn detail(&self) -> Option<String> {
        match self {
            Phase::Connected(host) => Some(host.clone()),
            Phase::Disconnected(reason) => Some(reason.clone()),
            _ => None,
        }
    }

    fn label(&self) -> String {
        match self {
            Phase::WaitingForCsp => "Waiting for Clip Studio Paint".into(),
            Phase::Scanning => "Scanning for Companion Mode QR code".into(),
            Phase::Reconnecting => "Trying saved Companion Mode session".into(),
            Phase::Connected(host) => format!("Connected to CSP at {host}"),
            Phase::Disconnected(reason) => format!("Disconnected: {reason}"),
        }
    }
}

static LAST_PHASE: Mutex<Option<Phase>> = Mutex::new(None);

#[derive(Clone, Debug, Serialize)]
pub struct PhasePayload {
    pub phase: String,
    pub detail: Option<String>,
    pub label: String,
}

impl From<&Phase> for PhasePayload {
    fn from(phase: &Phase) -> Self {
        Self {
            phase: phase.key().into(),
            detail: phase.detail(),
            label: phase.label(),
        }
    }
}

pub fn current() -> PhasePayload {
    let phase = LAST_PHASE
        .lock()
        .unwrap()
        .clone()
        .unwrap_or(Phase::WaitingForCsp);
    PhasePayload::from(&phase)
}

/// Update tray tooltip and, if the phase materially changed, send an OS
/// notification. Suppresses duplicate transitions so we don't spam the user.
pub fn set(app: &AppHandle, phase: Phase) {
    let payload = PhasePayload::from(&phase);
    let _ = app.emit("phase-changed", payload);

    let mut last = LAST_PHASE.lock().unwrap();
    let should_notify = match (&phase, last.as_ref()) {
        // Same variant as before: no new toast.
        (a, Some(b)) if variant_eq(a, b) => false,
        // Transient states don't warrant a toast on their own.
        (Phase::WaitingForCsp, _) | (Phase::Scanning, _) | (Phase::Reconnecting, _) => false,
        _ => true,
    };
    *last = Some(phase.clone());
    drop(last);

    refresh_tooltip(app);
    if should_notify {
        let language = app.state::<AppState>().settings.get().language;
        let _ = app
            .notification()
            .builder()
            .title("Irotona")
            .body(phase.localized(&language))
            .show();
    }
}

pub fn refresh_tooltip(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let phase = LAST_PHASE
            .lock()
            .unwrap()
            .clone()
            .unwrap_or(Phase::WaitingForCsp);
        let language = app.state::<AppState>().settings.get().language;
        let _ = tray.set_tooltip(Some(format!(
            "Irotona — {}",
            phase.localized(&language)
        )));
    }
}

pub fn notify_startup(app: &AppHandle, hotkey: &str) {
    let language = app.state::<AppState>().settings.get().language;
    let tr = |en, zh, ja| text(&language, en, zh, ja);
    let shortcut = if hotkey.is_empty() {
        tr(
            "No keyboard shortcut is set.",
            "尚未設定快捷鍵。",
            "ショートカットは未設定です。",
        )
        .to_string()
    } else {
        format!("{} {hotkey}", tr("Shortcut:", "快捷鍵：", "ショートカット"))
    };
    let _ = app
        .notification()
        .builder()
        .title(tr(
            "Irotona is running",
            "Irotona 執行中",
            "Irotona が起動しました",
        ))
        .body(format!(
            "{} {shortcut}",
            tr(
                "Use the tray icon for Status & Settings.",
                "請從系統匣圖示開啟狀態與設定。",
                "通知領域のアイコンから設定を開けます。",
            )
        ))
        .show();
}

fn variant_eq(a: &Phase, b: &Phase) -> bool {
    use Phase::*;
    matches!(
        (a, b),
        (WaitingForCsp, WaitingForCsp)
            | (Scanning, Scanning)
            | (Reconnecting, Reconnecting)
            | (Connected(_), Connected(_))
            | (Disconnected(_), Disconnected(_))
    )
}
