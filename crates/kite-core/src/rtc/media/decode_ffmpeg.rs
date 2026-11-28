//! Software H.264 (Annex-B) decoder adapter over ffmpeg-the-third, emitting
//! CPU-side I420 frames. Ported from the proven Phase-0 spike. HW (VA-API) and
//! zero-copy GPU output are a later phase (co-designed with the renderer).

use ffmpeg_the_third as ffmpeg;

use crate::rtc::media::{AccessUnit, DecodedFrame, FramePixels, PixelFormat, VideoDecoder};
use crate::rtc::{Result, RtcError};

pub struct FfmpegDecoder {
    decoder: ffmpeg::decoder::Video,
}

impl FfmpegDecoder {
    /// Build a software H.264 decoder.
    pub fn new_h264() -> Result<Self> {
        ffmpeg::init().map_err(|e| RtcError::Decode(format!("ffmpeg init: {e}")))?;
        let codec = ffmpeg::decoder::find(ffmpeg::codec::Id::H264)
            .ok_or_else(|| RtcError::Decode("no H264 decoder in this ffmpeg build".into()))?;
        let ctx = ffmpeg::codec::context::Context::new_with_codec(codec);
        let decoder = ctx
            .decoder()
            .video()
            .map_err(|e| RtcError::Decode(format!("open H264 decoder: {e}")))?;
        Ok(Self { decoder })
    }
}

impl VideoDecoder for FfmpegDecoder {
    fn feed(&mut self, au: AccessUnit<'_>) -> Result<()> {
        let mut packet = ffmpeg::codec::packet::Packet::copy(au.data);
        // Carry the RTP-derived timestamp so decoded frames keep their PTS
        // (needed for A/V sync in Phase 5; without it every frame reads 0µs).
        packet.set_pts(Some(au.pts_micros as i64));
        // TODO(phase-3 hardening): distinguish EAGAIN ("need more data", normal
        // before the first keyframe) from fatal errors (AVERROR_INVALIDDATA, etc.)
        // and surface the latter as Err(RtcError::Decode(..)). Mirrors the spike's
        // tolerant pattern for now.
        let _ = self.decoder.send_packet(&packet);
        Ok(())
    }

    fn poll(&mut self) -> Option<DecodedFrame> {
        let mut frame = ffmpeg::frame::Video::empty();
        if self.decoder.receive_frame(&mut frame).is_ok() {
            Some(frame_to_i420(&frame))
        } else {
            None
        }
    }
}

/// Copy an ffmpeg YUV420P frame into a tightly-packed I420 `DecodedFrame`.
fn frame_to_i420(frame: &ffmpeg::frame::Video) -> DecodedFrame {
    let w = frame.width();
    let h = frame.height();
    let (wu, hu) = (w as usize, h as usize);
    let cw = wu.div_ceil(2);
    let ch = hu.div_ceil(2);

    let y = pack_plane(frame, 0, wu, hu);
    let u = pack_plane(frame, 1, cw, ch);
    let v = pack_plane(frame, 2, cw, ch);

    DecodedFrame {
        width: w,
        height: h,
        pts_micros: frame.pts().unwrap_or(0).max(0) as u64,
        pixels: FramePixels::Cpu {
            format: PixelFormat::I420,
            planes: vec![y, u, v],
            strides: vec![wu, cw, cw],
        },
    }
}

/// Copy one plane row-by-row, stripping ffmpeg's stride padding.
fn pack_plane(frame: &ffmpeg::frame::Video, plane: usize, width: usize, height: usize) -> Vec<u8> {
    let stride = frame.stride(plane);
    let data = frame.data(plane);
    let mut out = Vec::with_capacity(width * height);
    for row in 0..height {
        out.extend_from_slice(&data[row * stride..row * stride + width]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rtc::media::{AccessUnit, FramePixels, PixelFormat, VideoDecoder};

    /// Split a raw Annex-B stream into access units on 4-byte start codes.
    fn annexb_aus(buf: &[u8]) -> Vec<Vec<u8>> {
        let sc = [0u8, 0, 0, 1];
        let mut starts: Vec<usize> = buf
            .windows(4)
            .enumerate()
            .filter(|(_, w)| *w == sc)
            .map(|(i, _)| i)
            .collect();
        starts.push(buf.len());
        starts
            .windows(2)
            .map(|w| buf[w[0]..w[1]].to_vec())
            .collect()
    }

    #[test]
    fn decodes_fixture_to_i420_frame() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/test_h264.h264");
        let raw = std::fs::read(path).expect("fixture present");
        let mut dec = FfmpegDecoder::new_h264().expect("decoder");

        let mut got: Option<crate::rtc::media::DecodedFrame> = None;
        for au in annexb_aus(&raw) {
            dec.feed(AccessUnit {
                data: &au,
                pts_micros: 0,
                keyframe: false,
            })
            .unwrap();
            if let Some(f) = dec.poll() {
                got = Some(f);
                break;
            }
        }
        let f = got.expect("decoded at least one frame");
        assert_eq!(f.width, 320);
        assert_eq!(f.height, 240);
        match f.pixels {
            FramePixels::Cpu {
                format,
                planes,
                strides,
            } => {
                assert_eq!(format, PixelFormat::I420);
                assert_eq!(planes.len(), 3, "Y/U/V");
                assert_eq!(strides, vec![320, 160, 160]);
                assert_eq!(planes[0].len(), 320 * 240);
                assert_eq!(planes[1].len(), 160 * 120);
                assert_eq!(planes[2].len(), 160 * 120);
            }
        }
    }
}
