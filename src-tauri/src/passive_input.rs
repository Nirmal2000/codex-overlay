use std::ffi::c_void;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

type CGEventRef = *mut c_void;
type CFMachPortRef = *mut c_void;
type CFRunLoopRef = *mut c_void;
type CFRunLoopSourceRef = *mut c_void;

const KEY_DOWN: u32 = 10;
const KEYCODE_FIELD: i32 = 9;
const SHIFT_FLAG: u64 = 0x0002_0000;
const COMMAND_FLAG: u64 = 0x0010_0000;
const OPTION_FLAG: u64 = 0x0008_0000;

fn remote_scroll_action(keycode: u16, flags: u64) -> Option<&'static str> {
    if flags & OPTION_FLAG == 0 {
        return None;
    }
    match keycode {
        126 if flags & SHIFT_FLAG != 0 => Some("page_up"),
        125 if flags & COMMAND_FLAG != 0 => Some("jump_bottom"),
        125 if flags & SHIFT_FLAG != 0 => Some("page_down"),
        126 => Some("step_up"),
        125 => Some("step_down"),
        49 => Some("toggle_follow"),
        _ => None,
    }
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events_of_interest: u64,
        callback: extern "C" fn(*mut c_void, u32, CGEventRef, *mut c_void) -> CGEventRef,
        user_info: *mut c_void,
    ) -> CFMachPortRef;
    fn CGEventGetIntegerValueField(event: CGEventRef, field: i32) -> i64;
    fn CGEventGetFlags(event: CGEventRef) -> u64;
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGPreflightListenEventAccess() -> bool;
    fn CGRequestListenEventAccess() -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFRunLoopCommonModes: *const c_void;
    fn CFMachPortCreateRunLoopSource(
        allocator: *const c_void,
        port: CFMachPortRef,
        order: isize,
    ) -> CFRunLoopSourceRef;
    fn CFRunLoopGetCurrent() -> CFRunLoopRef;
    fn CFRunLoopAddSource(run_loop: CFRunLoopRef, source: CFRunLoopSourceRef, mode: *const c_void);
    fn CFRunLoopRun();
}

#[derive(Clone, Default)]
pub struct PassiveInputState {
    active: Arc<AtomicBool>,
    ready: Arc<AtomicBool>,
}

struct ListenerContext {
    app: AppHandle,
    active: Arc<AtomicBool>,
}

#[tauri::command]
pub fn set_passive_capture(state: tauri::State<PassiveInputState>, active: bool) -> bool {
    state.active.store(active, Ordering::Relaxed);
    active
}

#[tauri::command]
pub fn get_passive_capture(state: tauri::State<PassiveInputState>) -> bool {
    state.active.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn get_passive_input_ready(state: tauri::State<PassiveInputState>) -> bool {
    state.ready.load(Ordering::Acquire)
}

pub fn start_listener(app: AppHandle) {
    let state = app.state::<PassiveInputState>();
    let active = state.active.clone();
    let ready = state.ready.clone();
    std::thread::spawn(move || unsafe {
        if !CGPreflightListenEventAccess() {
            let _ = CGRequestListenEventAccess();
        }
        let context = Box::into_raw(Box::new(ListenerContext {
            app: app.clone(),
            active,
        }));
        let tap = loop {
            let tap = CGEventTapCreate(0, 0, 1, 1 << KEY_DOWN, event_callback, context.cast());
            if !tap.is_null() {
                ready.store(true, Ordering::Release);
                let _ = app.emit("passive-input-ready", ());
                break tap;
            }
            ready.store(false, Ordering::Release);
            let _ = app.emit(
                "passive-input-error",
                "Enable Codex Overlay in System Settings > Privacy & Security > Input Monitoring; capture will connect automatically after permission is granted",
            );
            std::thread::sleep(std::time::Duration::from_secs(2));
        };

        let source = CFMachPortCreateRunLoopSource(ptr::null(), tap, 0);
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
        CGEventTapEnable(tap, true);
        CFRunLoopRun();
    });
}

extern "C" fn event_callback(
    _proxy: *mut c_void,
    event_type: u32,
    event: CGEventRef,
    user_info: *mut c_void,
) -> CGEventRef {
    if event_type != KEY_DOWN || user_info.is_null() {
        return event;
    }
    let context = unsafe { &*(user_info as *const ListenerContext) };
    let keycode = unsafe { CGEventGetIntegerValueField(event, KEYCODE_FIELD) } as u16;
    let flags = unsafe { CGEventGetFlags(event) };
    if flags & OPTION_FLAG != 0 {
        if let Some(action) = remote_scroll_action(keycode, flags) {
            crate::remote::broadcast_scroll(&context.app, action);
            return event;
        }
        if keycode == 31 && flags & COMMAND_FLAG != 0 {
            if let Some(window) = context.app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            return event;
        }
    }
    if keycode == 53 && flags & OPTION_FLAG != 0 {
        let _ = context.app.emit("passive-stop", ());
        return event;
    }
    if !context.active.load(Ordering::Relaxed) {
        return event;
    }

    match keycode {
        36 | 76 => {
            let _ = context.app.emit("passive-submit", ());
        }
        1 if flags & OPTION_FLAG != 0 => {
            let _ = context.app.emit("passive-screenshot", ());
        }
        51 => {
            let _ = context.app.emit("passive-backspace", ());
        }
        50 | 56 | 60 => {}
        _ => {
            let shifted = flags & SHIFT_FLAG != 0;
            if let Some(text) = keycode_text(keycode, shifted) {
                let _ = context.app.emit("passive-key", text);
            }
        }
    }
    event
}

fn keycode_text(keycode: u16, shifted: bool) -> Option<&'static str> {
    let pair = match keycode {
        0 => ("a", "A"),
        1 => ("s", "S"),
        2 => ("d", "D"),
        3 => ("f", "F"),
        4 => ("h", "H"),
        5 => ("g", "G"),
        6 => ("z", "Z"),
        7 => ("x", "X"),
        8 => ("c", "C"),
        9 => ("v", "V"),
        11 => ("b", "B"),
        12 => ("q", "Q"),
        13 => ("w", "W"),
        14 => ("e", "E"),
        15 => ("r", "R"),
        16 => ("y", "Y"),
        17 => ("t", "T"),
        18 => ("1", "!"),
        19 => ("2", "@"),
        20 => ("3", "#"),
        21 => ("4", "$"),
        22 => ("6", "^"),
        23 => ("5", "%"),
        24 => ("=", "+"),
        25 => ("9", "("),
        26 => ("7", "&"),
        27 => ("-", "_"),
        28 => ("8", "*"),
        29 => ("0", ")"),
        30 => ("]", "}"),
        31 => ("o", "O"),
        32 => ("u", "U"),
        33 => ("[", "{"),
        34 => ("i", "I"),
        35 => ("p", "P"),
        37 => ("l", "L"),
        38 => ("j", "J"),
        39 => ("'", "\""),
        40 => ("k", "K"),
        41 => (";", ":"),
        42 => ("\\", "|"),
        43 => (",", "<"),
        44 => ("/", "?"),
        45 => ("n", "N"),
        46 => ("m", "M"),
        47 => (".", ">"),
        48 => ("\t", "\t"),
        49 => (" ", " "),
        _ => return None,
    };
    Some(if shifted { pair.1 } else { pair.0 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_us_keycodes_without_platform_text_apis() {
        assert_eq!(keycode_text(0, false), Some("a"));
        assert_eq!(keycode_text(0, true), Some("A"));
        assert_eq!(keycode_text(18, true), Some("!"));
        assert_eq!(keycode_text(76, false), None);
    }

    #[test]
    fn maps_precise_and_page_remote_scroll_shortcuts() {
        assert_eq!(remote_scroll_action(126, OPTION_FLAG), Some("step_up"));
        assert_eq!(remote_scroll_action(125, OPTION_FLAG), Some("step_down"));
        assert_eq!(
            remote_scroll_action(126, OPTION_FLAG | SHIFT_FLAG),
            Some("page_up")
        );
        assert_eq!(
            remote_scroll_action(125, OPTION_FLAG | SHIFT_FLAG),
            Some("page_down")
        );
        assert_eq!(
            remote_scroll_action(125, OPTION_FLAG | COMMAND_FLAG),
            Some("jump_bottom")
        );
        assert_eq!(remote_scroll_action(49, OPTION_FLAG), Some("toggle_follow"));
        assert_eq!(remote_scroll_action(125, 0), None);
    }
}
