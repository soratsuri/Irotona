use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::fs::OpenOptions;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Settings {
    /// Restrict manual summons to the CSP foreground window.
    pub restrict_to_csp: bool,
    /// Always-on: QR scanner + auto-reconnect only run while CSP is detected.
    /// Kept in the struct for save-file compatibility but no longer toggleable.
    #[serde(default = "always_true")]
    pub require_csp_running: bool,
    /// UI language: "ja" | "en" | "zh-TW".
    #[serde(default = "default_language")]
    pub language: String,
    /// Palette model: "plane" | "oklch" | "hsv" | "hsl" | "lab" | "circle".
    #[serde(default = "default_wheel_type")]
    pub wheel_type: String,
    #[serde(default = "default_circle_model")]
    pub circle_model: String,
    #[serde(default = "default_plane_view")]
    pub plane_view: String,
    // Legacy key retained for existing settings.json files; applies to all palette modes.
    #[serde(default = "default_plane_size")]
    pub plane_size: String,
    #[serde(default = "default_plane_background")]
    pub plane_background: String,
    #[serde(default)]
    pub plane_shadow: bool,
    /// Custom global shortcut accelerator string. Empty string disables it.
    #[serde(default)]
    pub global_hotkey: String,
    #[serde(default)]
    pub eyedropper_hotkey: Option<String>,
    #[serde(default, skip_serializing)]
    show_after_alt_pick: bool,
    /// Accelerators handled by the palette window while it has focus.
    #[serde(default = "default_palette_shortcuts")]
    pub palette_shortcuts: BTreeMap<String, String>,
    #[serde(default, deserialize_with = "deserialize_color_steps")]
    pub color_steps: ColorSteps,
    #[serde(default = "legacy_cycle_modes")]
    pub cycle_modes: Vec<String>,
    /// Whether the first-run Status & Settings guide has been shown.
    #[serde(default)]
    pub has_seen_welcome: bool,
    /// Whether to show a once-per-launch tray notification after the first run.
    #[serde(default = "always_true")]
    pub notify_on_startup: bool,
    /// Where the palette appears relative to the summon point (cursor / hotkey
    /// invocation point). One of:
    /// "bottom-right" (default, right-handed),
    /// "bottom-left"  (left-handed mirror),
    /// "top-right",
    /// "top-left",
    /// "center"       (pin at cursor, palette centered on cursor).
    #[serde(default = "default_palette_offset")]
    pub palette_offset: String,
    #[serde(default)]
    pub palette_pinned: bool,
    #[serde(default)]
    pub pinned_position: Option<[i32; 2]>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct ColorSteps {
    hue: f64,
    chroma: f64,
    lightness: f64,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColorStep {
    Hue,
    Chroma,
    Lightness,
}

impl ColorSteps {
    pub fn set(&mut self, axis: ColorStep, value: f64) -> Result<(), &'static str> {
        let (field, range) = match axis {
            ColorStep::Hue => (&mut self.hue, 1.0..=30.0),
            ColorStep::Chroma => (&mut self.chroma, 0.005..=0.1),
            ColorStep::Lightness => (&mut self.lightness, 0.005..=0.1),
        };
        if !range.contains(&value) {
            return Err("color_step_invalid");
        }
        *field = value;
        Ok(())
    }
}

impl Default for ColorSteps {
    fn default() -> Self {
        Self {
            hue: 2.0,
            chroma: 0.025,
            lightness: 0.01,
        }
    }
}

fn deserialize_color_steps<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<ColorSteps, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    let mut steps = ColorSteps::default();
    for (key, axis) in [
        ("hue", ColorStep::Hue),
        ("chroma", ColorStep::Chroma),
        ("lightness", ColorStep::Lightness),
    ] {
        if let Some(number) = value.get(key).and_then(serde_json::Value::as_f64) {
            let _ = steps.set(axis, number);
        }
    }
    Ok(steps)
}

fn default_hotkey() -> String {
    "Ctrl+Shift+F12".into()
}
fn default_language() -> String {
    "ja".into()
}
fn default_wheel_type() -> String {
    "oklch".into()
}
fn default_circle_model() -> String {
    "hsv".into()
}
fn default_plane_view() -> String {
    "focused".into()
}
fn default_plane_background() -> String {
    "plain".into()
}

pub fn valid_plane_background(value: &str) -> bool {
    matches!(value, "plain" | "canvas" | "paper")
}

fn default_plane_size() -> String {
    "medium".into()
}

pub const PALETTE_SHORTCUTS: [(&str, &str); 9] = [
    ("hue_next", "ArrowRight"),
    ("hue_prev", "ArrowLeft"),
    ("light_up", "ArrowUp"),
    ("light_down", "ArrowDown"),
    ("chroma_up", "Shift+ArrowUp"),
    ("chroma_down", "Shift+ArrowDown"),
    ("cycle_mode", "M"),
    ("restore_sampled_color", ""),
    ("close", "Escape"),
];

fn default_palette_shortcuts() -> BTreeMap<String, String> {
    PALETTE_SHORTCUTS
        .into_iter()
        .map(|(action, accel)| (action.into(), accel.into()))
        .collect()
}

const PALETTE_MODES: [&str; 6] = ["oklch", "hsv", "hsl", "lab", "plane", "circle"];

fn legacy_cycle_modes() -> Vec<String> {
    PALETTE_MODES[..5]
        .iter()
        .map(|mode| (*mode).to_owned())
        .collect()
}

fn default_cycle_modes() -> Vec<String> {
    PALETTE_MODES.into_iter().map(str::to_owned).collect()
}

pub fn normalize_cycle_modes(modes: &[String]) -> Vec<String> {
    PALETTE_MODES
        .into_iter()
        .filter(|mode| modes.iter().any(|item| item == mode))
        .map(str::to_owned)
        .collect()
}
fn default_palette_offset() -> String {
    "bottom-right".into()
}
fn always_true() -> bool {
    true
}

pub fn text<'a>(language: &str, en: &'a str, zh: &'a str, ja: &'a str) -> &'a str {
    match language {
        "ja" => ja,
        "zh-TW" => zh,
        _ => en,
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            restrict_to_csp: true,
            require_csp_running: true,
            language: default_language(),
            wheel_type: default_wheel_type(),
            circle_model: default_circle_model(),
            plane_view: default_plane_view(),
            plane_size: default_plane_size(),
            plane_background: default_plane_background(),
            plane_shadow: false,
            global_hotkey: default_hotkey(),
            eyedropper_hotkey: Some(String::new()),
            show_after_alt_pick: false,
            palette_shortcuts: default_palette_shortcuts(),
            color_steps: ColorSteps::default(),
            cycle_modes: default_cycle_modes(),
            has_seen_welcome: false,
            notify_on_startup: true,
            palette_offset: default_palette_offset(),
            palette_pinned: false,
            pinned_position: None,
        }
    }
}

pub fn exe_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.to_path_buf())
}

pub fn settings_path() -> Option<PathBuf> {
    Some(exe_dir()?.join("settings.json"))
}

pub fn exe_dir_is_writable() -> bool {
    let Some(dir) = exe_dir() else {
        return false;
    };
    let probe = dir.join(format!(".luma-write-test-{}", std::process::id()));
    match OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(probe);
            true
        }
        Err(_) => false,
    }
}

fn decode_settings(text: &str) -> Settings {
    let mut settings: Settings = serde_json::from_str(text).unwrap_or_default();
    settings.eyedropper_hotkey.get_or_insert_with(|| {
        if settings.show_after_alt_pick {
            "Alt".into()
        } else {
            String::new()
        }
    });
    if !valid_plane_background(&settings.plane_background) {
        settings.plane_background = default_plane_background();
    }
    settings.cycle_modes = normalize_cycle_modes(&settings.cycle_modes);
    if settings.cycle_modes.is_empty() {
        settings.cycle_modes = legacy_cycle_modes();
    }
    settings
}

#[cfg(test)]
#[test]
fn plane_appearance_defaults_validates_and_round_trips() {
    let old = decode_settings(r#"{"restrict_to_csp":false}"#);
    assert_eq!(old.plane_background, "plain");
    assert!(!old.plane_shadow);
    let invalid = decode_settings(
        r#"{"restrict_to_csp":false,"plane_background":"invalid","plane_shadow":true}"#,
    );
    assert_eq!(invalid.plane_background, "plain");
    assert!(invalid.plane_shadow);
    assert!(!invalid.restrict_to_csp);
    for background in ["plain", "canvas", "paper"] {
        for shadow in [false, true] {
            let settings = Settings {
                plane_background: background.into(),
                plane_shadow: shadow,
                ..Settings::default()
            };
            let loaded = decode_settings(&serde_json::to_string(&settings).unwrap());
            assert_eq!(loaded.plane_background, background);
            assert_eq!(loaded.plane_shadow, shadow);
        }
    }
}

pub fn load() -> Settings {
    let Some(path) = settings_path() else {
        return Settings::default();
    };
    let Ok(txt) = fs::read_to_string(&path) else {
        return Settings::default();
    };
    decode_settings(&txt)
}

pub fn save(s: &Settings) {
    let _ = write_settings(s);
}

fn write_settings(settings: &Settings) -> Result<(), String> {
    let path = settings_path().ok_or("settings path unavailable")?;
    let json = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| error.to_string())
}

pub struct SettingsStore {
    inner: Mutex<Settings>,
}

impl SettingsStore {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(load()),
        }
    }
    pub fn get(&self) -> Settings {
        self.inner.lock().unwrap().clone()
    }
    pub fn update<F: FnOnce(&mut Settings)>(&self, f: F) {
        let mut s = self.inner.lock().unwrap();
        f(&mut s);
        save(&s);
    }
    pub fn update_color_step(&self, axis: ColorStep, value: f64) -> Result<(), String> {
        let mut current = self.inner.lock().unwrap();
        let mut updated = current.clone();
        updated.color_steps.set(axis, value)?;
        if updated.color_steps != current.color_steps {
            write_settings(&updated)?;
            *current = updated;
        }
        Ok(())
    }
}

impl Default for SettingsStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_shortcut_is_opt_in_and_preserved_on_reload() {
        let fresh = Settings::default();
        assert_eq!(fresh.palette_shortcuts["restore_sampled_color"], "");
        let mut legacy = decode_settings(
            r#"{"restrict_to_csp":false,"palette_shortcuts":{"close":"","hue_next":"J"}}"#,
        );
        assert!(!legacy
            .palette_shortcuts
            .contains_key("restore_sampled_color"));
        assert_eq!(legacy.palette_shortcuts["close"], "");
        legacy
            .palette_shortcuts
            .insert("restore_sampled_color".into(), "R".into());
        let restored = decode_settings(&serde_json::to_string(&legacy).unwrap());
        assert_eq!(restored.palette_shortcuts["restore_sampled_color"], "R");
        assert_eq!(restored.palette_shortcuts["hue_next"], "J");
    }

    #[test]
    fn color_steps_preserve_legacy_settings_and_restore_valid_values() {
        let legacy = decode_settings(r#"{"restrict_to_csp":false,"wheel_type":"lab"}"#);
        assert_eq!(legacy.color_steps, ColorSteps::default());
        let settings = decode_settings(
            r#"{"restrict_to_csp":false,"wheel_type":"lab","color_steps":{"hue":7.5,"chroma":0.08,"lightness":0.005}}"#,
        );
        let expected = ColorSteps {
            hue: 7.5,
            chroma: 0.08,
            lightness: 0.005,
        };
        assert_eq!(settings.color_steps, expected);
        assert_eq!(
            decode_settings(&serde_json::to_string(&settings).unwrap()).color_steps,
            expected
        );
        let invalid = decode_settings(
            r#"{"restrict_to_csp":false,"wheel_type":"lab","color_steps":{"hue":"Infinity","chroma":0.11,"lightness":0.075}}"#,
        );
        assert_eq!(invalid.wheel_type, "lab");
        assert!(!invalid.restrict_to_csp);
        assert_eq!(
            invalid.color_steps,
            ColorSteps {
                lightness: 0.075,
                ..ColorSteps::default()
            }
        );
        assert_eq!(
            decode_settings(r#"{"restrict_to_csp":false,"color_steps":null}"#).color_steps,
            ColorSteps::default()
        );
    }

    #[test]
    fn color_steps_reject_invalid_changes_without_mutation() {
        let mut steps = ColorSteps::default();
        for axis in [ColorStep::Hue, ColorStep::Chroma, ColorStep::Lightness] {
            for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0, 31.0] {
                assert!(steps.set(axis, value).is_err());
            }
        }
        assert_eq!(steps, ColorSteps::default());
    }

    #[test]
    fn cycle_modes_migrate_and_round_trip_without_changing_direct_selection() {
        let legacy = decode_settings(r#"{"restrict_to_csp":true,"wheel_type":"hsl"}"#);
        assert_eq!(legacy.cycle_modes, legacy_cycle_modes());
        assert_eq!(legacy.circle_model, "hsv");
        let selected = decode_settings(
            r#"{"restrict_to_csp":true,"wheel_type":"hsl","cycle_modes":["plane","oklch","plane","unknown"]}"#,
        );
        assert_eq!(selected.cycle_modes, ["oklch", "plane"]);
        assert_eq!(selected.wheel_type, "hsl");
        let restored = decode_settings(&serde_json::to_string(&selected).unwrap());
        assert_eq!(restored.cycle_modes, selected.cycle_modes);
        assert_eq!(
            decode_settings(r#"{"restrict_to_csp":true,"cycle_modes":[]}"#).cycle_modes,
            legacy_cycle_modes()
        );
        assert!(Settings::default().cycle_modes.contains(&"circle".into()));
        let circle = decode_settings(
            r#"{"restrict_to_csp":true,"wheel_type":"circle","circle_model":"hls","cycle_modes":["circle"]}"#,
        );
        let restored = decode_settings(&serde_json::to_string(&circle).unwrap());
        assert_eq!(restored.wheel_type, "circle");
        assert_eq!(restored.circle_model, "hls");
        assert_eq!(restored.cycle_modes, ["circle"]);
        assert!(normalize_cycle_modes(&["invalid".into()]).is_empty());
    }

    #[test]
    fn fresh_settings_start_in_japanese_with_manual_summon() {
        let settings = Settings::default();
        assert_eq!(settings.language, "ja");
        assert_eq!(settings.wheel_type, "oklch");
        assert!(settings.restrict_to_csp);
        assert_eq!(settings.eyedropper_hotkey.as_deref(), Some(""));
        assert_eq!(settings.global_hotkey, "Ctrl+Shift+F12");
    }

    #[test]
    fn older_settings_keep_explicit_preferences() {
        let settings = decode_settings(
            r#"{"restrict_to_csp":false,"wheel_type":"lab","language":"zh-TW","global_hotkey":"Alt+P","show_after_alt_pick":true}"#,
        );
        assert_eq!(settings.language, "zh-TW");
        assert_eq!(settings.wheel_type, "lab");
        assert_eq!(settings.global_hotkey, "Alt+P");
        assert_eq!(settings.eyedropper_hotkey.as_deref(), Some("Alt"));
        assert_eq!(settings.palette_shortcuts["close"], "Escape");
    }

    #[test]
    fn eyedropper_assignment_and_clear_override_legacy_alt_and_round_trip() {
        for key in ["Q", "Ctrl+Q", "F8", ""] {
            let old = serde_json::json!({
                "restrict_to_csp": true,
                "show_after_alt_pick": true,
                "eyedropper_hotkey": key,
            });
            let settings = decode_settings(&old.to_string());
            let saved = serde_json::to_string(&settings).unwrap();
            assert!(!saved.contains("show_after_alt_pick"));
            assert_eq!(
                decode_settings(&saved).eyedropper_hotkey.as_deref(),
                Some(key)
            );
        }
        let disabled = decode_settings(r#"{"restrict_to_csp":true,"show_after_alt_pick":false}"#);
        assert_eq!(disabled.eyedropper_hotkey.as_deref(), Some(""));
    }

    #[test]
    fn only_missing_palette_mode_gets_the_new_default() {
        let missing: Settings = serde_json::from_str(r#"{"restrict_to_csp":true}"#).unwrap();
        assert_eq!(missing.wheel_type, "oklch");
        let explicit: Settings =
            serde_json::from_str(r#"{"restrict_to_csp":true,"wheel_type":"plane"}"#).unwrap();
        assert_eq!(explicit.wheel_type, "plane");
        assert_eq!(explicit.plane_view, "focused");
        assert_eq!(explicit.plane_size, "medium");
        assert!(!explicit.palette_pinned);
        assert_eq!(explicit.pinned_position, None);
    }

    #[test]
    fn older_focused_layout_is_ignored_without_losing_other_settings() {
        let old = r#"{"restrict_to_csp":true,"wheel_type":"plane","plane_view":"focused","plane_size":"small","plane_focused_layout":"hue","palette_pinned":true,"pinned_position":[-1630,280]}"#;
        let settings: Settings = serde_json::from_str(old).unwrap();
        let new = serde_json::to_string(&settings).unwrap();
        assert!(!new.contains("plane_focused_layout"));
        let restored: Settings = serde_json::from_str(&new).unwrap();
        assert!(restored.palette_pinned);
        assert_eq!(restored.pinned_position, Some([-1630, 280]));
        assert_eq!(restored.wheel_type, "plane");
        assert_eq!(restored.plane_view, "focused");
        assert_eq!(restored.plane_size, "small");
    }

    #[test]
    fn languages_and_shortcut_edits_survive_json_roundtrip() {
        for language in ["ja", "en", "zh-TW"] {
            let mut settings = Settings {
                language: language.into(),
                plane_view: "full".into(),
                plane_size: "large".into(),
                ..Settings::default()
            };
            settings.palette_shortcuts.insert("close".into(), "".into());
            settings
                .palette_shortcuts
                .insert("cycle_mode".into(), "F8".into());
            let json = serde_json::to_string(&settings).unwrap();
            let loaded: Settings = serde_json::from_str(&json).unwrap();
            assert_eq!(loaded.language, language);
            assert_eq!(loaded.plane_view, "full");
            assert_eq!(loaded.plane_size, "large");
            assert_eq!(loaded.palette_shortcuts, settings.palette_shortcuts);
        }
    }
}
