//! Phase-4 live render proof (Linux): spawn the real engine, render its decoded
//! I420 frames in a gtk::GLArea (YUV→RGB) under a transparent HUD. You should see
//! the actual Xbox dashboard. Reuses examples/render_spike.rs's GTK/GL scaffolding.
//!
//! Sign in first (app or `cargo run --example wsl_login`), console powered on:
//!   XBOX_SERVER_ID=<id> cargo run --example render_live --features native-webrtc

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("render_live is Linux-only.");
}

#[cfg(target_os = "linux")]
fn main() -> wry::Result<()> {
    use std::sync::Arc;

    use gtk::prelude::*;
    use tao::event::{Event, WindowEvent};
    use tao::event_loop::{ControlFlow, EventLoop};
    use tao::platform::unix::WindowExtUnix;
    use tao::window::WindowBuilder;
    use wry::dpi::{LogicalPosition, LogicalSize};
    use wry::{Rect, WebViewBuilder, WebViewBuilderExtUnix};

    use kite::auth::XboxAuth;
    use kite::rtc::engine;
    use kite::rtc::media::frame_sink::SharedFrame;
    use kite::rtc::media::render_gtk::GtkGlRenderer;

    if std::env::var_os("GDK_BACKEND").is_none() {
        unsafe { std::env::set_var("GDK_BACKEND", "x11") };
    }
    if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
        unsafe { std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1") };
    }

    // ── Auth + engine, publishing frames into a SharedFrame ───────────────────
    let server_id = std::env::var("XBOX_SERVER_ID")
        .expect("set XBOX_SERVER_ID=<serverId> (the spike/wsl_login prints it)");
    let frames = SharedFrame::new();
    {
        let auth = XboxAuth::new();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let loaded = rt.block_on(auth.load_cached_tokens()).expect("load tokens");
        assert!(loaded, "sign in first (app or wsl_login)");
        // Keep the handle alive for the program's lifetime by leaking it.
        let handle =
            engine::spawn(auth, server_id, None, Some(Arc::clone(&frames))).expect("spawn engine");
        std::mem::forget(handle);
        std::mem::forget(rt);
    }

    // ── GTK window + Overlay { GLArea (video), transparent HUD } ──────────────
    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("Phase-4 live render — Xbox dashboard, native")
        .with_inner_size(LogicalSize::new(960.0, 540.0))
        .with_transparent(true)
        .build(&event_loop)
        .unwrap();

    let overlay = gtk::Overlay::new();
    window
        .default_vbox()
        .unwrap()
        .pack_start(&overlay, true, true, 0);
    let gl_area = gtk::GLArea::new();
    gl_area.set_has_alpha(true);
    gl_area.set_auto_render(true);

    // Attach the reusable GL renderer (realize + render closures).
    GtkGlRenderer::attach(&gl_area, Arc::clone(&frames));

    overlay.add(&gl_area);
    let fixed = gtk::Fixed::new();
    overlay.add_overlay(&fixed);
    overlay.show_all();

    let area_tick = gl_area.clone();
    gtk::glib::timeout_add_local(std::time::Duration::from_millis(16), move || {
        area_tick.queue_render();
        gtk::glib::ControlFlow::Continue
    });

    let hud = r#"<!doctype html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;height:100%;background:transparent;overflow:hidden;
            font-family:system-ui,sans-serif;color:#fff}
        .top{position:fixed;top:0;left:0;right:0;height:40px;display:flex;align-items:center;
            padding:0 14px;font-weight:600;
            background:linear-gradient(180deg,rgba(8,10,14,.7),rgba(8,10,14,0))}
        .dot{width:9px;height:9px;border-radius:50%;background:#37d67a;margin-right:8px;
            box-shadow:0 0 8px #37d67a}
        </style></head><body>
        <div class="top"><span class="dot"></span>native render — Xbox dashboard below this HUD</div>
        </body></html>"#;
    let (w, h): (u32, u32) = window.inner_size().into();
    let webview = WebViewBuilder::new()
        .with_transparent(true)
        .with_bounds(Rect {
            position: LogicalPosition::new(0, 0).into(),
            size: LogicalSize::new(w, h).into(),
        })
        .with_html(hud)
        .build_gtk(&fixed)?;

    println!("render_live: window up. You should see the Xbox dashboard. Close to quit.");
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent { event, .. } = event {
            match event {
                WindowEvent::Resized(size) => {
                    let _ = webview.set_bounds(Rect {
                        position: LogicalPosition::new(0, 0).into(),
                        size: LogicalSize::new(size.width, size.height).into(),
                    });
                }
                WindowEvent::CloseRequested => *control_flow = ControlFlow::Exit,
                _ => {}
            }
        }
    });
}
