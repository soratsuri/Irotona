use tauri::{
    image::Image,
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager,
};

use crate::{commands, settings, state::AppState};

fn build_icon() -> Image<'static> {
    let decoded = image::load_from_memory(include_bytes!("../icons/32x32.png"))
        .expect("Irotona tray icon must be a valid PNG")
        .into_rgba8();
    let (width, height) = decoded.dimensions();
    Image::new_owned(decoded.into_raw(), width, height)
}

fn shutdown_and_exit(app: &AppHandle) {
    let _ = commands::set_palette_pin(app.clone(), None);
    let state: tauri::State<'_, AppState> = app.state();
    if let Some(h) = state.qr_scan.lock().unwrap().take() {
        h.stop();
    }
    if let Some(mut conn) = state.csp.lock().unwrap().take() {
        conn.disconnect();
    }
    for (_, win) in app.webview_windows() {
        let _ = win.hide();
    }
    app.exit(0);
}

const MODES: &[(&str, [&str; 3])] = &[
    ("circle", ["Color circle", "色環", "カラーサークル"]),
    (
        "plane",
        [
            "Color Plane",
            "色彩平面",
            "色面パレット",
        ],
    ),
    (
        "oklch",
        [
            "OKLCH (perceptual)",
            "OKLCH（感知均勻）",
            "OKLCH（知覚的明度）",
        ],
    ),
    (
        "hsv",
        ["HSV (CSP native)", "HSV（CSP 原生）", "HSV（クリスタ標準）"],
    ),
    ("hsl", ["HSL (classic)", "HSL（傳統）", "HSL"]),
    ("lab", ["Photoshop Lab", "Photoshop Lab", "Photoshop Lab"]),
];
const OFFSETS: &[(&str, [&str; 3])] = &[
    (
        "bottom-right",
        ["Bottom-right of cursor", "游標右下", "カーソルの右下"],
    ),
    (
        "bottom-left",
        ["Bottom-left of cursor", "游標左下", "カーソルの左下"],
    ),
    (
        "top-right",
        ["Top-right of cursor", "游標右上", "カーソルの右上"],
    ),
    (
        "top-left",
        ["Top-left of cursor", "游標左上", "カーソルの左上"],
    ),
    (
        "center",
        ["Centered on cursor", "以游標置中", "カーソルを中心に表示"],
    ),
];

fn choice_menu(
    app: &AppHandle,
    prefix: &str,
    choices: &[(&str, [&str; 3])],
) -> tauri::Result<Vec<CheckMenuItem<tauri::Wry>>> {
    choices
        .iter()
        .map(|(id, labels)| {
            CheckMenuItem::with_id(
                app,
                format!("{prefix}{id}"),
                labels[0],
                true,
                false,
                None::<&str>,
            )
        })
        .collect()
}

fn choice_refs(items: &[CheckMenuItem<tauri::Wry>]) -> Vec<&dyn IsMenuItem<tauri::Wry>> {
    items
        .iter()
        .map(|item| item as &dyn IsMenuItem<tauri::Wry>)
        .collect()
}

pub fn install(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let modes = choice_menu(app, "wheel-", MODES)?;
    let offsets = choice_menu(app, "offset-", OFFSETS)?;
    let wheel = Submenu::with_items(app, "Palette mode", true, &choice_refs(&modes))?;
    let offset = Submenu::with_items(app, "Palette position", true, &choice_refs(&offsets))?;
    let restrict = CheckMenuItem::with_id(app, "toggle-restrict", "", true, false, None::<&str>)?;
    let status = MenuItem::with_id(app, "status-settings", "", true, None::<&str>)?;
    let rescan = MenuItem::with_id(app, "rescan-qr", "", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", "", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let end_separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &separator,
            &restrict,
            &wheel,
            &offset,
            &rescan,
            &end_separator,
            &exit,
        ],
    )?;

    let refresh = move |s: &settings::Settings| {
        let tr = |en, zh, ja| settings::text(&s.language, en, zh, ja);
        let _ = status.set_text(tr("Status && Settings…", "狀態與設定…", "接続状態と設定…"));
        let _ = rescan.set_text(tr(
            "Disconnect and scan QR…",
            "中斷並掃描 QR…",
            "接続を解除して QR コードを検索…",
        ));
        let _ = exit.set_text(tr("Exit", "結束", "終了"));
        let _ = restrict.set_text(tr(
            "Only respond when CSP is focused",
            "只在 CSP 作用中時回應",
            "クリスタが前面のときだけ反応",
        ));
        let _ = restrict.set_checked(s.restrict_to_csp);
        let _ = wheel.set_text(tr("Palette mode", "色盤模式", "パレットモード"));
        let _ = offset.set_text(tr("Palette position", "色盤位置", "パレットの表示位置"));
        for (item, (id, [en, zh, ja])) in modes.iter().zip(MODES) {
            let _ = item.set_text(tr(en, zh, ja));
            let _ = item.set_checked(s.wheel_type == *id);
        }
        for (item, (id, [en, zh, ja])) in offsets.iter().zip(OFFSETS) {
            let _ = item.set_text(tr(en, zh, ja));
            let _ = item.set_checked(s.palette_offset == *id);
        }
    };
    refresh(&app.state::<AppState>().settings.get());
    let app_for_refresh = app.clone();
    app.listen("settings-changed", move |_| {
        refresh(&app_for_refresh.state::<AppState>().settings.get());
    });

    TrayIconBuilder::with_id("main-tray")
        .icon(build_icon())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let state = app.state::<AppState>();
            match event.id.as_ref() {
                "exit" => shutdown_and_exit(app),
                "status-settings" => commands::show_status_settings(app),
                "toggle-restrict" => {
                    let enabled = !state.settings.get().restrict_to_csp;
                    commands::set_restrict_to_csp(app.clone(), state, enabled);
                }
                "rescan-qr" => {
                    let _ = app.emit("tray-rescan-qr", ());
                }
                id => {
                    if let Some(kind) = id.strip_prefix("wheel-") {
                        commands::set_wheel_type(app.clone(), state, kind.into());
                    } else if let Some(position) = id.strip_prefix("offset-") {
                        commands::set_palette_offset(app.clone(), state, position.into());
                    }
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                ..
            } = event
            {
                commands::show_status_settings(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}
