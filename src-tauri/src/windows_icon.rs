//! Windows-specific product icon integration.

use std::ffi::{c_char, c_void};
use std::ptr;

const APP_ICON_RESOURCE_ID: usize = 32_512;
const IMAGE_ICON: u32 = 1;
const LR_SHARED: u32 = 0x0000_8000;
const WM_SETICON: u32 = 0x0080;
const ICON_SMALL: usize = 0;
const ICON_BIG: usize = 1;
const GCLP_HICON: i32 = -14;
const GCLP_HICONSM: i32 = -34;
const SM_CXICON: i32 = 11;
const SM_CYICON: i32 = 12;
const SM_CXSMICON: i32 = 49;
const SM_CYSMICON: i32 = 50;

type GetDpiForWindowFn = unsafe extern "system" fn(*mut c_void) -> u32;
type GetSystemMetricsForDpiFn = unsafe extern "system" fn(i32, u32) -> i32;

#[derive(Clone, Copy)]
struct IconSize {
    width: i32,
    height: i32,
}

#[link(name = "kernel32")]
#[allow(unsafe_code)]
unsafe extern "system" {
    fn GetLastError() -> u32;
    fn GetModuleHandleW(module_name: *const u16) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, proc_name: *const c_char) -> *mut c_void;
    fn SetLastError(error_code: u32);
}

#[link(name = "user32")]
#[allow(unsafe_code)]
unsafe extern "system" {
    fn GetSystemMetrics(index: i32) -> i32;
    fn LoadImageW(
        instance: *mut c_void,
        name: *const u16,
        image_type: u32,
        width: i32,
        height: i32,
        load_flags: u32,
    ) -> *mut c_void;
    fn SendMessageW(window: *mut c_void, message: u32, wparam: usize, lparam: isize) -> isize;
    #[cfg_attr(target_pointer_width = "32", link_name = "SetClassLongW")]
    fn SetClassLongPtrW(window: *mut c_void, index: i32, new_value: usize) -> usize;
}

fn fallback_metric(index: i32) -> i32 {
    // SAFETY: GetSystemMetrics accepts the documented SM_* indices used here.
    #[allow(unsafe_code)]
    let value = unsafe { GetSystemMetrics(index) };
    if value > 0 {
        value
    } else if matches!(index, SM_CXICON | SM_CYICON) {
        32
    } else {
        16
    }
}

fn dpi_functions() -> Option<(GetDpiForWindowFn, GetSystemMetricsForDpiFn)> {
    let user32_name: Vec<u16> = "user32.dll"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: The string is null-terminated and user32 is already loaded by Tauri.
    #[allow(unsafe_code)]
    let user32 = unsafe { GetModuleHandleW(user32_name.as_ptr()) };
    if user32.is_null() {
        return None;
    }

    // Resolve these Windows 10 APIs dynamically so older supported systems can
    // fall back to GetSystemMetrics instead of failing while loading the app.
    // SAFETY: Both names are null-terminated and the returned addresses are
    // checked before conversion to their documented system-call signatures.
    #[allow(unsafe_code)]
    let get_dpi = unsafe { GetProcAddress(user32, c"GetDpiForWindow".as_ptr()) };
    #[allow(unsafe_code)]
    let get_metrics = unsafe { GetProcAddress(user32, c"GetSystemMetricsForDpi".as_ptr()) };
    if get_dpi.is_null() || get_metrics.is_null() {
        return None;
    }

    // SAFETY: GetProcAddress returned non-null addresses for the exact APIs and
    // their signatures match the Windows declarations above.
    #[allow(unsafe_code)]
    let get_dpi = unsafe { std::mem::transmute::<*mut c_void, GetDpiForWindowFn>(get_dpi) };
    #[allow(unsafe_code)]
    let get_metrics =
        unsafe { std::mem::transmute::<*mut c_void, GetSystemMetricsForDpiFn>(get_metrics) };
    Some((get_dpi, get_metrics))
}

fn icon_sizes(window_handle: *mut c_void) -> (IconSize, IconSize) {
    let fallback_big = IconSize {
        width: fallback_metric(SM_CXICON),
        height: fallback_metric(SM_CYICON),
    };
    let fallback_small = IconSize {
        width: fallback_metric(SM_CXSMICON),
        height: fallback_metric(SM_CYSMICON),
    };
    let Some((get_dpi, get_metrics)) = dpi_functions() else {
        return (fallback_big, fallback_small);
    };

    // SAFETY: Tauri supplied a live HWND and the function pointer was resolved
    // from user32 with the documented signature.
    #[allow(unsafe_code)]
    let dpi = unsafe { get_dpi(window_handle) };
    if dpi == 0 {
        return (fallback_big, fallback_small);
    }

    let metric = |index, fallback| {
        // SAFETY: The function pointer and SM_* index are valid for this call.
        #[allow(unsafe_code)]
        let value = unsafe { get_metrics(index, dpi) };
        if value > 0 {
            value
        } else {
            fallback
        }
    };
    (
        IconSize {
            width: metric(SM_CXICON, fallback_big.width),
            height: metric(SM_CYICON, fallback_big.height),
        },
        IconSize {
            width: metric(SM_CXSMICON, fallback_small.width),
            height: metric(SM_CYSMICON, fallback_small.height),
        },
    )
}

fn load_icon(
    module_handle: *mut c_void,
    size: IconSize,
    role: &str,
) -> Result<*mut c_void, String> {
    // SAFETY: The module handle is valid, the integer resource pointer follows
    // MAKEINTRESOURCEW, and LR_SHARED keeps the returned icon process-owned.
    #[allow(unsafe_code)]
    let icon_handle = unsafe {
        LoadImageW(
            module_handle,
            APP_ICON_RESOURCE_ID as *const u16,
            IMAGE_ICON,
            size.width,
            size.height,
            LR_SHARED,
        )
    };
    if icon_handle.is_null() {
        // SAFETY: GetLastError has no preconditions and immediately follows the
        // failed Win32 call whose diagnostic code is needed.
        #[allow(unsafe_code)]
        let error = unsafe { GetLastError() };
        return Err(format!(
            "could not load the bundled Nyala {role} icon at {}x{} (Windows error {error})",
            size.width, size.height
        ));
    }
    Ok(icon_handle)
}

fn set_class_icon(
    window_handle: *mut c_void,
    index: i32,
    icon_handle: *mut c_void,
    role: &str,
) -> Result<(), String> {
    // SetClassLongPtrW returns zero both when it fails and when the previous
    // class value was null, so the last-error value must disambiguate the two.
    #[allow(unsafe_code)]
    unsafe {
        SetLastError(0);
        let previous = SetClassLongPtrW(window_handle, index, icon_handle as usize);
        if previous == 0 {
            let error = GetLastError();
            if error != 0 {
                return Err(format!(
                    "could not install the bundled Nyala {role} class icon (Windows error {error})"
                ));
            }
        }
    }
    Ok(())
}

fn set_product_icons(window_handle: *mut c_void, set_class_fallback: bool) -> Result<(), String> {
    // SAFETY: A null module name asks Windows for the current executable module.
    #[allow(unsafe_code)]
    let module_handle = unsafe { GetModuleHandleW(ptr::null()) };
    if module_handle.is_null() {
        return Err("could not resolve the Nyala executable module".to_string());
    }

    let (big_size, small_size) = icon_sizes(window_handle);
    let big_icon = load_icon(module_handle, big_size, "taskbar")?;
    let small_icon = load_icon(module_handle, small_size, "window")?;

    // SAFETY: Tauri supplied a live HWND. LR_SHARED icons remain system-shared
    // for the process lifetime and must not be destroyed by the application.
    #[allow(unsafe_code)]
    unsafe {
        SendMessageW(window_handle, WM_SETICON, ICON_BIG, big_icon as isize);
        SendMessageW(window_handle, WM_SETICON, ICON_SMALL, small_icon as isize);
    }

    // Tao windows share a native window class, so only initialize its fallback
    // once. Per-monitor DPI changes must update WM_SETICON for that window only.
    if set_class_fallback {
        set_class_icon(window_handle, GCLP_HICON, big_icon, "taskbar")?;
        set_class_icon(window_handle, GCLP_HICONSM, small_icon, "window")?;
    }

    Ok(())
}

pub(crate) fn set_webview_icons(window: &tauri::WebviewWindow) -> Result<(), String> {
    let window_handle = window.hwnd().map_err(|error| error.to_string())?.0;
    set_product_icons(window_handle, true)
}

pub(crate) fn refresh_window_icons(window: &tauri::Window) -> Result<(), String> {
    let window_handle = window.hwnd().map_err(|error| error.to_string())?.0;
    set_product_icons(window_handle, false)
}
