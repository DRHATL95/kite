//! Media seams: decode (encoded access unit → frame) and render (frame →
//! screen). The engine depends on these traits; concrete codecs/renderers
//! (ffmpeg, gpu-video, per-OS surfaces) are adapters behind them.

/// An encoded access unit handed to a decoder: one Annex-B H.264 picture for
/// video, or one Opus packet for audio, plus its RTP-derived presentation time.
pub struct AccessUnit<'a> {
    pub data: &'a [u8],
    pub pts_micros: u64,
    pub keyframe: bool,
}

/// Pixel format of a CPU-side decoded frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PixelFormat {
    I420,
    Nv12,
    Rgba,
}

/// Where a decoded frame's pixels live. Starts CPU-side (software / HW-readback
/// path); a `Gpu { texture }` variant lands in Phase 3 for zero-copy.
pub enum FramePixels {
    Cpu {
        format: PixelFormat,
        planes: Vec<Vec<u8>>,
        strides: Vec<usize>,
    },
}

/// A decoded video frame at the decode↔render seam. Intentionally minimal so the
/// representation can grow (e.g. a GPU texture handle) without churning callers.
pub struct DecodedFrame {
    pub width: u32,
    pub height: u32,
    pub pts_micros: u64,
    pub pixels: FramePixels,
}

/// Decoded PCM audio (decoder's native output; the `opus` crate yields i16).
pub struct AudioPcm {
    pub sample_rate: u32,
    pub channels: u16,
    pub pts_micros: u64,
    pub samples: Vec<i16>,
}

/// Decodes encoded video access units into frames.
///
/// Adapters: `FfmpegDecoder` (software + HW fallback) first; VA-API/NVDEC,
/// D3D11VA, VideoToolbox later — all without touching the engine.
pub trait VideoDecoder: Send {
    fn feed(&mut self, au: AccessUnit<'_>) -> super::Result<()>;
    /// Pull the next ready frame, if any (decoders may buffer / reorder).
    fn poll(&mut self) -> Option<DecodedFrame>;
}

/// Decodes Opus packets into PCM. Adapter: the `opus` crate.
pub trait AudioDecoder: Send {
    fn decode(&mut self, packet: &[u8], pts_micros: u64) -> super::Result<AudioPcm>;
}

#[cfg(feature = "native-webrtc")]
mod decode_ffmpeg;
#[cfg(feature = "native-webrtc")]
pub use decode_ffmpeg::FfmpegDecoder;

#[cfg(feature = "native-webrtc")]
mod decode_opus;
#[cfg(feature = "native-webrtc")]
pub use decode_opus::OpusDecoder;

pub mod audio_sink;
pub mod frame_sink;

#[cfg(all(target_os = "linux", feature = "native-webrtc"))]
pub mod render_gtk;
