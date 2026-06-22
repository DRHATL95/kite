//! GTK/GL I420→RGB renderer for Linux native-WebRTC builds.
//!
//! Provides [`GtkGlRenderer::attach`], which wires up a [`gtk::GLArea`]
//! to pull decoded I420 frames from a [`SharedFrame`] and render them via
//! a BT.709 YUV→RGB GLSL shader.
//!
//! **Threading:** The renderer state (`GlState`) is wrapped in
//! `Rc<RefCell<Option<GlState>>>` intentionally — it must only be touched
//! on the GTK main thread. The only cross-thread piece is the
//! `Arc<SharedFrame>` passed in, which is cloned into the render closure.
//!
//! **Failure handling:** GL setup never panics. If the driver rejects the
//! shader, fails context creation, or can't allocate textures, the error is
//! logged via `tracing` and `GlState` is left `None`; the render closure then
//! no-ops, so the transparent webview HUD (and the browser-path fallback)
//! keeps working instead of the whole process aborting from a GTK signal
//! handler.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use gtk::prelude::*;

use crate::rtc::media::FramePixels;
use crate::rtc::media::frame_sink::SharedFrame;

// Vertex shader: full-screen triangle, flipping Y (GL bottom-left vs image top-left).
const VS_SRC: &str = r#"#version 330 core
    out vec2 v_uv;
    void main() {
        vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
        v_uv = vec2(p.x, 1.0 - p.y); // flip Y: GL bottom-left vs image top-left
        gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
    }"#;

// Fragment shader: BT.709 limited-range YUV→RGB.
const FS_SRC: &str = r#"#version 330 core
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

struct GlState {
    gl: glow::Context,
    program: glow::Program,
    vao: glow::VertexArray,
    tex: [glow::Texture; 3], // Y, U, V planes
    u_planes: [Option<glow::UniformLocation>; 3],
    dims: Option<(u32, u32)>, // current texture dims; None until first frame
}

/// Wires a [`gtk::GLArea`] to render I420 frames from a [`SharedFrame`].
pub struct GtkGlRenderer;

impl GtkGlRenderer {
    /// Attach GL realize + render callbacks to `area`.
    ///
    /// After this call the `area` will:
    /// - On realize: compile the YUV→RGB shader + allocate 3 I420 textures.
    ///   On any GL failure it logs and disables rendering (no panic).
    /// - On render: pull the latest frame from `frames`, upload I420 planes,
    ///   and draw a full-screen triangle with BT.709 limited-range conversion.
    ///
    /// Must be called from the GTK main thread. Neither `GtkGlRenderer` nor
    /// the closures it registers implement `Send`.
    pub fn attach(area: &gtk::GLArea, frames: Arc<SharedFrame>) {
        let state: Rc<RefCell<Option<GlState>>> = Rc::new(RefCell::new(None));

        // ── realize: build GL program, VAO, textures ─────────────────────────
        let s_realize = state.clone();
        area.connect_realize(move |area| {
            area.make_current();
            if area.error().is_some() {
                tracing::error!("GtkGlRenderer: GLArea context error on realize; video disabled");
                return;
            }
            // SAFETY: `load_gl_proc` returns valid GL entry points (or null) for
            // the current, made-current GLArea context on the GTK main thread.
            let gl = unsafe { glow::Context::from_loader_function(load_gl_proc) };
            match build_gl_state(gl) {
                Ok(st) => *s_realize.borrow_mut() = Some(st),
                Err(e) => {
                    tracing::error!("GtkGlRenderer: GL init failed, video disabled: {e}");
                }
            }
        });

        // ── render: upload latest I420 frame, draw ────────────────────────────
        let s_render = state.clone();
        area.connect_render(move |_area, _ctx| {
            if let Some(st) = s_render.borrow_mut().as_mut() {
                // SAFETY: `st.gl` is the context built on this same GTK thread in
                // realize; all handles (program/vao/tex) belong to it and the
                // GLArea context is current during a render callback.
                unsafe {
                    use glow::HasContext as _;

                    // Upload a fresh frame if one is waiting.
                    if let Some(frame) = frames.take_latest() {
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
    }
}

// ── GL helpers ────────────────────────────────────────────────────────────────

/// Build the GL program, VAO, and I420 textures for a freshly-realized context.
///
/// Returns `Err` (never panics) on any allocation/compile/link failure so the
/// caller can log and disable rendering while keeping the rest of the UI alive.
fn build_gl_state(gl: glow::Context) -> Result<GlState, String> {
    use glow::HasContext as _;
    // SAFETY: called from `connect_realize` on the GTK main thread with the
    // GLArea context made current; every handle created here belongs to `gl`.
    unsafe {
        let vao = gl
            .create_vertex_array()
            .map_err(|e| format!("create VAO: {e}"))?;
        gl.bind_vertex_array(Some(vao));
        gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 1); // tight-packed planes

        let program = compile_program(&gl, VS_SRC, FS_SRC)?;

        let tex = [
            gl.create_texture().map_err(|e| format!("create Y tex: {e}"))?,
            gl.create_texture().map_err(|e| format!("create U tex: {e}"))?,
            gl.create_texture().map_err(|e| format!("create V tex: {e}"))?,
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
        Ok(GlState {
            gl,
            program,
            vao,
            tex,
            u_planes,
            dims: None,
        })
    }
}

/// Resolve a GL entry point by name.
///
/// `libGL.so.1`/`libEGL.so.1` are opened **once** for the process lifetime and
/// intentionally leaked into a `OnceLock`: glow calls this for every GL entry
/// point during realize, and the resolved function pointers must outlive any
/// `dlclose`. Returns null if neither library nor symbol is available.
fn load_gl_proc(s: &str) -> *const std::ffi::c_void {
    use std::sync::OnceLock;
    type GetProc = unsafe extern "C" fn(*const i8) -> *const std::ffi::c_void;

    // The proc-address fetchers exposed by whichever GL libraries are present,
    // tried in order (GLX first, then EGL) to mirror the per-symbol fallback.
    static GETTERS: OnceLock<Vec<GetProc>> = OnceLock::new();
    let getters = GETTERS.get_or_init(|| {
        let mut v: Vec<GetProc> = Vec::new();
        for (lib_name, sym) in [
            ("libGL.so.1", b"glXGetProcAddress\0".as_slice()),
            ("libEGL.so.1", b"eglGetProcAddress\0".as_slice()),
        ] {
            // SAFETY: loading a system GL library and reading its documented
            // proc-address symbol. The library is leaked (`forget`) so the
            // returned function pointer stays valid for the process lifetime.
            unsafe {
                if let Ok(lib) = libloading::Library::new(lib_name)
                    && let Ok(f) = lib.get::<GetProc>(sym)
                {
                    let f = *f; // copy the fn pointer out before leaking the lib
                    v.push(f);
                    std::mem::forget(lib);
                }
            }
        }
        v
    });

    let Ok(name) = std::ffi::CString::new(s) else {
        return std::ptr::null();
    };
    for getter in getters {
        // SAFETY: `getter` is a valid glXGetProcAddress/eglGetProcAddress from a
        // still-loaded GL library; `name` is a valid NUL-terminated C string.
        let ptr = unsafe { getter(name.as_ptr()) };
        if !ptr.is_null() {
            return ptr;
        }
    }
    std::ptr::null()
}

/// Compile + link the YUV→RGB program. Returns `Err` instead of panicking so a
/// driver that rejects the GLSL degrades gracefully (video off, HUD intact).
fn compile_program(
    gl: &glow::Context,
    vs_src: &str,
    fs_src: &str,
) -> Result<glow::Program, String> {
    use glow::HasContext as _;
    // SAFETY: called from `build_gl_state` on the GTK main thread with a current
    // GL context; all GL objects created here belong to `gl`.
    unsafe {
        let program = gl
            .create_program()
            .map_err(|e| format!("create program: {e}"))?;
        let mut shaders = Vec::new();
        for (kind, src) in [
            (glow::VERTEX_SHADER, vs_src),
            (glow::FRAGMENT_SHADER, fs_src),
        ] {
            let sh = gl
                .create_shader(kind)
                .map_err(|e| format!("create shader: {e}"))?;
            gl.shader_source(sh, src);
            gl.compile_shader(sh);
            if !gl.get_shader_compile_status(sh) {
                let log = gl.get_shader_info_log(sh);
                gl.delete_shader(sh);
                gl.delete_program(program);
                return Err(format!("shader compile error: {log}"));
            }
            gl.attach_shader(program, sh);
            shaders.push(sh);
        }
        gl.link_program(program);
        if !gl.get_program_link_status(program) {
            let log = gl.get_program_info_log(program);
            for sh in shaders {
                gl.delete_shader(sh);
            }
            gl.delete_program(program);
            return Err(format!("program link error: {log}"));
        }
        for sh in shaders {
            gl.detach_shader(program, sh);
            gl.delete_shader(sh);
        }
        Ok(program)
    }
}
