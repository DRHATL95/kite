//! Video underlay for GTK windows whose webview is drawn through GDK's GL path
//! (WebKit composited, i.e. native Wayland).
//!
//! In that mode GDK only blends the webview over other *GL* content: anything
//! painted with plain cairo in the same area, before or after it, is discarded
//! (measured 2026-11-16: the window was see-through behind the HUD both ways).
//! So the picture is uploaded to a texture and handed to GDK with
//! `gdk_cairo_draw_from_gl` from the window's draw handler, before the webview
//! draws; GDK then blends the translucent webview over it.

use glow::HasContext;
use gtk::cairo;
use gtk::gdk;
use gtk::gdk::prelude::*;

use super::render_cairo::CairoVideo;

const GL_TEXTURE: i32 = 0x1702;

pub struct GlUnderlay {
    ctx: gdk::GLContext,
    gl: glow::Context,
    tex: glow::Texture,
    /// Size of the uploaded picture in device pixels; (0, 0) until the first upload.
    size: (i32, i32),
}

impl GlUnderlay {
    /// A GL context sharing textures with the one GDK paints `window` with.
    pub fn new(window: &gdk::Window) -> Result<Self, String> {
        let ctx = window.create_gl_context().map_err(|e| format!("create_gl_context: {e}"))?;
        ctx.realize().map_err(|e| format!("realize: {e}"))?;
        ctx.make_current();
        // SAFETY: `ctx` is current on this (the GTK main) thread for every GL call below.
        let gl = unsafe { glow::Context::from_loader_function(super::render_gtk::load_gl_proc) };
        let tex = unsafe {
            let tex = gl.create_texture()?;
            gl.bind_texture(glow::TEXTURE_2D, Some(tex));
            for (k, v) in [
                (glow::TEXTURE_MIN_FILTER, glow::LINEAR),
                (glow::TEXTURE_MAG_FILTER, glow::LINEAR),
                (glow::TEXTURE_WRAP_S, glow::CLAMP_TO_EDGE),
                (glow::TEXTURE_WRAP_T, glow::CLAMP_TO_EDGE),
            ] {
                gl.tex_parameter_i32(glow::TEXTURE_2D, k, v as i32);
            }
            tex
        };
        Ok(Self { ctx, gl, tex, size: (0, 0) })
    }

    /// Compose black + the letterboxed frame at `size` device pixels and upload it.
    pub fn upload(&mut self, video: &CairoVideo, size: (i32, i32)) {
        let (w, h) = (size.0.max(1), size.1.max(1));
        let Ok(mut surface) = cairo::ImageSurface::create(cairo::Format::ARgb32, w, h) else {
            return;
        };
        {
            let Ok(cr) = cairo::Context::new(&surface) else { return };
            // GDK treats the texture as GL-oriented (first row at the bottom), so compose flipped.
            cr.translate(0.0, h as f64);
            cr.scale(1.0, -1.0);
            video.paint(&cr, (0.0, 0.0, w as f64, h as f64), 1.0, false);
        }
        surface.flush();
        let stride = surface.stride();
        let Ok(data) = surface.data() else { return };
        self.ctx.make_current();
        // SAFETY: context current (above); `data` is h rows of `stride` bytes of BGRA,
        // which is what cairo's ARgb32 is on little-endian.
        unsafe {
            self.gl.bind_texture(glow::TEXTURE_2D, Some(self.tex));
            self.gl.pixel_store_i32(glow::UNPACK_ROW_LENGTH, stride / 4);
            self.gl.tex_image_2d(
                glow::TEXTURE_2D, 0, glow::RGBA8 as i32, w, h, 0,
                glow::BGRA, glow::UNSIGNED_BYTE, Some(&data),
            );
            self.gl.pixel_store_i32(glow::UNPACK_ROW_LENGTH, 0);
        }
        self.size = (w, h);
    }

    pub fn size(&self) -> (i32, i32) {
        self.size
    }

    /// Hand the picture to GDK at the cairo origin. No-op before the first upload.
    pub fn draw(&self, cr: &cairo::Context, window: &gdk::Window, scale: i32) {
        if self.size == (0, 0) {
            return;
        }
        // SAFETY: `tex` is a live texture of `size` in a context sharing with GDK's paint context.
        unsafe {
            cr.draw_from_gl(window, self.tex.0.get() as i32, GL_TEXTURE, scale, 0, 0, self.size.0, self.size.1);
        }
    }
}
