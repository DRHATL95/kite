//! Clip payload parsing + H.264/AAC remux into a native MP4 via `muxide`.
//!
//! The browser captures already-encoded H.264 (Annex-B) video frames and Opus
//! audio off the WebRTC receiver, transcodes the audio to AAC, packs everything
//! into the compact binary layout below, and ships it over a raw Tauri IPC body.
//! This module parses that payload and remuxes it — no re-encoding of video.
//!
//! ## Wire format (little-endian; produced by `ui/src/lib/clip/clipPayload.ts`)
//!
//! ```text
//! [u32 magic 'XCLP' = 0x58434C50][u8 version = 1]
//! [u16 width][u16 height][u16 fps_num][u16 fps_den]
//! [u32 sps_len][sps bytes][u32 pps_len][pps bytes]
//! [u32 aac_config_len][aac config bytes]            // AudioSpecificConfig (informational)
//! [u32 video_count]  then video_count × [u8 keyframe][f64 pts_sec][u32 len][nal bytes (Annex-B)]
//! [u32 audio_count]  then audio_count × [f64 pts_sec][u32 len][aac bytes (raw, no ADTS)]
//! ```
//!
//! ## muxide 0.2.5 reconciliation (see also the design spec §5.4)
//!
//! - **Non-fragmented, fast-start MP4.** muxide's *fragmented* path is video-only
//!   (`FragmentConfig` carries no audio), so to keep AAC audio we use `.build()`,
//!   which writes `moov` before `mdat` — still native and seekable.
//! - **AAC → ADTS.** `write_audio` validates ADTS framing, but WebCodecs emits raw
//!   AAC, so [`wrap_adts`] prepends a 7-byte ADTS header to each frame.
//! - **In-band SPS/PPS.** `.build()` derives parameter sets from the first keyframe,
//!   so [`ensure_sps_pps`] guarantees the first frame carries SPS/PPS (prepending the
//!   payload's copies only if the bitstream lacks them).
//! - muxide rejects a non-keyframe first frame and non-monotonic PTS, which is
//!   exactly the keyframe-aligned / clean-file guarantee the design relies on.

/// Magic identifying a clip payload: ASCII `XCLP`, read/written as a LE `u32`.
pub const MAGIC: u32 = 0x5843_4C50;
/// Current payload version.
pub const VERSION: u8 = 1;

/// One encoded video frame (Annex-B H.264 NAL bitstream).
#[derive(Debug, Clone, PartialEq)]
pub struct VideoFrame {
    pub keyframe: bool,
    pub pts_sec: f64,
    pub nal: Vec<u8>,
}

/// One encoded audio frame (raw AAC, no ADTS framing).
#[derive(Debug, Clone, PartialEq)]
pub struct AudioFrame {
    pub pts_sec: f64,
    pub aac: Vec<u8>,
}

/// A fully-parsed clip payload ready to remux.
#[derive(Debug, Clone, PartialEq)]
pub struct ClipPayload {
    pub width: u16,
    pub height: u16,
    pub fps_num: u16,
    pub fps_den: u16,
    pub sps: Vec<u8>,
    pub pps: Vec<u8>,
    pub aac_config: Vec<u8>,
    pub video: Vec<VideoFrame>,
    pub audio: Vec<AudioFrame>,
}

impl ClipPayload {
    /// Serialize to the wire format. Used by tests (and any Rust-side fixture);
    /// the production producer is the TypeScript packer, which must match byte-for-byte.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&MAGIC.to_le_bytes());
        b.push(VERSION);
        b.extend_from_slice(&self.width.to_le_bytes());
        b.extend_from_slice(&self.height.to_le_bytes());
        b.extend_from_slice(&self.fps_num.to_le_bytes());
        b.extend_from_slice(&self.fps_den.to_le_bytes());
        write_blob(&mut b, &self.sps);
        write_blob(&mut b, &self.pps);
        write_blob(&mut b, &self.aac_config);

        b.extend_from_slice(&(self.video.len() as u32).to_le_bytes());
        for f in &self.video {
            b.push(if f.keyframe { 1 } else { 0 });
            b.extend_from_slice(&f.pts_sec.to_le_bytes());
            write_blob(&mut b, &f.nal);
        }

        b.extend_from_slice(&(self.audio.len() as u32).to_le_bytes());
        for f in &self.audio {
            b.extend_from_slice(&f.pts_sec.to_le_bytes());
            write_blob(&mut b, &f.aac);
        }
        b
    }

    /// Parse the wire format, validating magic + version and all length fields.
    pub fn parse(data: &[u8]) -> Result<ClipPayload, String> {
        let mut c = Cursor::new(data);
        let magic = c.u32()?;
        if magic != MAGIC {
            return Err(format!("bad magic: {magic:#010x} (expected {MAGIC:#010x})"));
        }
        let version = c.u8()?;
        if version != VERSION {
            return Err(format!("unsupported version {version} (expected {VERSION})"));
        }
        let width = c.u16()?;
        let height = c.u16()?;
        let fps_num = c.u16()?;
        let fps_den = c.u16()?;
        let sps = c.blob()?;
        let pps = c.blob()?;
        let aac_config = c.blob()?;

        let video_count = c.u32()? as usize;
        let mut video = Vec::with_capacity(video_count.min(1 << 16));
        for _ in 0..video_count {
            let keyframe = c.u8()? != 0;
            let pts_sec = c.f64()?;
            let nal = c.blob()?;
            video.push(VideoFrame { keyframe, pts_sec, nal });
        }

        let audio_count = c.u32()? as usize;
        let mut audio = Vec::with_capacity(audio_count.min(1 << 16));
        for _ in 0..audio_count {
            let pts_sec = c.f64()?;
            let aac = c.blob()?;
            audio.push(AudioFrame { pts_sec, aac });
        }

        Ok(ClipPayload {
            width,
            height,
            fps_num,
            fps_den,
            sps,
            pps,
            aac_config,
            video,
            audio,
        })
    }
}

/// Mux an encoded payload into a native (fast-start) MP4, returned as bytes.
///
/// Video frames are written losslessly; audio frames are ADTS-wrapped and written
/// as AAC. PTS are rebased so the clip starts at 0. The first video frame must be a
/// keyframe (the slice is always cut at one) and carries SPS/PPS.
pub fn mux_to_mp4(p: &ClipPayload) -> Result<Vec<u8>, String> {
    use muxide::api::{AacProfile, AudioCodec, MuxerBuilder, VideoCodec};

    if p.video.is_empty() {
        return Err("clip has no video frames".to_string());
    }
    if !p.video[0].keyframe {
        return Err("first video frame must be a keyframe".to_string());
    }

    let fps = p.fps_num as f64 / p.fps_den.max(1) as f64;
    let has_audio = !p.audio.is_empty();

    // Rebase so the slice starts at t=0 (muxide requires pts >= 0 and monotonic).
    let t0 = p.video[0].pts_sec;

    let mut out: Vec<u8> = Vec::new();
    {
        let mut builder =
            MuxerBuilder::new(&mut out).video(VideoCodec::H264, p.width as u32, p.height as u32, fps);
        if has_audio {
            // 48 kHz / stereo / AAC-LC matches the WebCodecs encoder config (Task 7).
            builder = builder.audio(AudioCodec::Aac(AacProfile::Lc), 48_000, 2);
        }
        let mut muxer = builder.build().map_err(|e| format!("muxer init: {e}"))?;

        for (i, f) in p.video.iter().enumerate() {
            let pts = (f.pts_sec - t0).max(0.0);
            let data = if i == 0 {
                ensure_sps_pps(&f.nal, &p.sps, &p.pps)
            } else {
                f.nal.clone()
            };
            muxer
                .write_video(pts, &data, f.keyframe)
                .map_err(|e| format!("write_video[{i}]: {e}"))?;
        }

        if has_audio {
            for (i, f) in p.audio.iter().enumerate() {
                let pts = (f.pts_sec - t0).max(0.0);
                let adts = wrap_adts(&f.aac, 48_000, 2);
                muxer
                    .write_audio(pts, &adts)
                    .map_err(|e| format!("write_audio[{i}]: {e}"))?;
            }
        }

        muxer.finish().map_err(|e| format!("finish: {e}"))?;
    }
    Ok(out)
}

// ── Annex-B / ADTS helpers ──────────────────────────────────────────────────

/// True if `data` contains a NAL of the given type (low 5 bits of the header byte),
/// scanning for 3- or 4-byte Annex-B start codes.
fn contains_nal_type(data: &[u8], nal_type: u8) -> bool {
    let mut i = 0;
    while i + 3 < data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            if (data[i + 3] & 0x1f) == nal_type {
                return true;
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    false
}

/// Guarantee the first keyframe carries SPS (NAL 7) + PPS (NAL 8). WebRTC keyframes
/// normally include them in-band; if not, prepend the payload's copies as Annex-B.
fn ensure_sps_pps(first: &[u8], sps: &[u8], pps: &[u8]) -> Vec<u8> {
    if contains_nal_type(first, 7) {
        return first.to_vec();
    }
    let mut out = Vec::with_capacity(8 + sps.len() + pps.len() + first.len());
    if !sps.is_empty() {
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(sps);
    }
    if !pps.is_empty() {
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(pps);
    }
    out.extend_from_slice(first);
    out
}

/// ADTS sampling-frequency index for a given sample rate (defaults to 48 kHz / idx 3).
fn adts_freq_index(sample_rate: u32) -> u8 {
    match sample_rate {
        96000 => 0,
        88200 => 1,
        64000 => 2,
        48000 => 3,
        44100 => 4,
        32000 => 5,
        24000 => 6,
        22050 => 7,
        16000 => 8,
        12000 => 9,
        11025 => 10,
        8000 => 11,
        7350 => 12,
        _ => 3,
    }
}

/// Wrap a raw AAC-LC frame in a 7-byte ADTS header (no CRC), as muxide requires.
fn wrap_adts(aac: &[u8], sample_rate: u32, channels: u16) -> Vec<u8> {
    let profile = 1u8; // ADTS profile = MPEG-4 object type (AAC-LC = 2) − 1.
    let freq_idx = adts_freq_index(sample_rate);
    let chan = (channels as u8) & 0x7;
    let frame_len = 7 + aac.len();

    let mut out = Vec::with_capacity(frame_len);
    out.push(0xFF);
    out.push(0xF1); // syncword high + MPEG-4 + layer 0 + protection_absent=1
    out.push((profile << 6) | (freq_idx << 2) | ((chan >> 2) & 0x1));
    out.push(((chan & 0x3) << 6) | (((frame_len >> 11) & 0x3) as u8));
    out.push(((frame_len >> 3) & 0xFF) as u8);
    out.push((((frame_len & 0x7) << 5) as u8) | 0x1F);
    out.push(0xFC); // buffer fullness (VBR) low + 0 raw data blocks
    out.extend_from_slice(aac);
    out
}

// ── Little-endian cursor ────────────────────────────────────────────────────

fn write_blob(b: &mut Vec<u8>, blob: &[u8]) {
    b.extend_from_slice(&(blob.len() as u32).to_le_bytes());
    b.extend_from_slice(blob);
}

struct Cursor<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Cursor<'a> {
    fn new(b: &'a [u8]) -> Self {
        Cursor { b, i: 0 }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self
            .i
            .checked_add(n)
            .ok_or("length overflow while reading payload")?;
        if end > self.b.len() {
            return Err(format!(
                "unexpected end of payload: need {n} bytes at offset {} (len {})",
                self.i,
                self.b.len()
            ));
        }
        let s = &self.b[self.i..end];
        self.i = end;
        Ok(s)
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, String> {
        let s = self.take(2)?;
        Ok(u16::from_le_bytes([s[0], s[1]]))
    }

    fn u32(&mut self) -> Result<u32, String> {
        let s = self.take(4)?;
        Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }

    fn f64(&mut self) -> Result<f64, String> {
        let s = self.take(8)?;
        let mut a = [0u8; 8];
        a.copy_from_slice(s);
        Ok(f64::from_le_bytes(a))
    }

    fn blob(&mut self) -> Result<Vec<u8>, String> {
        let len = self.u32()? as usize;
        Ok(self.take(len)?.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_round_trips_a_minimal_payload() {
        let payload = ClipPayload {
            width: 1920,
            height: 1080,
            fps_num: 60,
            fps_den: 1,
            sps: vec![0x67, 0x42],
            pps: vec![0x68, 0xce],
            aac_config: vec![0x12, 0x10],
            video: vec![VideoFrame {
                keyframe: true,
                pts_sec: 0.0,
                nal: vec![0, 0, 0, 1, 0x65],
            }],
            audio: vec![AudioFrame {
                pts_sec: 0.0,
                aac: vec![0xff, 0xf1],
            }],
        };
        let bytes = payload.to_bytes();
        let parsed = ClipPayload::parse(&bytes).unwrap();
        assert_eq!(parsed, payload);
        assert_eq!(parsed.width, 1920);
        assert_eq!(parsed.video.len(), 1);
        assert!(parsed.video[0].keyframe);
        assert_eq!(parsed.audio[0].aac, vec![0xff, 0xf1]);
    }

    #[test]
    fn parse_rejects_bad_magic_and_truncation() {
        assert!(ClipPayload::parse(&[0, 1, 2, 3, 1]).is_err());
        let mut good = ClipPayload {
            width: 2,
            height: 2,
            fps_num: 30,
            fps_den: 1,
            sps: vec![],
            pps: vec![],
            aac_config: vec![],
            video: vec![],
            audio: vec![],
        }
        .to_bytes();
        good.truncate(good.len() - 1); // drop a byte → audio blob underflows
        assert!(ClipPayload::parse(&good).is_err());
    }

    #[test]
    fn wrap_adts_sets_syncword_and_length() {
        let adts = wrap_adts(&[0xaa, 0xbb, 0xcc], 48_000, 2);
        assert_eq!(adts.len(), 10);
        assert_eq!(adts[0], 0xFF);
        assert_eq!(adts[1] & 0xF6, 0xF0); // syncword low nibble + layer 0
                                          // frame_length spans bits across bytes 3..5; reconstruct it.
        let frame_len = (((adts[3] & 0x3) as usize) << 11)
            | ((adts[4] as usize) << 3)
            | ((adts[5] as usize) >> 5);
        assert_eq!(frame_len, 10);
        assert_eq!(&adts[7..], &[0xaa, 0xbb, 0xcc]);
    }

    /// A minimal Annex-B H.264 keyframe: SPS (7) + PPS (8) + IDR (5).
    fn h264_keyframe() -> Vec<u8> {
        let mut d = Vec::new();
        d.extend_from_slice(&[0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e, 0x95, 0xa8, 0x28, 0x28, 0x28]);
        d.extend_from_slice(&[0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80]);
        d.extend_from_slice(&[0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00, 0x00, 0x03, 0x00, 0x00, 0x03]);
        d
    }

    #[test]
    fn mux_produces_a_valid_mp4() {
        let payload = ClipPayload {
            width: 1920,
            height: 1080,
            fps_num: 60,
            fps_den: 1,
            sps: vec![0x67, 0x42, 0x00, 0x1e, 0x95, 0xa8, 0x28, 0x28, 0x28],
            pps: vec![0x68, 0xce, 0x3c, 0x80],
            aac_config: vec![0x11, 0x90], // AAC-LC 48k stereo ASC (informational)
            video: vec![VideoFrame {
                keyframe: true,
                pts_sec: 10.0, // non-zero start → exercises PTS rebasing
                nal: h264_keyframe(),
            }],
            audio: vec![AudioFrame {
                pts_sec: 10.0,
                aac: vec![0x01, 0x02, 0x03, 0x04],
            }],
        };
        let mp4 = mux_to_mp4(&payload).expect("mux should succeed");
        assert!(mp4.len() > 32, "MP4 unexpectedly small: {} bytes", mp4.len());
        // Every MP4 starts with an `ftyp` box: [u32 size]['f','t','y','p'].
        assert_eq!(&mp4[4..8], b"ftyp", "output is not an MP4 (no ftyp box)");
    }

    #[test]
    fn mux_rejects_non_keyframe_first_frame() {
        let payload = ClipPayload {
            width: 16,
            height: 16,
            fps_num: 30,
            fps_den: 1,
            sps: vec![],
            pps: vec![],
            aac_config: vec![],
            video: vec![VideoFrame {
                keyframe: false,
                pts_sec: 0.0,
                nal: vec![0, 0, 0, 1, 0x41],
            }],
            audio: vec![],
        };
        assert!(mux_to_mp4(&payload).is_err());
    }
}
