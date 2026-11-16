//! Video underlay for the Tauri window: converts decoded I420 frames to a cairo
//! surface and paints it *beneath* whatever the window has already drawn.
//!
//! Why not a `gtk::GLArea` (see `render_gtk`): putting one under Tauri's webview
//! means re-parenting the live webview into a `gtk::Overlay`, which empties
//! WebKit's backing store (window black until a manual resize). Painting from the
//! window's own draw handler with `DEST_OVER` leaves the webview untouched and
//! still shows through every transparent pixel of the page (proven 2026-11-16).

use ffmpeg_the_third as ffmpeg;
use ffmpeg::format::Pixel;
use ffmpeg::software::scaling;
use gtk::cairo;

use super::{DecodedFrame, FramePixels, PixelFormat};

/// Largest `(w, h)` with `src`'s aspect ratio that fits in `dst`. Never zero.
pub fn fit(src: (u32, u32), dst: (u32, u32)) -> (u32, u32) {
    if src.0 == 0 || src.1 == 0 {
        return (dst.0.max(1), dst.1.max(1));
    }
    let w = (dst.1 as u64 * src.0 as u64 / src.1 as u64).min(dst.0 as u64);
    let h = (w * src.1 as u64 / src.0 as u64).min(dst.1 as u64);
    (w.max(1) as u32, h.max(1) as u32)
}

#[derive(Default)]
pub struct CairoVideo {
    /// Cached swscale context, keyed by (src w, src h, dst w, dst h).
    scaler: Option<((u32, u32, u32, u32), scaling::Context)>,
    /// Latest frame, already converted to BGRx at its on-screen pixel size.
    surface: Option<cairo::ImageSurface>,
}

impl CairoVideo {
    /// Convert `frame` to fit a `dst` area given in device pixels. A frame this
    /// renderer cannot handle keeps the previous picture.
    pub fn update(&mut self, frame: &DecodedFrame, dst: (u32, u32)) {
        let FramePixels::Cpu { format: PixelFormat::I420, planes, strides } = &frame.pixels else {
            return;
        };
        if planes.len() < 3 || strides.len() < 3 {
            return;
        }
        let (dw, dh) = fit((frame.width, frame.height), dst);
        let key = (frame.width, frame.height, dw, dh);
        if self.scaler.as_ref().map(|(k, _)| *k) != Some(key) {
            let ctx = scaling::Context::get(
                Pixel::YUV420P, frame.width, frame.height,
                Pixel::BGRA, dw, dh,
                scaling::Flags::BILINEAR,
            );
            match ctx {
                Ok(c) => self.scaler = Some((key, c)),
                Err(e) => {
                    tracing::warn!("render_cairo: swscale context failed: {e}");
                    return;
                }
            }
        }

        let mut src = ffmpeg::frame::Video::new(Pixel::YUV420P, frame.width, frame.height);
        for (i, rows) in [frame.height, frame.height.div_ceil(2), frame.height.div_ceil(2)]
            .into_iter()
            .enumerate()
        {
            let (from, from_stride) = (&planes[i], strides[i]);
            let to_stride = src.stride(i);
            let n = from_stride.min(to_stride);
            let to = src.data_mut(i);
            for row in 0..rows as usize {
                let (a, b) = (row * from_stride, row * to_stride);
                // A short plane is a decoder bug; leave the rest of the picture as it is.
                if a + n > from.len() || b + n > to.len() {
                    break;
                }
                to[b..b + n].copy_from_slice(&from[a..a + n]);
            }
        }

        let mut out = ffmpeg::frame::Video::empty();
        if let Err(e) = self.scaler.as_mut().unwrap().1.run(&src, &mut out) {
            tracing::warn!("render_cairo: swscale run failed: {e}");
            return;
        }
        // BGRA bytes are cairo's Rgb24 on little-endian; ffmpeg's stride is a valid cairo stride.
        match cairo::ImageSurface::create_for_data(
            out.data(0).to_vec(),
            cairo::Format::Rgb24,
            dw as i32,
            dh as i32,
            out.stride(0) as i32,
        ) {
            Ok(s) => self.surface = Some(s),
            Err(e) => tracing::warn!("render_cairo: surface failed: {e}"),
        }
    }

    /// Paint the latest frame centred in `area` (x, y, w, h in cairo user units),
    /// then black everywhere else, all underneath what is already drawn. `scale`
    /// is the widget scale factor the frame was sized with.
    pub fn paint_under(&self, cr: &cairo::Context, area: (f64, f64, f64, f64), scale: f64) {
        let (x, y, w, h) = area;
        cr.save().ok();
        cr.set_operator(cairo::Operator::DestOver);
        if let Some(s) = &self.surface {
            let (sw, sh) = (s.width() as f64 / scale, s.height() as f64 / scale);
            cr.save().ok();
            cr.translate(x + (w - sw) / 2.0, y + (h - sh) / 2.0);
            cr.scale(1.0 / scale, 1.0 / scale);
            if cr.set_source_surface(s, 0.0, 0.0).is_ok() {
                cr.rectangle(0.0, 0.0, s.width() as f64, s.height() as f64);
                let _ = cr.fill();
            }
            cr.restore().ok();
        }
        // The window is transparent (tauri.linux.conf.json); never let the desktop show through.
        cr.set_source_rgb(0.0, 0.0, 0.0);
        cr.rectangle(x, y, w, h);
        let _ = cr.fill();
        cr.restore().ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_letterboxes_and_pillarboxes() {
        assert_eq!(fit((1920, 1080), (1280, 800)), (1280, 720));
        assert_eq!(fit((1920, 1080), (1000, 1000)), (1000, 562));
        assert_eq!(fit((1920, 1080), (4000, 1080)), (1920, 1080));
        assert_eq!(fit((0, 0), (0, 0)), (1, 1));
    }

    #[test]
    fn converts_i420_to_a_surface_of_the_fitted_size_and_right_colour() {
        // 16x16 pure red in BT.601 limited range: Y=81, U=90, V=240.
        let frame = DecodedFrame {
            width: 16,
            height: 16,
            pts_micros: 0,
            pixels: FramePixels::Cpu {
                format: PixelFormat::I420,
                planes: vec![vec![81; 16 * 16], vec![90; 8 * 8], vec![240; 8 * 8]],
                strides: vec![16, 8, 8],
            },
        };
        let mut v = CairoVideo::default();
        v.update(&frame, (64, 32));
        let mut s = v.surface.take().expect("a surface");
        assert_eq!((s.width(), s.height()), (32, 32));
        let stride = s.stride() as usize;
        let data = s.data().unwrap();
        let px = &data[stride * 16 + 16 * 4..][..3]; // B, G, R
        assert!(px[2] > 200 && px[1] < 60 && px[0] < 60, "expected red, got BGR {px:?}");
    }
}
