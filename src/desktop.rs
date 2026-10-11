//! The desktop window: DevTree's UI in its own native window instead of a browser tab.
//!
//! The page is drawn by the system's web engine (WebView2 on Windows, WKWebView on macOS,
//! WebKitGTK on Linux), so DevTree stays small: no bundled browser. The window loads the same
//! local server a browser would, so every request guard still applies.

use std::path::Path;
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    window::{Icon, WindowBuilder},
};
use wry::{NewWindowResponse, WebContext, WebViewBuilder};

/// Must run before DevTree starts any other thread (it may set environment variables).
pub fn prepare() {
    // WebKitGTK's DMA-BUF renderer shows an empty window on many setups (virtual machines,
    // NVIDIA drivers, remote X). The fallback draws the same page, just with less GPU help.
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // SAFETY: no other thread exists yet, so nothing reads the environment concurrently.
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }
}

/// Opens the window on `url` and runs it on this (the main) thread until it is closed,
/// then exits the process.
pub fn run(url: &str, data_dir: &Path) -> ! {
    #[cfg(windows)]
    detach_console();

    let event_loop = EventLoop::new();
    #[cfg(target_os = "macos")]
    let menu = macos_menu();

    let window = WindowBuilder::new()
        .with_title("DevTree")
        .with_inner_size(LogicalSize::new(1440.0, 900.0))
        .with_min_inner_size(LogicalSize::new(900.0, 560.0))
        .with_window_icon(window_icon())
        .build(&event_loop)
        .unwrap_or_else(|e| fail(&format!("cannot open a window: {e}")));

    // Keeps local storage (theme, layout, last repository) between runs.
    let mut context = WebContext::new(Some(data_dir.join("webview")));
    let origin = format!("{url}/");
    let builder = WebViewBuilder::new_with_web_context(&mut context)
        .with_url(url)
        .with_background_color((13, 19, 23, 255))
        .with_clipboard(true)
        .with_hotkeys_zoom(true)
        .with_devtools(cfg!(debug_assertions))
        // Only DevTree's own pages load in the window; web links open in the browser.
        .with_navigation_handler(move |to| {
            if to.starts_with(&origin) || to == url_without_slash(&origin) || to.starts_with("about:") {
                return true;
            }
            open_external(&to);
            false
        })
        .with_new_window_req_handler(|to, _| {
            open_external(&to);
            NewWindowResponse::Deny
        });

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window.default_vbox().unwrap_or_else(|| fail("the window has no content area"));
        builder.build_gtk(vbox)
    };
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let webview = builder.build(&window);
    let webview = webview.unwrap_or_else(|e| fail(&format!("cannot show the page: {e}")));

    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        // Owned by the loop so they live as long as the window.
        let _ = (&window, &webview, &context);
        match event {
            #[cfg(target_os = "macos")]
            Event::NewEvents(tao::event::StartCause::Init) => menu.init_for_nsapp(),
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => *flow = ControlFlow::Exit,
            _ => {}
        }
    })
}

/// The ⎇ logo (assets/icon.svg) as 64×64 RGBA pixels, for the title bar and taskbar.
fn window_icon() -> Option<Icon> {
    Icon::from_rgba(include_bytes!("../assets/icon-64.rgba").to_vec(), 64, 64).ok()
}

fn url_without_slash(origin: &str) -> &str {
    origin.strip_suffix('/').unwrap_or(origin)
}

/// Web links go to the default browser. Anything else (file:, custom schemes) is ignored,
/// so page content can never make DevTree launch another program.
fn open_external(url: &str) {
    if url.starts_with("https://") || url.starts_with("http://") {
        crate::open_browser(url);
    }
}

fn fail(msg: &str) -> ! {
    eprintln!("devtree: {msg}");
    eprintln!("Run `devtree --browser` to use DevTree in your web browser instead.");
    std::process::exit(1);
}

/// Started by double-clicking, Windows gives DevTree a console window of its own. Close it;
/// a console shared with a terminal the user started DevTree from is left alone.
#[cfg(windows)]
fn detach_console() {
    unsafe extern "system" {
        fn GetConsoleProcessList(list: *mut u32, count: u32) -> u32;
        fn FreeConsole() -> i32;
    }
    let mut pids = [0u32; 2];
    // SAFETY: the buffer holds `pids.len()` entries; both calls only affect this process.
    unsafe {
        if GetConsoleProcessList(pids.as_mut_ptr(), pids.len() as u32) == 1 {
            FreeConsole();
        }
    }
}

/// macOS only delivers Cmd+C/V/X/A/Z, Cmd+Q and friends to a window through its menu bar.
#[cfg(target_os = "macos")]
fn macos_menu() -> muda::Menu {
    use muda::{Menu, PredefinedMenuItem as Item, Submenu};
    let build = || -> muda::Result<Menu> {
        let app = Submenu::with_items(
            "DevTree",
            true,
            &[
                &Item::about(None, None),
                &Item::separator(),
                &Item::hide(None),
                &Item::hide_others(None),
                &Item::show_all(None),
                &Item::separator(),
                &Item::quit(None),
            ],
        )?;
        let edit = Submenu::with_items(
            "Edit",
            true,
            &[
                &Item::undo(None),
                &Item::redo(None),
                &Item::separator(),
                &Item::cut(None),
                &Item::copy(None),
                &Item::paste(None),
                &Item::select_all(None),
            ],
        )?;
        let view = Submenu::with_items("View", true, &[&Item::fullscreen(None)])?;
        let window = Submenu::with_items(
            "Window",
            true,
            &[&Item::minimize(None), &Item::maximize(None), &Item::separator(), &Item::close_window(None)],
        )?;
        let menu = Menu::new();
        menu.append_items(&[&app, &edit, &view, &window])?;
        Ok(menu)
    };
    build().unwrap_or_else(|e| fail(&format!("cannot create the menu bar: {e}")))
}
