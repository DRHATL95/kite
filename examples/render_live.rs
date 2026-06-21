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
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::Arc;

    use gtk::prelude::*;
    use tao::event::{Event, WindowEvent};
    use tao::event_loop::{ControlFlow, EventLoop};
    use tao::platform::unix::WindowExtUnix;
    use tao::window::WindowBuilder;
    use wry::dpi::{LogicalPosition, LogicalSize};
    use wry::{Rect, WebViewBuilder, WebViewBuilderExtUnix};

    use xbox_remote::auth::XboxAuth;
    use xbox_remote::rtc::engine;
    use xbox_remote::rtc::media::FramePixels;
    use xbox_remote::rtc::media::frame_sink::SharedFrame;

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
            engine::spawn(auth, server_id, Some(Arc::clone(&frames))).expect("spawn engine");
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

    struct GlState {
        gl: glow::Context,
        program: glow::Program,
        vao: glow::VertexArray,
        tex: [glow::Texture; 3], // Y, U, V
        u_planes: [Option<glow::UniformLocation>; 3],
        dims: Option<(u32, u32)>, // current texture dims, to know when to re-alloc
    }
    let state: Rc<RefCell<Option<GlState>>> = Rc::new(RefCell::new(None));
    let frames_render = Arc::clone(&frames);

    let s_realize = state.clone();
    gl_area.connect_realize(move |area| {
        area.make_current();
        if area.error().is_some() {
            eprintln!("GLArea context error");
            return;
        }
        let gl = unsafe { glow::Context::from_loader_function(|s| load_gl_proc(s)) };
        unsafe {
            use glow::HasContext as _;
            let vao = gl.create_vertex_array().unwrap();
            gl.bind_vertex_array(Some(vao));
            gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 1); // tight-packed planes
            let vs = r#"#version 330 core
                out vec2 v_uv;
                void main() {
                    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
                    v_uv = vec2(p.x, 1.0 - p.y); // flip Y: GL bottom-left vs image top-left
                    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
                }"#;
            // BT.709 limited-range YUV→RGB.
            let fs = r#"#version 330 core
                in vec2 v_uv;
                out vec4 FragColor;
                uniform sampler2D y_tex;
                uniform sampler2D u_tex;
                uniform sampler2D v_tex;
                void main() {
                    float y = texture(y_tex, v_uv).r;
                    float u = texture(u_tex, v_uv).r;
                    float v = texture(v_tex, v_uv).r;
                    y = (y - 0.0627) * 1.1644;          // (Y-16/255)*255/219
                    u = u - 0.5;
                    v = v - 0.5;
                    float r = y + 1.7927 * v;
                    float g = y - 0.2132 * u - 0.5329 * v;
                    float b = y + 2.1124 * u;
                    FragColor = vec4(clamp(vec3(r, g, b), 0.0, 1.0), 1.0);
                }"#;
            let program = compile_program(&gl, vs, fs);
            let tex = [
                gl.create_texture().unwrap(),
                gl.create_texture().unwrap(),
                gl.create_texture().unwrap(),
            ];
            for (i, t) in tex.iter().enumerate() {
                gl.active_texture(glow::TEXTURE0 + i as u32);
                gl.bind_texture(glow::TEXTURE_2D, Some(*t));
                gl.tex_parameter_i32(
                    glow::TEXTURE_2D,
                    glow::TEXTURE_MIN_FILTER,
                    glow::LINEAR as i32,
                );
                gl.tex_parameter_i32(
                    glow::TEXTURE_2D,
                    glow::TEXTURE_MAG_FILTER,
                    glow::LINEAR as i32,
                );
                gl.tex_parameter_i32(
                    glow::TEXTURE_2D,
                    glow::TEXTURE_WRAP_S,
                    glow::CLAMP_TO_EDGE as i32,
                );
                gl.tex_parameter_i32(
                    glow::TEXTURE_2D,
                    glow::TEXTURE_WRAP_T,
                    glow::CLAMP_TO_EDGE as i32,
                );
            }
            let u_planes = [
                gl.get_uniform_location(program, "y_tex"),
                gl.get_uniform_location(program, "u_tex"),
                gl.get_uniform_location(program, "v_tex"),
            ];
            *s_realize.borrow_mut() = Some(GlState {
                gl,
                program,
                vao,
                tex,
                u_planes,
                dims: None,
            });
        }
    });

    let s_render = state.clone();
    gl_area.connect_render(move |_area, _ctx| {
        if let Some(st) = s_render.borrow_mut().as_mut() {
            unsafe {
                use glow::HasContext as _;
                // Upload a fresh frame if one is waiting.
                if let Some(frame) = frames_render.take_latest() {
                    let FramePixels::Cpu { planes, .. } = &frame.pixels;
                    let (w, h) = (frame.width, frame.height);
                    let realloc = st.dims != Some((w, h));
                    st.dims = Some((w, h));
                    let sizes = [(w, h), (w / 2, h / 2), (w / 2, h / 2)];
                    for i in 0..3 {
                        st.gl.active_texture(glow::TEXTURE0 + i as u32);
                        st.gl.bind_texture(glow::TEXTURE_2D, Some(st.tex[i]));
                        let (pw, ph) = sizes[i];
                        if realloc {
                            st.gl.tex_image_2d(
                                glow::TEXTURE_2D,
                                0,
                                glow::R8 as i32,
                                pw as i32,
                                ph as i32,
                                0,
                                glow::RED,
                                glow::UNSIGNED_BYTE,
                                Some(&planes[i]),
                            );
                        } else {
                            st.gl.tex_sub_image_2d(
                                glow::TEXTURE_2D,
                                0,
                                0,
                                0,
                                pw as i32,
                                ph as i32,
                                glow::RED,
                                glow::UNSIGNED_BYTE,
                                glow::PixelUnpackData::Slice(&planes[i]),
                            );
                        }
                    }
                }
                st.gl.clear_color(0.0, 0.0, 0.0, 1.0);
                st.gl.clear(glow::COLOR_BUFFER_BIT);
                if st.dims.is_some() {
                    st.gl.use_program(Some(st.program));
                    st.gl.bind_vertex_array(Some(st.vao));
                    for i in 0..3 {
                        st.gl.uniform_1_i32(st.u_planes[i].as_ref(), i as i32);
                    }
                    st.gl.draw_arrays(glow::TRIANGLES, 0, 3);
                }
            }
        }
        gtk::glib::Propagation::Proceed
    });

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

// ── GL helpers (identical to examples/render_spike.rs) ────────────────────────
#[cfg(target_os = "linux")]
fn load_gl_proc(s: &str) -> *const std::ffi::c_void {
    let name = std::ffi::CString::new(s).unwrap();
    unsafe {
        for (lib_name, sym) in [
            ("libGL.so.1", b"glXGetProcAddress\0".as_slice()),
            ("libEGL.so.1", b"eglGetProcAddress\0".as_slice()),
        ] {
            if let Ok(lib) = libloading::Library::new(lib_name) {
                if let Ok(f) =
                    lib.get::<unsafe extern "C" fn(*const i8) -> *const std::ffi::c_void>(sym)
                {
                    let ptr = f(name.as_ptr());
                    if !ptr.is_null() {
                        return ptr;
                    }
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
        let mut shaders = Vec::new();
        for (kind, src) in [
            (glow::VERTEX_SHADER, vs_src),
            (glow::FRAGMENT_SHADER, fs_src),
        ] {
            let sh = gl.create_shader(kind).expect("create shader");
            gl.shader_source(sh, src);
            gl.compile_shader(sh);
            if !gl.get_shader_compile_status(sh) {
                panic!("shader compile error: {}", gl.get_shader_info_log(sh));
            }
            gl.attach_shader(program, sh);
            shaders.push(sh);
        }
        gl.link_program(program);
        if !gl.get_program_link_status(program) {
            panic!("program link error: {}", gl.get_program_info_log(program));
        }
        for sh in shaders {
            gl.detach_shader(program, sh);
            gl.delete_shader(sh);
        }
        program
    }
}
