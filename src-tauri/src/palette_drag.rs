use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Default)]
struct DragFocus {
    moving: bool,
    grace_until: Option<Instant>,
}

impl DragFocus {
    fn protects(&self, now: Instant) -> bool {
        self.moving || self.grace_until.is_some_and(|until| now < until)
    }
}

static FOCUS: Mutex<DragFocus> = Mutex::new(DragFocus {
    moving: false,
    grace_until: None,
});

pub fn protects_focus() -> bool {
    FOCUS.lock().unwrap().protects(Instant::now())
}

#[cfg(target_os = "windows")]
fn is_caption_press(message: u32, wparam: usize) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{HTCAPTION, WM_NCLBUTTONDOWN, WM_NCPOINTERDOWN};
    match message {
        WM_NCLBUTTONDOWN => wparam == HTCAPTION as usize,
        WM_NCPOINTERDOWN => (wparam >> 16) & 0xffff == HTCAPTION as usize,
        _ => false,
    }
}

#[cfg(target_os = "windows")]
mod move_feedback {
    use std::cell::Cell;
    use std::ffi::c_void;
    use std::mem::{size_of, transmute};
    use windows::core::{s, w};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};

    // The Windows 11 move overlay adds its own frame and shadow. This
    // attribute is private, so only use it when both APIs and BOOL readback
    // work on this window. Never rely on it for input or movement.
    const DISABLE_MOVESIZE_FEEDBACK: i32 = 29;

    #[repr(C)]
    struct CompositionAttribute {
        attribute: i32,
        value: *mut c_void,
        size: usize,
    }

    type CompositionFn = unsafe extern "system" fn(HWND, *mut CompositionAttribute) -> i32;

    #[derive(Clone, Copy)]
    struct Restore {
        setter: CompositionFn,
        original: i32,
    }

    thread_local! {
        // The observer is installed only on the main palette HWND.
        static RESTORE: Cell<Option<Restore>> = const { Cell::new(None) };
    }

    fn call(api: CompositionFn, hwnd: HWND, value: &mut i32) -> bool {
        let mut data = CompositionAttribute {
            attribute: DISABLE_MOVESIZE_FEEDBACK,
            value: (value as *mut i32).cast(),
            size: size_of::<i32>(),
        };
        unsafe { api(hwnd, &mut data) != 0 }
    }

    // Return the original value when we need to restore it on destruction.
    // If a write cannot be verified, roll it back immediately.
    fn disable(read: impl Fn() -> Option<i32>, write: impl Fn(i32) -> bool) -> Option<i32> {
        let original = read()?;
        if original != 0 {
            return None;
        }
        if write(1) && read() == Some(1) {
            return Some(original);
        }
        if !write(original) {
            eprintln!("Could not restore palette move feedback after an unverified write");
            return Some(original);
        }
        None
    }

    pub(super) fn apply(hwnd: HWND) {
        let Ok(user32) = (unsafe { GetModuleHandleW(w!("user32.dll")) }) else {
            return;
        };
        let (Some(get), Some(set)) = (unsafe {
            (
                GetProcAddress(user32, s!("GetWindowCompositionAttribute")),
                GetProcAddress(user32, s!("SetWindowCompositionAttribute")),
            )
        }) else {
            return;
        };
        let getter: CompositionFn = unsafe { transmute(get) };
        let setter: CompositionFn = unsafe { transmute(set) };
        let original = disable(
            || {
                let mut value = -1;
                call(getter, hwnd, &mut value).then_some(value)
            },
            |mut value| call(setter, hwnd, &mut value),
        );
        if let Some(original) = original {
            RESTORE.set(Some(Restore { setter, original }));
        }
    }

    pub(super) fn restore(hwnd: HWND) {
        if let Some(Restore {
            setter,
            mut original,
        }) = RESTORE.take()
        {
            if !call(setter, hwnd, &mut original) {
                eprintln!("Could not restore palette move feedback on window destruction");
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn unsupported_or_already_disabled_feedback_is_not_written() {
            for value in [None, Some(-1), Some(1)] {
                assert_eq!(disable(|| value, |_| panic!("unexpected write")), None);
            }
        }

        #[test]
        fn verified_write_keeps_original_and_unverified_write_rolls_back() {
            let value = Cell::new(0);
            assert_eq!(
                disable(
                    || Some(value.get()),
                    |next| {
                        value.set(next);
                        true
                    }
                ),
                Some(0)
            );
            assert_eq!(value.get(), 1);

            let writes = std::cell::RefCell::new(Vec::new());
            assert_eq!(
                disable(
                    || Some(0),
                    |next| {
                        writes.borrow_mut().push(next);
                        true
                    }
                ),
                None
            );
            assert_eq!(*writes.borrow(), [1, 0]);
        }
    }
}

#[cfg(target_os = "windows")]
pub fn observe(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        WM_CANCELMODE, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_MOVING, WM_NCDESTROY,
    };

    // Only observe the standard Tauri/Windows move loop on this HWND.
    // All messages still go through the original window procedure.
    unsafe extern "system" fn procedure(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        id: usize,
        _: usize,
    ) -> LRESULT {
        match message {
            _ if is_caption_press(message, wparam.0) => {
                FOCUS.lock().unwrap().grace_until =
                    Some(Instant::now() + Duration::from_millis(350));
            }
            WM_ENTERSIZEMOVE => FOCUS.lock().unwrap().moving = true,
            WM_MOVING => {
                // Also cover a native move that reports movement before entering
                // the modal move loop. Keep this grace bounded.
                FOCUS.lock().unwrap().grace_until =
                    Some(Instant::now() + Duration::from_millis(110));
            }
            WM_EXITSIZEMOVE | WM_CANCELMODE => {
                let mut state = FOCUS.lock().unwrap();
                state.moving = false;
                state.grace_until = Some(Instant::now() + Duration::from_millis(110));
            }
            WM_NCDESTROY => {
                move_feedback::restore(hwnd);
                *FOCUS.lock().unwrap() = DragFocus::default();
                let _ = RemoveWindowSubclass(hwnd, Some(procedure), id);
            }
            _ => {}
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }

    if let Ok(hwnd) = window.hwnd() {
        let hwnd = HWND(hwnd.0);
        if unsafe { SetWindowSubclass(hwnd, Some(procedure), 1, 0) }.as_bool() {
            move_feedback::apply(hwnd);
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn observe(_: &tauri::WebviewWindow) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caption_grace_and_native_move_protect_blur() {
        let now = Instant::now();
        let mut state = DragFocus::default();
        assert!(!state.protects(now));
        state.grace_until = Some(now + Duration::from_millis(350));
        assert!(state.protects(now));
        let later = now + Duration::from_secs(2);
        assert!(!state.protects(later));
        state.moving = true;
        assert!(state.protects(later));
        state.moving = false;
        assert!(!state.protects(later));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn caption_mouse_and_pen_press_are_distinct_from_client_input() {
        use windows::Win32::UI::WindowsAndMessaging::{
            HTCAPTION, HTCLIENT, WM_NCLBUTTONDOWN, WM_NCPOINTERDOWN, WM_POINTERDOWN,
        };
        assert!(is_caption_press(WM_NCLBUTTONDOWN, HTCAPTION as usize));
        assert!(is_caption_press(
            WM_NCPOINTERDOWN,
            (HTCAPTION as usize) << 16 | 7
        ));
        assert!(!is_caption_press(
            WM_NCPOINTERDOWN,
            (HTCLIENT as usize) << 16 | 7
        ));
        assert!(!is_caption_press(WM_POINTERDOWN, 7));
    }
}
