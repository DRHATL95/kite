//! Phase-4 render de-risk spike (THROWAWAY — Linux only).
//!
//! Proves the make-or-break unknown for the native video render: can we composite
//! a native GPU video layer UNDERNEATH the transparent WebKitGTK webview (the HUD)
//! **flicker-free** on Linux?
//!
//! Approach (wry's own `gtk_opengl` pattern — composites inside GTK, so there is
//! no "airspace"/raw-handle flicker, unlike raw-wgpu, tauri#9220):
//!   tao window → its GTK vbox → `gtk::Overlay` {
//!       base:    `gtk::GLArea` (alpha) — renders the video layer (here, an
//!                animated gradient + moving bars so any flicker/tearing is obvious)
//!       overlay: `gtk::Fixed` hosting a **transparent** webview (the Svelte-style
//!                HUD: a top status bar + a bottom control bar, middle see-through)
//!   }
//!
//! Run on the Linux box (with a display):
//!   cargo run --example render_spike
//! Watch the window: the animated pattern must show cleanly THROUGH the transparent
//! middle and AROUND the HUD bars, with no flicker/tearing/black-flashing. Auto-
//! closes after 40s; close the window early to quit.

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("render_spike is Linux-only (GTK GLArea + WebKitGTK).");
}

#[cfg(target_os = "linux")]
fn main() -> wry::Result<()> {
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::time::Instant;

    use gtk::prelude::*;
    use tao::event::{Event, WindowEvent};
    use tao::event_loop::{ControlFlow, EventLoop};
    use tao::platform::unix::WindowExtUnix;
    use tao::window::WindowBuilder;
    use wry::dpi::{LogicalPosition, LogicalSize};
    use wry::{Rect, WebViewBuilder, WebViewBuilderExtUnix};

    // Force X11 + disable WebKit compositing (same as the app on Linux/Wayland).
    if std::env::var_os("GDK_BACKEND").is_none() {
        unsafe { std::env::set_var("GDK_BACKEND", "x11") };
    }
    if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
        unsafe { std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1") };
    }

    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("Phase-4 render spike — native video under transparent HUD")
        .with_inner_size(LogicalSize::new(960.0, 600.0))
        .with_transparent(true)
        .build(&event_loop)
        .unwrap();

    // ── GTK compositing tree: Overlay { GLArea (video), Fixed (HUD webview) } ──
    let overlay = gtk::Overlay::new();
    let vbox = window.default_vbox().unwrap();
    vbox.pack_start(&overlay, true, true, 0);

    let gl_area = gtk::GLArea::new();
    gl_area.set_has_alpha(true);
    gl_area.set_auto_render(true);

    struct GlState {
        gl: glow::Context,
        program: glow::Program,
        vao: glow::VertexArray,
        u_time: Option<glow::UniformLocation>,
        u_res: Option<glow::UniformLocation>,
        start: Instant,
    }

    let state: Rc<RefCell<Option<GlState>>> = Rc::new(RefCell::new(None));

    let state_realize = state.clone();
    gl_area.connect_realize(move |area| {
        area.make_current();
        if area.error().is_some() {
            eprintln!("GLArea context error");
            return;
        }
        let gl = unsafe { glow::Context::from_loader_function(load_gl_proc) };
        unsafe {
            use glow::HasContext as _;
            let vao = gl.create_vertex_array().unwrap();
            gl.bind_vertex_array(Some(vao));

            // Fullscreen triangle (no vertex buffer) → animated gradient fragment.
            let vs_src = r#"#version 330 core
                void main() {
                    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
                    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
                }"#;
            let fs_src = r#"#version 330 core
                out vec4 FragColor;
                uniform float u_time;
                uniform vec2  u_res;
                void main() {
                    vec2 uv = gl_FragCoord.xy / u_res;
                    // animated colour field
                    vec3 col = 0.5 + 0.5 * cos(u_time + uv.xyx * 6.2831 + vec3(0.0, 2.0, 4.0));
                    // moving diagonal bars: tearing/flicker is obvious against these
                    float bars = step(0.5, fract((uv.x + uv.y) * 12.0 - u_time));
                    col = mix(col, vec3(1.0), bars * 0.18);
                    FragColor = vec4(col, 1.0); // opaque video layer
                }"#;
            let program = compile_program(&gl, vs_src, fs_src);
            let u_time = gl.get_uniform_location(program, "u_time");
            let u_res = gl.get_uniform_location(program, "u_res");
            *state_realize.borrow_mut() = Some(GlState {
                gl,
                program,
                vao,
                u_time,
                u_res,
                start: Instant::now(),
            });
        }
    });

    let state_render = state.clone();
    gl_area.connect_render(move |area, _ctx| {
        if let Some(st) = state_render.borrow().as_ref() {
            let scale = area.scale_factor() as f32;
            let w = area.allocated_width() as f32 * scale;
            let h = area.allocated_height() as f32 * scale;
            let t = st.start.elapsed().as_secs_f32();
            unsafe {
                use glow::HasContext as _;
                st.gl.viewport(0, 0, w as i32, h as i32);
                st.gl.clear_color(0.0, 0.0, 0.0, 1.0);
                st.gl.clear(glow::COLOR_BUFFER_BIT);
                st.gl.use_program(Some(st.program));
                st.gl.bind_vertex_array(Some(st.vao));
                st.gl.uniform_1_f32(st.u_time.as_ref(), t);
                st.gl.uniform_2_f32(st.u_res.as_ref(), w.max(1.0), h.max(1.0));
                st.gl.draw_arrays(glow::TRIANGLES, 0, 3);
            }
        }
        gtk::glib::Propagation::Proceed
    });

    let state_unrealize = state.clone();
    gl_area.connect_unrealize(move |area| {
        area.make_current();
        if let Some(st) = state_unrealize.borrow_mut().take() {
            unsafe {
                use glow::HasContext as _;
                st.gl.delete_program(st.program);
                st.gl.delete_vertex_array(st.vao);
            }
        }
    });

    overlay.add(&gl_area);
    let fixed = gtk::Fixed::new();
    overlay.add_overlay(&fixed);
    overlay.show_all();

    // Drive ~60fps animation so flicker is observable.
    let area_for_tick = gl_area.clone();
    gtk::glib::timeout_add_local(std::time::Duration::from_millis(16), move || {
        area_for_tick.queue_render();
        gtk::glib::ControlFlow::Continue
    });

    // ── The transparent HUD webview (top status + bottom control bar) ──────────
    let hud = r#"<!doctype html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;height:100%;background:transparent;overflow:hidden;
            font-family:system-ui,sans-serif;color:#fff;
            -webkit-user-select:none;user-select:none}
        .top{position:fixed;top:0;left:0;right:0;height:44px;display:flex;
            align-items:center;padding:0 16px;
            background:linear-gradient(180deg,rgba(10,12,16,.78),rgba(10,12,16,0));
            font-weight:600;letter-spacing:.02em}
        .dot{width:9px;height:9px;border-radius:50%;background:#37d67a;margin-right:9px;
            box-shadow:0 0 8px #37d67a}
        .bar{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);
            display:flex;gap:10px;padding:10px 14px;border-radius:14px;
            background:rgba(18,20,26,.62);backdrop-filter:blur(8px);
            box-shadow:0 6px 24px rgba(0,0,0,.45)}
        .btn{width:42px;height:42px;border-radius:10px;border:1px solid rgba(255,255,255,.14);
            background:rgba(255,255,255,.08);display:grid;place-items:center;font-size:18px}
        .hint{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
            text-align:center;opacity:.85;text-shadow:0 1px 6px rgba(0,0,0,.6)}
        </style></head><body>
        <div class="top"><span class="dot"></span>HUD (transparent webview) — native GL video composites BELOW</div>
        <div class="hint">the animated pattern should show cleanly through here<br>with no flicker / tearing / black flashing</div>
        <div class="bar"><div class="btn">⏯</div><div class="btn">🔊</div><div class="btn">⛶</div><div class="btn">✂</div></div>
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

    println!("render_spike: window up — watch for flicker-free compositing. Auto-closes in 40s.");
    let started = Instant::now();

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::WaitUntil(
            std::time::Instant::now() + std::time::Duration::from_millis(250),
        );

        if started.elapsed().as_secs() >= 40 {
            *control_flow = ControlFlow::Exit;
            return;
        }

        match event {
            Event::WindowEvent {
                event: WindowEvent::Resized(size),
                ..
            } => {
                let _ = webview.set_bounds(Rect {
                    position: LogicalPosition::new(0, 0).into(),
                    size: LogicalSize::new(size.width, size.height).into(),
                });
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => *control_flow = ControlFlow::Exit,
            _ => {}
        }
    });
}

/// Load a GL proc address via GLX then EGL (mirrors wry's gtk_opengl example).
#[cfg(target_os = "linux")]
fn load_gl_proc(s: &str) -> *const std::ffi::c_void {
    let name = std::ffi::CString::new(s).unwrap();
    unsafe {
        for (lib_name, sym) in [
            ("libGL.so.1", b"glXGetProcAddress\0".as_slice()),
            ("libEGL.so.1", b"eglGetProcAddress\0".as_slice()),
        ] {
            if let Ok(lib) = libloading::Library::new(lib_name)
                && let Ok(f) =
                    lib.get::<unsafe extern "C" fn(*const i8) -> *const std::ffi::c_void>(sym)
            {
                let ptr = f(name.as_ptr());
                if !ptr.is_null() {
                    return ptr;
                }
            }
        }
    }
    std::ptr::null()
}

#[cfg(target_os = "linux")]
fn compile_program(gl: &glow::Context, vs_src: &str, fs_src: &str) -> glow::Program {
    use glow::HasContext as _;
    unsafe {
        let program = gl.create_program().expect("create program");
        let shaders = [(glow::VERTEX_SHADER, vs_src), (glow::FRAGMENT_SHADER, fs_src)];
        let mut compiled = Vec::new();
        for (kind, src) in shaders {
            let sh = gl.create_shader(kind).expect("create shader");
            gl.shader_source(sh, src);
            gl.compile_shader(sh);
            if !gl.get_shader_compile_status(sh) {
                panic!("shader compile error: {}", gl.get_shader_info_log(sh));
            }
            gl.attach_shader(program, sh);
            compiled.push(sh);
        }
        gl.link_program(program);
        if !gl.get_program_link_status(program) {
            panic!("program link error: {}", gl.get_program_info_log(program));
        }
        for sh in compiled {
            gl.detach_shader(program, sh);
            gl.delete_shader(sh);
        }
        program
    }
}
