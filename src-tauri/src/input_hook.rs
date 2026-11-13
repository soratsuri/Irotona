// Windows low-level hooks. Eyedropper input passes through to CSP.

#[derive(Clone, Debug, PartialEq, Eq)]
struct ShortcutSpec {
    ctrl: bool,
    shift: bool,
    alt: bool,
    super_key: bool,
    vk_code: u16,
}

fn parse_shortcut(accel: &str, require_modifier: bool) -> Result<Option<ShortcutSpec>, String> {
    let accel = accel.trim();
    if accel.is_empty() {
        return Ok(None);
    }

    let mut spec = ShortcutSpec {
        ctrl: false,
        shift: false,
        alt: false,
        super_key: false,
        vk_code: 0,
    };
    let mut key_seen = false;

    for raw in accel.split('+').map(str::trim).filter(|p| !p.is_empty()) {
        match raw.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => spec.ctrl = true,
            "shift" => spec.shift = true,
            "alt" | "option" => spec.alt = true,
            "super" | "meta" | "win" | "windows" => spec.super_key = true,
            _ => {
                if key_seen {
                    return Err("shortcut_invalid".into());
                }
                spec.vk_code = vk_code_for_key(raw)?;
                key_seen = true;
            }
        }
    }

    if !key_seen {
        return Err("shortcut_invalid".into());
    }
    if require_modifier && !(spec.ctrl || spec.shift || spec.alt || spec.super_key) {
        return Err("shortcut_modifier".into());
    }

    Ok(Some(spec))
}

pub fn validate_shortcut(accel: &str) -> Result<(), String> {
    if let Some(spec) = parse_shortcut(accel, true)? {
        let modifiers = [spec.ctrl, spec.shift, spec.alt, spec.super_key]
            .into_iter()
            .filter(|pressed| *pressed)
            .count();
        if modifiers < 2 && !(0x70..=0x87).contains(&spec.vk_code) {
            return Err("shortcut_modifier".into());
        }
    }
    Ok(())
}

pub fn validate_palette_shortcut(accel: &str) -> Result<(), String> {
    parse_shortcut(accel, false).map(|_| ())
}

fn parse_eyedropper_shortcut(accel: &str) -> Result<Option<ShortcutSpec>, String> {
    if matches!(accel.trim().to_ascii_lowercase().as_str(), "alt" | "option") {
        return Ok(Some(ShortcutSpec {
            ctrl: false,
            shift: false,
            alt: true,
            super_key: false,
            vk_code: 0x12, // VK_MENU
        }));
    }
    parse_shortcut(accel, false)
}

pub fn validate_eyedropper_shortcut(accel: &str) -> Result<(), String> {
    parse_eyedropper_shortcut(accel).map(|_| ())
}

pub fn shortcuts_conflict(first: &str, second: &str) -> bool {
    parse_eyedropper_shortcut(first)
        .ok()
        .flatten()
        .is_some_and(|first| parse_eyedropper_shortcut(second).ok().flatten() == Some(first))
}

fn vk_code_for_key(raw: &str) -> Result<u16, String> {
    let key = raw.trim();
    if key.len() == 1 {
        let ch = key.chars().next().unwrap().to_ascii_uppercase();
        if ch.is_ascii_alphabetic() || ch.is_ascii_digit() {
            return Ok(ch as u16);
        }
    }

    let upper = key.to_ascii_uppercase();
    if let Some(num) = upper.strip_prefix('F').and_then(|n| n.parse::<u16>().ok()) {
        if (1..=24).contains(&num) {
            return Ok(0x70 + num - 1);
        }
    }

    match upper.as_str() {
        "BACKSPACE" => Ok(0x08),
        "TAB" => Ok(0x09),
        "ENTER" | "RETURN" => Ok(0x0D),
        "PAUSE" => Ok(0x13),
        "CAPSLOCK" => Ok(0x14),
        "ESCAPE" | "ESC" => Ok(0x1B),
        "SPACE" => Ok(0x20),
        "PAGEUP" => Ok(0x21),
        "PAGEDOWN" => Ok(0x22),
        "END" => Ok(0x23),
        "HOME" => Ok(0x24),
        "ARROWLEFT" | "LEFT" => Ok(0x25),
        "ARROWUP" | "UP" => Ok(0x26),
        "ARROWRIGHT" | "RIGHT" => Ok(0x27),
        "ARROWDOWN" | "DOWN" => Ok(0x28),
        "INSERT" => Ok(0x2D),
        "DELETE" => Ok(0x2E),
        _ => Err("shortcut_invalid".into()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EyedropperAction {
    Show,
    SyncPinned,
}

fn eyedropper_action(configured: bool, alt: bool, pinned: bool) -> Option<EyedropperAction> {
    if pinned && (configured || alt) {
        Some(EyedropperAction::SyncPinned)
    } else if configured {
        Some(EyedropperAction::Show)
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
pub fn install_eyedropper_click<G, F>(get_shortcut: G, on_click: F)
where
    G: Fn() -> (String, bool) + Send + Sync + 'static,
    F: Fn(i32, i32, EyedropperAction) + Send + Sync + 'static,
{
    use std::cell::Cell;
    use std::sync::OnceLock;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetAncestor, GetForegroundWindow, GetMessageW, SetWindowsHookExW,
        WindowFromPoint, GA_ROOT, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP,
    };

    static GET_SHORTCUT: OnceLock<Box<dyn Fn() -> (String, bool) + Send + Sync>> = OnceLock::new();
    static CALLBACK: OnceLock<Box<dyn Fn(i32, i32, EyedropperAction) + Send + Sync>> =
        OnceLock::new();
    thread_local! {
        static DOWN: Cell<Option<(HWND, EyedropperAction)>> = const { Cell::new(None) };
    }
    let _ = GET_SHORTCUT.set(Box::new(get_shortcut));
    let _ = CALLBACK.set(Box::new(on_click));

    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        let message = wparam.0 as u32;
        if code >= 0 && matches!(message, WM_LBUTTONDOWN | WM_LBUTTONUP) {
            let pt = unsafe { (*(lparam.0 as *const MSLLHOOKSTRUCT)).pt };
            let window_at = |point: POINT| unsafe { GetAncestor(WindowFromPoint(point), GA_ROOT) };
            if message == WM_LBUTTONDOWN {
                let foreground = unsafe { GetForegroundWindow() };
                let matches = |shortcut: &str| {
                    parse_eyedropper_shortcut(shortcut)
                        .ok()
                        .flatten()
                        .is_some_and(|spec| key_down(spec.vk_code as i32) && modifiers_match(&spec))
                };
                let action = GET_SHORTCUT.get().and_then(|get| {
                    let (shortcut, pinned) = get();
                    eyedropper_action(matches(shortcut.as_str()), pinned && matches("Alt"), pinned)
                });
                DOWN.set(
                    action
                        .filter(|_| {
                            is_csp_window(foreground)
                                && window_at(pt) == foreground
                                && is_csp_process_window(foreground)
                                && !is_text_focused()
                        })
                        .map(|action| (foreground, action)),
                );
            } else {
                if let Some((window, action)) = DOWN.take() {
                    if completes_eyedropper_click(
                        window,
                        unsafe { GetForegroundWindow() },
                        window_at(pt),
                    ) {
                        if let Some(cb) = CALLBACK.get() {
                            cb(pt.x, pt.y, action);
                        }
                    }
                }
            }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    // Hooks must run on a thread with a message loop.
    std::thread::spawn(move || unsafe {
        let h = SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), None, 0);
        if h.is_err() {
            eprintln!("[HOOK] SetWindowsHookExW failed");
            return;
        }
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            // Pump messages; the hook fires via the OS.
        }
    });
}

#[cfg(target_os = "windows")]
fn completes_eyedropper_click(
    start: windows::Win32::Foundation::HWND,
    foreground: windows::Win32::Foundation::HWND,
    target: windows::Win32::Foundation::HWND,
) -> bool {
    !start.is_invalid() && start == foreground && start == target
}

#[cfg(target_os = "windows")]
pub fn install_shortcut<G, A, F>(get_shortcut: G, allow_shortcut: A, on_shortcut: F)
where
    G: Fn() -> String + Send + Sync + 'static,
    A: Fn() -> bool + Send + Sync + 'static,
    F: Fn() + Send + Sync + 'static,
{
    use std::sync::Mutex;
    use std::sync::OnceLock;
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetWindowsHookExW, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL,
        WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    static GET_SHORTCUT: OnceLock<Box<dyn Fn() -> String + Send + Sync>> = OnceLock::new();
    static ALLOW: OnceLock<Box<dyn Fn() -> bool + Send + Sync>> = OnceLock::new();
    static CALLBACK: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();
    static PRESS: Mutex<SummonPress> = Mutex::new(SummonPress(None));

    let _ = GET_SHORTCUT.set(Box::new(get_shortcut));
    let _ = ALLOW.set(Box::new(allow_shortcut));
    let _ = CALLBACK.set(Box::new(on_shortcut));

    fn current_spec() -> Option<ShortcutSpec> {
        let accel = GET_SHORTCUT.get()?();
        parse_shortcut(&accel, true).ok().flatten()
    }

    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let msg = wparam.0 as u32;
            let info = unsafe { *(lparam.0 as *const KBDLLHOOKSTRUCT) };
            let vk = info.vkCode as u16;
            if !matches!(msg, WM_KEYDOWN | WM_KEYUP | WM_SYSKEYDOWN | WM_SYSKEYUP) {
                return unsafe { CallNextHookEx(None, code, wparam, lparam) };
            }
            let pressed = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            let mut press = PRESS.lock().unwrap();
            let matches = press.0.is_none()
                && pressed
                && current_spec().is_some_and(|spec| vk == spec.vk_code && modifiers_match(&spec))
                && ALLOW.get().is_some_and(|allow| allow());
            let action = press.handle(vk, pressed, matches);
            match action {
                SummonKeyAction::Pass => {}
                SummonKeyAction::Consume => return LRESULT(1),
                SummonKeyAction::Release => {
                    // Let Windows finish delivering this key-up before the
                    // application changes the foreground window.
                    let _ = windows::Win32::UI::WindowsAndMessaging::PostThreadMessageW(
                        windows::Win32::System::Threading::GetCurrentThreadId(),
                        SUMMON_MESSAGE,
                        WPARAM(0),
                        LPARAM(0),
                    );
                    return LRESULT(1);
                }
            }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    const SUMMON_MESSAGE: u32 = windows::Win32::UI::WindowsAndMessaging::WM_APP + 1;
    std::thread::spawn(move || unsafe {
        let h = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), None, 0);
        if h.is_err() {
            eprintln!("[HOOK] SetWindowsHookExW for shortcut failed");
            return;
        }
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.message == SUMMON_MESSAGE {
                if let Some(callback) = CALLBACK.get() {
                    callback();
                }
            }
        }
    });
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, PartialEq, Eq)]
enum SummonKeyAction {
    Pass,
    Consume,
    Release,
}

#[cfg(any(target_os = "windows", test))]
struct SummonPress(Option<u16>);

#[cfg(any(target_os = "windows", test))]
impl SummonPress {
    fn handle(&mut self, key: u16, pressed: bool, matches: bool) -> SummonKeyAction {
        if self.0 == Some(key) {
            if pressed {
                return SummonKeyAction::Consume;
            }
            self.0 = None;
            return SummonKeyAction::Release;
        }
        if self.0.is_none() && pressed && matches {
            self.0 = Some(key);
            return SummonKeyAction::Consume;
        }
        SummonKeyAction::Pass
    }
}

#[cfg(test)]
#[test]
fn summon_dispatches_on_release_and_ignores_auto_repeat() {
    use SummonKeyAction::*;
    let mut press = SummonPress(None);
    assert_eq!(press.handle(123, true, false), Pass);
    assert_eq!(press.handle(123, false, false), Pass);
    assert_eq!(press.handle(123, true, true), Consume);
    assert_eq!(press.handle(123, true, true), Consume);
    assert_eq!(press.handle(16, false, false), Pass);
    assert_eq!(press.handle(123, false, false), Release);
    assert_eq!(press.handle(123, false, false), Pass);
    assert_eq!(press.handle(123, true, true), Consume);
    assert_eq!(press.handle(123, false, false), Release);
}

#[cfg(target_os = "windows")]
fn modifiers_match(spec: &ShortcutSpec) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };
    let ctrl = key_down(VK_CONTROL.0 as i32);
    let shift = key_down(VK_SHIFT.0 as i32);
    let alt = key_down(VK_MENU.0 as i32);
    let super_key = key_down(VK_LWIN.0 as i32) || key_down(VK_RWIN.0 as i32);
    ctrl == spec.ctrl && shift == spec.shift && alt == spec.alt && super_key == spec.super_key
}

#[cfg(target_os = "windows")]
fn key_down(vk: i32) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;

    // High bit of GetAsyncKeyState = currently held.
    (unsafe { GetAsyncKeyState(vk) } as u16 & 0x8000) != 0
}

#[cfg(not(target_os = "windows"))]
pub fn install_eyedropper_click<G, F>(_get_shortcut: G, _on_click: F)
where
    G: Fn() -> (String, bool) + Send + Sync + 'static,
    F: Fn(i32, i32, EyedropperAction) + Send + Sync + 'static,
{
    eprintln!("[HOOK] eyedropper click hook not implemented on this platform yet.");
}

#[cfg(not(target_os = "windows"))]
pub fn install_shortcut<G, A, F>(_get_shortcut: G, _allow_shortcut: A, _on_shortcut: F)
where
    G: Fn() -> String + Send + Sync + 'static,
    A: Fn() -> bool + Send + Sync + 'static,
    F: Fn() + Send + Sync + 'static,
{
    eprintln!("[HOOK] shortcut hook not implemented on this platform yet.");
}

#[cfg(target_os = "windows")]
pub fn is_text_focused() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetGUIThreadInfo, GUITHREADINFO};
    let mut info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    if unsafe { GetGUIThreadInfo(0, &mut info) }.is_err() {
        return false;
    }
    if !info.hwndCaret.is_invalid() {
        return true;
    }
    let mut name = [0u16; 128];
    let len = unsafe { GetClassNameW(info.hwndFocus, &mut name) } as usize;
    let class = String::from_utf16_lossy(&name[..len]).to_ascii_lowercase();
    class == "edit" || class.starts_with("richedit")
}

#[cfg(target_os = "windows")]
pub fn is_csp_foreground() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    is_csp_process_window(unsafe { GetForegroundWindow() })
}

#[cfg(target_os = "windows")]
fn is_csp_window(hwnd: windows::Win32::Foundation::HWND) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowTextW;
    unsafe {
        if hwnd.is_invalid() {
            return false;
        }
        let mut buf = [0u16; 256];
        let len = GetWindowTextW(hwnd, &mut buf);
        if len == 0 {
            return false;
        }
        let title = String::from_utf16_lossy(&buf[..len as usize]);
        title.to_uppercase().contains("CLIP STUDIO PAINT")
    }
}

#[cfg(target_os = "windows")]
fn is_csp_process_window(hwnd: windows::Win32::Foundation::HWND) -> bool {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    let Ok(process) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) })
    else {
        return false;
    };
    let mut buffer = [0u16; 1024];
    let mut len = buffer.len() as u32;
    let result = unsafe {
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(process);
        result
    };
    if result.is_err() {
        return false;
    }
    let path = String::from_utf16_lossy(&buffer[..len as usize]);
    std::path::Path::new(&path)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(crate::csp_process::is_csp_executable)
}

#[cfg(not(target_os = "windows"))]
pub fn is_csp_foreground() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_eyedropper_syncs_once_and_alt_does_not_summon_unpinned() {
        use EyedropperAction::{Show, SyncPinned};
        assert_eq!(eyedropper_action(false, true, false), None);
        assert_eq!(eyedropper_action(false, true, true), Some(SyncPinned));
        assert_eq!(eyedropper_action(true, false, true), Some(SyncPinned));
        assert_eq!(eyedropper_action(true, true, true), Some(SyncPinned));
        assert_eq!(eyedropper_action(true, true, false), Some(Show));
        assert_eq!(eyedropper_action(true, false, false), Some(Show));
        assert_eq!(eyedropper_action(false, false, true), None);
    }

    #[test]
    fn global_shortcut_requires_modifiers_to_avoid_typing_conflicts() {
        assert!(validate_shortcut("Ctrl+Shift+F12").is_ok());
        assert!(validate_shortcut("Alt+F8").is_ok());
        assert!(validate_shortcut("Ctrl+Alt+P").is_ok());
        assert!(validate_shortcut("P").is_err());
        assert!(validate_shortcut("Ctrl+P").is_err());
        assert!(validate_shortcut("").is_ok());
        assert!(parse_shortcut("Alt+P", true).unwrap().is_some());
    }

    #[test]
    fn palette_shortcut_can_be_unmodified() {
        assert!(validate_palette_shortcut("Escape").is_ok());
        assert!(validate_palette_shortcut("Shift+ArrowDown").is_ok());
        assert!(validate_palette_shortcut("Shift").is_err());
    }

    #[test]
    fn eyedropper_accepts_plain_keys_and_alt_and_detects_equivalent_chords() {
        for key in ["Q", "E", "F8", "Ctrl+Q", "Alt", ""] {
            assert!(validate_eyedropper_shortcut(key).is_ok(), "{key}");
        }
        assert!(validate_eyedropper_shortcut("Ctrl+Alt").is_err());
        assert!(shortcuts_conflict("Ctrl+Shift+F12", "shift+Control+f12"));
        assert!(shortcuts_conflict("Q", "q"));
        assert!(!shortcuts_conflict("Q", "Alt"));
        assert!(!shortcuts_conflict("Q", "Ctrl+Q"));
        assert!(!shortcuts_conflict("", ""));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn eyedropper_release_requires_a_matched_press_and_the_same_foreground_target() {
        use windows::Win32::Foundation::HWND;
        let csp = HWND(1usize as _);
        let other = HWND(2usize as _);
        assert!(!completes_eyedropper_click(HWND::default(), csp, csp));
        assert!(!completes_eyedropper_click(csp, other, csp));
        assert!(!completes_eyedropper_click(csp, csp, other));
        assert!(completes_eyedropper_click(csp, csp, csp));
    }
}
