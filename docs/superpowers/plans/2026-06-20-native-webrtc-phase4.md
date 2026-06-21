# Native WebRTC Phase 4 — Linux Video Render — Implementation Plan

> **STATUS: NOT STARTED (authored 2026-06-20).** Make-or-break compositing already
> de-risked (`examples/render_spike.rs`, commit `07ce379`): GTK `GLArea` under a
> transparent WebKitGTK HUD composites flicker-free. This plan builds the real
> renderer on that proven primitive.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the engine's decoded **I420 video frames** to screen on Linux — uploaded as GL textures and YUV→RGB-converted in a `gtk::GLArea`, composited under a transparent HUD — so a live session shows the **actual Xbox dashboard** rendered natively (the thing you can currently only *hear*).

**Architecture:** A thread-safe **`SharedFrame`** slot is the render seam: the engine's decode thread `put`s the latest `DecodedFrame`; the GTK main thread's `GLArea` render callback `take_latest`s it, uploads the 3 I420 planes to 3 single-channel GL textures, and draws a fullscreen quad with a BT.709 YUV→RGB fragment shader. The de-risked `GtkOverlay { GLArea base, transparent webview overlay }` pattern hosts it. Phase 4 proves this end-to-end in a **standalone `examples/render_live.rs`** window (engine → decode → `SharedFrame` → `GLArea`); wiring the renderer into the *real Tauri app window* (reparenting, window transparency, replacing the Stream `<video>`, the runtime flag) is **Phase 6**.

**Tech Stack:** `gtk::GLArea` + `glow` (lightweight GL, proven in the spike), `tao` (Tauri's windowing), `wry` (the transparent HUD webview), the Phase-2/3 engine (`RtcEngine::spawn`) + `FfmpegDecoder` (already emits tight-packed I420). All `glow`/`gtk`/`tao`/`wry` are already dev-deps from the spike. The pure `SharedFrame` is in the lib (`cargo test`-able); the GL renderer lives in the example for this phase (Phase 6 promotes it into the lib).

**Spec / source of truth:** Master plan `docs/superpowers/plans/2026-06-19-native-rust-webrtc.md` §Phase 4 + its STATUS (the GLArea decision + de-risk result); the proven `examples/render_spike.rs`; the Phase-3 `FfmpegDecoder` (I420 planes, tight strides `[w, w/2, w/2]`).

**Branch:** `feat/native-webrtc-linux` (continue).

---

## Decisions (locked for this phase)

1. **GTK `GLArea` + `glow`, NOT raw wgpu** (de-risked — composites inside GTK, no #9220 flicker). wgpu is kept for Phase-7 cross-platform unify.
2. **`SharedFrame` (latest-wins) is the cross-thread render seam.** The engine decodes on its thread and `put`s frames; the GL upload happens on the GTK main thread (GL contexts are thread-affine). Latest-wins (drop stale frames) favors latency over completeness — correct for live video.
3. **Standalone-window proof this phase; real-Tauri-window integration is Phase 6.** Like the spike, `examples/render_live.rs` uses its own `tao` window — no Tauri internals. This isolates "does the renderer work with live frames" from "reparent into Tauri's window."
4. **Software-decoded I420 frames** (from Phase-3 `FfmpegDecoder`). HW VA-API → GL-texture zero-copy (EGLImage/dmabuf) stays deferred — it's an optimization on top of this working software render.
5. **The GL renderer code lives in the example for now.** The reusable pure piece (`SharedFrame`) goes in the lib. Phase 6 lifts the renderer struct into the lib (behind a render feature) when wiring into Tauri. Avoids adding `gtk`/`glow` as *runtime* lib deps prematurely.
6. **Retire the placeholder `VideoRenderer` trait** in `media/mod.rs` in favor of `SharedFrame` — the cross-thread reality (engine thread ≠ GL thread) means a direct `present(&frame)` trait call from the engine can't touch GL. `SharedFrame` is the honest seam. (Leave `VideoDecoder`/`AudioDecoder` untouched.)

---

## File Structure

```
src/rtc/media/
  frame_sink.rs   CREATE  — SharedFrame: thread-safe latest-frame slot. PURE, TDD.
  mod.rs          MODIFY  — `pub mod frame_sink;`; remove the unused `VideoRenderer`
                            trait (superseded by SharedFrame; see Decision 6).
src/rtc/engine.rs MODIFY  — `spawn`/`stream`/`handle_event` accept an optional
                            `Arc<SharedFrame>`; the decoded frame is `put` to it
                            (instead of decoded-and-dropped).
tests/rtc_e2e.rs  MODIFY  — pass `None` for the new spawn arg (signature change).
examples/
  render_live.rs  CREATE  — the live proof: GLArea I420→YUV→RGB renderer reading
                            SharedFrame, fed by a live engine, under a transparent HUD.
```

> One shippable slice: a standalone window that shows the real Xbox dashboard, rendered by our GL pipeline, under a transparent HUD. The cross-thread seam (`SharedFrame`) is unit-tested; the GL render + color is proven live (by your eyes).

---

## Task 4.1: `SharedFrame` — cross-thread latest-frame slot (TDD)

**Files:**
- Create: `src/rtc/media/frame_sink.rs`
- Modify: `src/rtc/media/mod.rs`
- Test: inline `#[cfg(test)] mod tests` (runs in the **default** build — pure)

- [ ] **Step 1: Add the module.** In `src/rtc/media/mod.rs`, add near the top (ungated — it's pure):

```rust
pub mod frame_sink;
```

- [ ] **Step 2: Write the failing test** (`frame_sink.rs`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::rtc::media::{DecodedFrame, FramePixels, PixelFormat};

    fn frame(tag: u8) -> DecodedFrame {
        DecodedFrame {
            width: 2,
            height: 2,
            pts_micros: tag as u64,
            pixels: FramePixels::Cpu {
                format: PixelFormat::I420,
                planes: vec![vec![tag; 4], vec![tag; 1], vec![tag; 1]],
                strides: vec![2, 1, 1],
            },
        }
    }

    #[test]
    fn take_latest_is_none_when_empty() {
        let sink = SharedFrame::new();
        assert!(sink.take_latest().is_none());
    }

    #[test]
    fn put_then_take_returns_the_frame_once() {
        let sink = SharedFrame::new();
        sink.put(frame(7));
        let got = sink.take_latest().expect("a frame");
        assert_eq!(got.pts_micros, 7);
        assert!(sink.take_latest().is_none(), "consumed — slot now empty");
    }

    #[test]
    fn put_replaces_an_unconsumed_frame_latest_wins() {
        let sink = SharedFrame::new();
        sink.put(frame(1));
        sink.put(frame(2)); // 1 was never taken → dropped
        assert_eq!(sink.take_latest().unwrap().pts_micros, 2);
        assert!(sink.take_latest().is_none());
    }

    #[test]
    fn shared_across_threads() {
        use std::sync::Arc;
        let sink = SharedFrame::new();
        let w = Arc::clone(&sink);
        std::thread::spawn(move || w.put(frame(9))).join().unwrap();
        assert_eq!(sink.take_latest().unwrap().pts_micros, 9);
    }
}
```

- [ ] **Step 3: Run, verify it fails.** Run: `cargo test rtc::media::frame_sink` → FAIL (`SharedFrame` undefined).

- [ ] **Step 4: Implement** `src/rtc/media/frame_sink.rs`:

```rust
//! `SharedFrame`: the cross-thread render seam. The engine's decode thread `put`s
//! the latest decoded frame; the GTK GL thread `take_latest`s it for upload.
//! Latest-wins (an unconsumed frame is dropped on the next `put`) — for live
//! video we want the freshest frame, not a backlog.

use std::sync::{Arc, Mutex};

use crate::rtc::media::DecodedFrame;

#[derive(Default)]
pub struct SharedFrame {
    slot: Mutex<Option<DecodedFrame>>,
}

impl SharedFrame {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { slot: Mutex::new(None) })
    }

    /// Store the latest frame, dropping any previous unconsumed one.
    pub fn put(&self, frame: DecodedFrame) {
        *self.slot.lock().unwrap() = Some(frame);
    }

    /// Take the latest frame if present, clearing the slot.
    pub fn take_latest(&self) -> Option<DecodedFrame> {
        self.slot.lock().unwrap().take()
    }
}
```

- [ ] **Step 5: Remove the dead `VideoRenderer` trait** (Decision 6). In `src/rtc/media/mod.rs`, delete the `pub trait VideoRenderer { … }` block and its doc comment. Confirm nothing references it: `grep -rn VideoRenderer src/ tests/ examples/` should return only the (now-removed) definition — if anything else references it, that's a real use; stop and reconcile instead.

- [ ] **Step 6: Run, verify pass + nothing broke.** Run: `cargo test` → prior 106 + 4 new = **110**.

- [ ] **Step 7: Commit.**

```bash
git add src/rtc/media/frame_sink.rs src/rtc/media/mod.rs
git commit -m "feat(rtc): SharedFrame cross-thread render seam (TDD); retire placeholder VideoRenderer"
```

---

## Task 4.2: Publish decoded frames from the engine

**Files:**
- Modify: `src/rtc/engine.rs`
- Modify: `tests/rtc_e2e.rs` (spawn signature change → pass `None`)

The engine currently decodes video and drops the frame. Give it an optional
`Arc<SharedFrame>` and `put` each decoded frame instead.

- [ ] **Step 1: Thread the sink into `spawn` + `drive` + `connect_and_stream` + `stream` + the `MediaPipeline`.**
  - Add `use std::sync::Arc;` and `use crate::rtc::media::frame_sink::SharedFrame;` at the top of `engine.rs`.
  - Change `pub fn spawn(auth, server_id) -> Result<RtcHandle>` to
    `pub fn spawn(auth: crate::auth::XboxAuth, server_id: String, frame_sink: Option<Arc<SharedFrame>>) -> Result<RtcHandle>` and pass `frame_sink` into the spawned task → `drive(auth, server_id, cmd_rx, event_tx.clone(), frame_sink)`.
  - Add `frame_sink: Option<Arc<SharedFrame>>` as the last param of `drive`, `connect_and_stream`, and `stream`, threading it through. (`drive` clones it per reconnect: `connect_and_stream(…, frame_sink.clone())`.)
  - Add a field to `MediaPipeline`: `frame_sink: Option<Arc<SharedFrame>>`, set in `MediaPipeline::new(video_mid, audio_mid, frame_sink)`. Update the `MediaPipeline::new(video_mid, audio_mid)` call in `stream` to pass the sink.

- [ ] **Step 2: Publish the frame** in `handle_event`'s `MediaData` video branch — change the decode loop body from dropping `_frame` to publishing it:

```rust
if dec.feed(au).is_ok() {
    while let Some(frame) = dec.poll() {
        *frames += 1;
        if !*first_frame {
            *first_frame = true;
            let _ = event_tx.send(RtcEvent::FirstFrame);
        }
        if let Some(sink) = &media.frame_sink {
            sink.put(frame); // hand off to the GL thread; latest-wins
        }
    }
}
```

(`media.frame_sink` is the `MediaPipeline` field. The `frame` moves into `put`; when no sink is set, it's dropped as before.)

- [ ] **Step 3: Update the E2E test** (`tests/rtc_e2e.rs`) — the `spawn` call now needs the third arg:

```rust
    let mut handle = engine::spawn(auth, server_id, None).expect("spawn engine");
```

- [ ] **Step 4: Verify.**
  Run: `cargo build --features native-webrtc` → compiles.
  Run: `cargo test` → still **110** (engine gated out; SharedFrame tests run).
  Run: `cargo test --features native-webrtc --test rtc_e2e` → compiles + skips (no `XBOX_E2E`).

- [ ] **Step 5: Commit.**

```bash
git add src/rtc/engine.rs tests/rtc_e2e.rs
git commit -m "feat(rtc): engine publishes decoded frames to an optional SharedFrame"
```

---

## Task 4.3: `examples/render_live.rs` — live GL render of the Xbox dashboard

**Files:**
- Create: `examples/render_live.rs`
- Modify: `Cargo.toml` (add the `[[example]]` entry)

Evolve `render_spike.rs`: same `GtkOverlay { GLArea, transparent HUD }`, but the
`GLArea` now uploads I420 frames from a `SharedFrame` (fed by a live engine) and
YUV→RGB-converts them. This is the Phase-4 acceptance — **you see the real
dashboard**. It's an integration/live proof (no unit test); correctness is by eye.

- [ ] **Step 1: Add the example** to `Cargo.toml` (after the `render_spike` entry). It needs the native stack (engine) + the GL/GUI dev-deps (already present):

```toml
[[example]]
name = "render_live"
required-features = ["native-webrtc"]
```

- [ ] **Step 2: Write `examples/render_live.rs`.** (Full file — adapts `render_spike.rs`; the GL setup/`load_gl_proc`/`compile_program` helpers are the same, the fragment shader is the YUV→RGB one, and the render callback uploads from `SharedFrame`.)

```rust
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
        let handle = engine::spawn(auth, server_id, Some(Arc::clone(&frames)))
            .expect("spawn engine");
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
    window.default_vbox().unwrap().pack_start(&overlay, true, true, 0);
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
                gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MIN_FILTER, glow::LINEAR as i32);
                gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MAG_FILTER, glow::LINEAR as i32);
                gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_WRAP_S, glow::CLAMP_TO_EDGE as i32);
                gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_WRAP_T, glow::CLAMP_TO_EDGE as i32);
            }
            let u_planes = [
                gl.get_uniform_location(program, "y_tex"),
                gl.get_uniform_location(program, "u_tex"),
                gl.get_uniform_location(program, "v_tex"),
            ];
            *s_realize.borrow_mut() = Some(GlState { gl, program, vao, tex, u_planes, dims: None });
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
                            st.gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::R8 as i32,
                                pw as i32, ph as i32, 0, glow::RED, glow::UNSIGNED_BYTE,
                                Some(&planes[i]));
                        } else {
                            st.gl.tex_sub_image_2d(glow::TEXTURE_2D, 0, 0, 0,
                                pw as i32, ph as i32, glow::RED, glow::UNSIGNED_BYTE,
                                glow::PixelUnpackData::Slice(&planes[i]));
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
        for (kind, src) in [(glow::VERTEX_SHADER, vs_src), (glow::FRAGMENT_SHADER, fs_src)] {
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
```

- [ ] **Step 3: Build it.** Run: `cargo build --example render_live --features native-webrtc` → compiles. Fix any glow API arg mismatches (`tex_image_2d`/`tex_sub_image_2d`/`PixelUnpackData` signatures in glow 0.13) guided by the compiler; the `render_spike` helpers already compiled, so only the texture-upload calls are new.

- [ ] **Step 4: Run it live (interactive — needs console + sign-in).** **Pause and ask the human to power on the console (Restart it first if it's wedged — see the master plan's `WaitingForServerToRegister` gotcha) before this step.**

Run: `XBOX_SERVER_ID=<id> cargo run --example render_live --features native-webrtc`
Expected: a window showing the **live Xbox dashboard**, correct colors, under the HUD bar. If colors look washed/oversaturated, the YUV matrix range is the suspect (try full-range: drop the `(y-0.0627)*1.1644` to `y` and `1.5748/0.1873/0.4681/1.8556` coefficients) — adjust by eye.

- [ ] **Step 5: Commit.**

```bash
git add examples/render_live.rs Cargo.toml
git commit -m "feat(rtc): render_live — GL I420→YUV→RGB render of the live Xbox dashboard under a HUD"
```

---

## Phase 4 Acceptance

- `cargo test` (no features): **110** (prior 106 + 4 `SharedFrame`).
- `cargo build --features native-webrtc`: engine (with the sink) + `render_live` compile.
- **Live:** `render_live` shows the real Xbox dashboard, rendered by our GL pipeline, with correct colors, under the transparent HUD. (Compositing flicker-free — already de-risked.)

On green, the master-plan STATUS updates (Phase 4 ✅) and the next slice is **Phase 6 — integrate into the real Tauri app**: reparent the `GtkOverlay`/`GLArea` into Tauri's window, make the app window/webview transparent, replace the Stream `<video>` with a transparent region, wire `RtcEngine::spawn(..., Some(sink))` behind the runtime flag, and promote the `render_live` renderer into the lib. (Phase 5 — stats/keepalive/clip — and the deferred HW VA-API→GL zero-copy also slot in around there.)

---

## Self-Review

- **Spec coverage (master §Phase 4):** `VideoRenderer`-presenting-frames ✅ (the GLArea renderer in 4.3); under the transparent HUD ✅ (de-risked + reused here); fed by the engine's decoded frames ✅ (4.1 `SharedFrame` + 4.2 engine publish). **Deferred with rationale:** real-Tauri-window integration + transparency + Stream-UI → Phase 6 (Decision 3); HW VA-API→GL zero-copy → later (Decision 4).
- **Placeholder scan:** none — every code step is concrete. Two compiler-guided spots are flagged with fallbacks, not vagueness: the glow 0.13 `tex_(sub_)image_2d`/`PixelUnpackData` signatures (Step 4.3.3) and the YUV range/matrix tuning by eye (Step 4.3.4).
- **Type consistency:** `SharedFrame::{new,put,take_latest}` defined in 4.1, used in 4.2 (`media.frame_sink`) + 4.3 (`frames.take_latest()`); `engine::spawn(auth, server_id, Option<Arc<SharedFrame>>)` defined in 4.2, called in 4.3 + the updated `rtc_e2e.rs`; `DecodedFrame`/`FramePixels::Cpu{planes,strides}`/`PixelFormat::I420` are the existing Phase-3 seam types (tight strides `[w, w/2, w/2]` from `FfmpegDecoder` → `UNPACK_ALIGNMENT 1` upload). The retired `VideoRenderer` (4.1 Step 5) is confirmed unreferenced before removal.
- **Known follow-ups (not blockers):** A/V sync (Phase 5 — frames render as-fast-as-decoded, no PTS pacing yet); the engine→GTK frame clone is a move (no copy) but uploads happen at GLArea cadence, not frame cadence (latest-wins drops extras — intended); `std::mem::forget` in the example is a deliberate "keep alive for process lifetime" shortcut (the real app manages lifetimes in Phase 6).
