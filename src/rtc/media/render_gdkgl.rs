//! Video underlay for GTK windows whose webview is drawn through GDK's GL path
//! (WebKit composited, i.e. native Wayland).
//!
//! In that mode GDK only blends the webview over other *GL* content: anything
//! painted with plain cairo in the same area, before or after it, is discarded
//! (measured 2026-11-16: the window was see-through behind the HUD both ways).
//! So the frame is rendered into a window-sized texture and handed to GDK with
//! `gdk_cairo_draw_from_gl` from the window's draw handler, before the webview
//! draws; GDK then blends the translucent webview over it.
//!
//! The GPU does the colour conversion and the scaling (the I420 shader from
//! `render_gtk`): only the source-resolution planes are uploaded per frame. A
//! first version scaled on the CPU and uploaded a window-sized image, which was
//! choppy when maximised (up to ~59 MB per frame on a 4K display at 2x).

use glow::HasContext;
use gtk::cairo;
use gtk::gdk;
use gtk::gdk::prelude::*;

use super::DecodedFrame;
use super::render_cairo::fit;
use super::render_gtk::{GlState, build_gl_state, load_gl_proc};

const GL_TEXTURE: i32 = 0x1702;

pub struct GlUnderlay {
    ctx: gdk::GLContext,
    st: GlState,
    fbo: glow::Framebuffer,
    /// The window-sized picture GDK is given.
    color: glow::Texture,
    /// Size of `color` in device pixels; (0, 0) until the first render.
    size: (i32, i32),
}

impl GlUnderlay {
    /// A GL context sharing textures with the one GDK paints `window` with.
    pub fn new(window: &gdk::Window) -> Result<Self, String> {
        let ctx = window.create_gl_context().map_err(|e| format!("create_gl_context: {e}"))?;
        ctx.realize().map_err(|e| format!("realize: {e}"))?;
        ctx.make_current();
        // SAFETY: `ctx` is current on this (the GTK main) thread for every GL call below.
        let gl = unsafe { glow::Context::from_loader_function(load_gl_proc) };
        let st = build_gl_state(gl)?;
        let (fbo, color) = unsafe {
            let color = st.gl.create_texture()?;
            st.gl.active_texture(glow::TEXTURE0);
            st.gl.bind_texture(glow::TEXTURE_2D, Some(color));
            for (k, v) in [
                (glow::TEXTURE_MIN_FILTER, glow::NEAREST),
                (glow::TEXTURE_MAG_FILTER, glow::NEAREST),
                (glow::TEXTURE_WRAP_S, glow::CLAMP_TO_EDGE),
                (glow::TEXTURE_WRAP_T, glow::CLAMP_TO_EDGE),
            ] {
                st.gl.tex_parameter_i32(glow::TEXTURE_2D, k, v as i32);
            }
            (st.gl.create_framebuffer()?, color)
        };
        Ok(Self { ctx, st, fbo, color, size: (0, 0) })
    }

    pub fn size(&self) -> (i32, i32) {
        self.size
    }

    /// Forget the current frame (the stream ended); the next render is plain black.
    pub fn clear(&mut self) {
        self.st.dims = None;
    }

    /// Upload `frame` if given, then redraw the picture at `size` device pixels:
    /// black, with the current frame letterboxed in it.
    pub fn render(&mut self, frame: Option<&DecodedFrame>, size: (i32, i32)) {
        let (w, h) = (size.0.max(1), size.1.max(1));
        self.ctx.make_current();
        // SAFETY: our context is current (above) and owns every handle used here.
        unsafe {
            if let Some(frame) = frame {
                self.st.upload(frame);
            }
            let gl = &self.st.gl;
            if self.size != (w, h) {
                gl.active_texture(glow::TEXTURE0);
                gl.bind_texture(glow::TEXTURE_2D, Some(self.color));
                gl.tex_image_2d(
                    // RGB8, not RGBA8: GDK asks the texture for its alpha size and only
                    // treats an alpha-free one as opaque (see native_render::mount).
                    glow::TEXTURE_2D, 0, glow::RGB8 as i32, w, h, 0,
                    glow::RGB, glow::UNSIGNED_BYTE, None,
                );
                self.size = (w, h);
            }
            gl.bind_framebuffer(glow::FRAMEBUFFER, Some(self.fbo));
            gl.framebuffer_texture_2d(
                glow::FRAMEBUFFER, glow::COLOR_ATTACHMENT0, glow::TEXTURE_2D, Some(self.color), 0,
            );
            gl.viewport(0, 0, w, h);
            gl.clear_color(0.0, 0.0, 0.0, 1.0);
            gl.clear(glow::COLOR_BUFFER_BIT);
            if let Some(src) = self.st.dims {
                let (fw, fh) = fit(src, (w as u32, h as u32));
                gl.viewport((w - fw as i32) / 2, (h - fh as i32) / 2, fw as i32, fh as i32);
                self.st.draw_frame();
            }
            gl.bind_framebuffer(glow::FRAMEBUFFER, None);
            gl.flush();
        }
    }

    /// Hand the picture to GDK at the cairo origin. No-op before the first render.
    pub fn draw(&self, cr: &cairo::Context, window: &gdk::Window, scale: i32) {
        if self.size == (0, 0) {
            return;
        }
        // SAFETY: `color` is a live texture of `size` in a context sharing with GDK's paint context.
        unsafe {
            cr.draw_from_gl(window, self.color.0.get() as i32, GL_TEXTURE, scale, 0, 0, self.size.0, self.size.1);
        }
    }
}
