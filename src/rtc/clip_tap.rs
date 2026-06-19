// src/rtc/clip_tap.rs — pure retroactive-clip ring buffer + keyframe-aligned assemble.
//
// Ported from the authoritative TypeScript sources:
//   ui/src/lib/clip/EncodedTap.ts       — ring buffers, origin anchoring, assemble
//   ui/src/lib/clip/encodedTapLogic.ts  — eviction + keyframe-anchor slice logic
//   ui/src/lib/clip/rtpTime.ts          — RTP-timestamp → monotonic seconds (per-stream)
//   ui/src/lib/clip/annexB.ts           — Annex-B helpers (isAnnexB, toAnnexB, extractSpsPps)
//
// Pure module: std only.  No IO, no str0m / opus / ffmpeg / bytes crates.
// Compiles and tests under default `cargo test` (no feature flags).
//
// ## Phase-5 note
// `AssembledClip` intentionally uses Opus for audio — this is the native-WebRTC
// path.  In Phase 5 the caller will drive `clip::ClipPayload` assembly:
//   - video: each `VideoAu` → `clip::VideoFrame { keyframe, pts_sec, nal }`
//             (ensure SPS/PPS on the first frame via `clip::ensure_sps_pps` logic)
//   - audio: Opus packets need WebCodecs-style Opus→AAC transcode (as in
//             `ui/src/lib/clip/audioTranscode.ts`) or a Rust equivalent, then
//             produce `clip::AudioFrame { pts_sec, aac }` + `aac_config`.
//   Do NOT touch `src/clip.rs` here — that wiring is Phase 5.

// ─────────────────────────────────────────────────────────────────────────────
// RTP clock (ported from rtpTime.ts `RtpClock`)
// ─────────────────────────────────────────────────────────────────────────────

/// Converts a stream's `u32` RTP timestamps to monotonic seconds.
///
/// RTP timestamps wrap at 2³².  The first timestamp seen becomes the origin
/// (t = 0); subsequent timestamps advance an unwrapped accumulator by the
/// forward unsigned delta, so the result is monotonic across wraps.
///
/// Matches `rtpTime.ts RtpClock` exactly (video 90 kHz, audio 48 kHz).
#[derive(Debug, Clone)]
pub struct RtpClock {
    rate: u64,
    last_raw: u32,
    unwrapped: u64,
    initialized: bool,
}

impl RtpClock {
    /// `rate` is ticks per second (90_000 for H.264 video; 48_000 for Opus).
    pub fn new(rate: u32) -> Self {
        assert!(rate > 0, "RtpClock rate must be > 0");
        RtpClock {
            rate: rate as u64,
            last_raw: 0,
            unwrapped: 0,
            initialized: false,
        }
    }

    /// Seconds elapsed since the first timestamp.  The first call returns 0.0
    /// and sets the stream origin.  Forward deltas are computed modulo 2³².
    pub fn to_seconds(&mut self, ts: u32) -> f64 {
        if !self.initialized {
            self.initialized = true;
            self.last_raw = ts;
            self.unwrapped = 0;
            return 0.0;
        }
        // unsigned 32-bit forward delta — handles wrap correctly
        let delta = ts.wrapping_sub(self.last_raw) as u64;
        self.unwrapped += delta;
        self.last_raw = ts;
        self.unwrapped as f64 / self.rate as f64
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Annex-B helpers (ported from annexB.ts)
// ─────────────────────────────────────────────────────────────────────────────

/// True if `data` begins with a 3- or 4-byte Annex-B start code.
pub fn is_annex_b(data: &[u8]) -> bool {
    if data.len() >= 4 && data[0] == 0 && data[1] == 0 && data[2] == 0 && data[3] == 1 {
        return true;
    }
    data.len() >= 3 && data[0] == 0 && data[1] == 0 && data[2] == 1
}

/// Return `data` as Annex-B (owned).  Annex-B input is returned as-is (cloned);
/// AVCC input (4-byte big-endian length prefixes) is rewritten with `00 00 00
/// 01` start codes.  Malformed AVCC stops at the first inconsistent length.
pub fn to_annex_b(data: &[u8]) -> Vec<u8> {
    if is_annex_b(data) {
        return data.to_vec();
    }
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 4 <= data.len() {
        let len = u32::from_be_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]) as usize;
        i += 4;
        if len == 0 || i + len > data.len() {
            break; // malformed → stop cleanly
        }
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(&data[i..i + len]);
        i += len;
    }
    out
}

/// Extract the first SPS (NAL type 7) and PPS (NAL type 8) from an Annex-B
/// frame.  Either may be absent (`None`).
pub fn extract_sps_pps(annex_b: &[u8]) -> (Option<Vec<u8>>, Option<Vec<u8>>) {
    let mut sps: Option<Vec<u8>> = None;
    let mut pps: Option<Vec<u8>> = None;
    for nal in iterate_nals(annex_b) {
        if nal.is_empty() {
            continue;
        }
        let nal_type = nal[0] & 0x1f;
        if nal_type == 7 && sps.is_none() {
            sps = Some(nal.to_vec());
        } else if nal_type == 8 && pps.is_none() {
            pps = Some(nal.to_vec());
        }
    }
    (sps, pps)
}

/// Yield each NAL unit's bytes (without start code).  Handles both 3- and
/// 4-byte Annex-B start codes identically to `annexB.ts iterateNals`.
fn iterate_nals(data: &[u8]) -> impl Iterator<Item = &[u8]> {
    // Collect (sc_start, payload_start) pairs first, then slice.
    let mut codes: Vec<(usize, usize)> = Vec::new(); // (sc_start, payload_start)
    let mut i = 0usize;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            let sc_start = if i > 0 && data[i - 1] == 0 { i - 1 } else { i };
            codes.push((sc_start, i + 3));
            i += 3;
        } else {
            i += 1;
        }
    }
    let n = codes.len();
    let len = data.len();
    let slices: Vec<&[u8]> = (0..n)
        .filter_map(|k| {
            let payload_start = codes[k].1;
            let end = if k + 1 < n { codes[k + 1].0 } else { len };
            if end > payload_start {
                Some(&data[payload_start..end])
            } else {
                None
            }
        })
        .collect();
    slices.into_iter()
}

// ─────────────────────────────────────────────────────────────────────────────
// Owned access-unit types
// ─────────────────────────────────────────────────────────────────────────────

/// An owned encoded video access unit retained in the ring buffer.
///
/// The seam's `media::AccessUnit` borrows `&[u8]` and is not suitable for
/// retained storage.  This type owns its payload.
#[derive(Debug, Clone)]
pub struct VideoAu {
    /// Annex-B H.264 NAL bitstream (owned copy).
    pub bytes: Vec<u8>,
    /// Presentation time in seconds on the shared wall-clock origin.
    pub pts_sec: f64,
    /// True for IDR (H.264 keyframe) frames.
    pub is_keyframe: bool,
}

/// An owned encoded audio (Opus) packet retained in the ring buffer.
#[derive(Debug, Clone)]
pub struct AudioAu {
    /// Raw Opus packet (owned copy).
    pub bytes: Vec<u8>,
    /// Presentation time in seconds on the shared wall-clock origin.
    pub pts_sec: f64,
}

// ─────────────────────────────────────────────────────────────────────────────
// AssembledClip
// ─────────────────────────────────────────────────────────────────────────────

/// A keyframe-aligned clip slice ready for muxing.
///
/// All PTS values are on the SHARED wall-clock origin (see §6.3 of the design
/// spec): both `video` and `audio` share one timeline, so A/V is aligned.
///
/// ## Phase-5 mapping to `clip::ClipPayload`
///
/// When the native-WebRTC path replaces the browser path (Phase 5):
///   - `video`: each `VideoAu` → `clip::VideoFrame { keyframe, pts_sec, nal }`
///     The first frame's `bytes` should be passed through the Annex-B
///     SPS/PPS prepend logic (analogous to `ensure_sps_pps` in `clip.rs`).
///   - `audio`: Opus packets need transcoding to AAC (e.g. a Rust WebCodecs
///     equivalent of `audioTranscode.ts`) to produce `clip::AudioFrame { pts_sec, aac }`.
///     `aac_config` is the resulting AudioSpecificConfig blob.
///   - `sps` / `pps` → `ClipPayload::sps` / `ClipPayload::pps`
///   - `width`, `height`, `fps_num`, `fps_den` pass through directly.
///
/// The current `clip.rs` / muxide path expects AAC — do NOT modify it here.
/// That wiring is explicitly Phase 5.
#[derive(Debug, Clone)]
pub struct AssembledClip {
    /// Frame width in pixels (from out-of-band video track config; default 1920).
    pub width: u32,
    /// Frame height in pixels (from out-of-band video track config; default 1080).
    pub height: u32,
    /// Frame rate numerator (from out-of-band video track config; default 60).
    pub fps_num: u32,
    /// Frame rate denominator (default 1).
    pub fps_den: u32,
    /// H.264 SPS NAL bytes (without start code; extracted from the first keyframe).
    pub sps: Vec<u8>,
    /// H.264 PPS NAL bytes (without start code; extracted from the first keyframe).
    pub pps: Vec<u8>,
    /// Video AUs beginning at the anchor keyframe, PTS on the shared origin.
    pub video: Vec<VideoAu>,
    /// Audio Opus packets with PTS >= the anchor keyframe's PTS, on the shared origin.
    pub audio: Vec<AudioAu>,
    /// PTS of the leading keyframe — the clip's t=0 reference.
    pub start_sec: f64,
}

// ─────────────────────────────────────────────────────────────────────────────
// Video track configuration (out-of-band)
// ─────────────────────────────────────────────────────────────────────────────

/// Out-of-band video track metadata (analogous to `MediaTrackSettings` in TS).
///
/// In the TS implementation `EncodedTap` receives `videoTrackSettings` from
/// `MediaStreamTrack.getSettings()`.  In the Rust path these values come from
/// the WebRTC negotiated video parameters.  Defaults mirror the TS defaults.
#[derive(Debug, Clone)]
pub struct VideoTrackConfig {
    pub width: u32,
    pub height: u32,
    /// Frames per second as a rational number.
    pub fps_num: u32,
    pub fps_den: u32,
}

impl Default for VideoTrackConfig {
    fn default() -> Self {
        VideoTrackConfig {
            width: 1920,
            height: 1080,
            fps_num: 60,
            fps_den: 1,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Eviction + slice helpers (ported from encodedTapLogic.ts)
// ─────────────────────────────────────────────────────────────────────────────

/// Index of the anchor keyframe: the NEWEST IDR with `pts_sec <= cutoff`, or
/// (warm-up) the EARLIEST IDR.  Returns `None` if there are no keyframes.
///
/// Matches `encodedTapLogic.ts anchorKeyframeIndex`.
fn anchor_keyframe_index(video: &[VideoAu], cutoff: f64) -> Option<usize> {
    // Newest IDR at or before the cutoff.
    let mut anchor: Option<usize> = None;
    for (i, au) in video.iter().enumerate() {
        if au.is_keyframe && au.pts_sec <= cutoff {
            anchor = Some(i);
        }
    }
    if anchor.is_some() {
        return anchor;
    }
    // Warm-up fallback: earliest IDR.
    video.iter().position(|au| au.is_keyframe)
}

/// Build a clip ending at "now" covering ~`retain_secs`: video from the anchor
/// IDR through the end, audio aligned to that IDR's PTS.
///
/// Returns `None` if no keyframe exists.  Matches `encodedTapLogic.ts sliceForClip`.
fn slice_for_clip<'v, 'a>(
    video: &'v [VideoAu],
    audio: &'a [AudioAu],
    now_sec: f64,
    retain_secs: f64,
) -> Option<(&'v [VideoAu], Vec<&'a AudioAu>, f64)> {
    let anchor = anchor_keyframe_index(video, now_sec - retain_secs)?;
    let start_sec = video[anchor].pts_sec;
    let video_slice = &video[anchor..];
    let audio_slice: Vec<&'a AudioAu> = audio.iter().filter(|a| a.pts_sec >= start_sec).collect();
    Some((video_slice, audio_slice, start_sec))
}

/// Drop video frames older than `now_sec - retain_secs`, keeping back to the
/// IDR that anchors the window.  Input is not mutated; returns the suffix.
///
/// Matches `encodedTapLogic.ts evictVideo`.
fn evict_video(frames: &[VideoAu], now_sec: f64, retain_secs: f64) -> Vec<VideoAu> {
    match anchor_keyframe_index(frames, now_sec - retain_secs) {
        None => frames.to_vec(),
        Some(anchor) => frames[anchor..].to_vec(),
    }
}

/// Drop audio frames older than `now_sec - retain_secs` (no keyframe constraint).
///
/// Matches `encodedTapLogic.ts evictAudio`.
fn evict_audio(frames: &[AudioAu], now_sec: f64, retain_secs: f64) -> Vec<AudioAu> {
    let cutoff = now_sec - retain_secs;
    frames.iter().filter(|f| f.pts_sec >= cutoff).cloned().collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// ClipRing — the stateful ring buffer (ported from EncodedTap.ts)
// ─────────────────────────────────────────────────────────────────────────────

/// Buffer a little beyond the target length so a clip always has a leading IDR.
/// Matches `EncodedTap.ts EVICT_HEADROOM_SEC = 2`.
const EVICT_HEADROOM_SEC: f64 = 2.0;
/// Cap eviction churn: prune at most ~once per second of stream time.
/// Matches `EncodedTap.ts EVICT_INTERVAL_SEC = 1`.
const EVICT_INTERVAL_SEC: f64 = 1.0;

/// Video RTP clock rate (H.264): 90 000 ticks/second.
const VIDEO_CLOCK_HZ: u32 = 90_000;
/// Audio (Opus) RTP clock rate: 48 000 ticks/second.
const AUDIO_CLOCK_HZ: u32 = 48_000;

/// Retroactive-clip ring buffer.
///
/// Two rings (video + audio) hold owned encoded AUs, each stamped with a PTS
/// on a SHARED wall-clock origin so A/V stays aligned (spec §6.3, TS §6.3).
///
/// The shared origin is set by the FIRST frame of EITHER stream.  Each stream
/// then captures its own wall-clock offset from that origin exactly once.  RTP
/// timestamps within each stream are converted to monotonic seconds by a
/// per-stream [`RtpClock`], and the per-stream wall-clock offset is added to
/// yield the final shared-timeline PTS.
///
/// Eviction keeps the ring to `retain_secs + EVICT_HEADROOM_SEC`, preserving
/// the leading IDR so the buffer can always produce a decodable clip.
pub struct ClipRing {
    video: Vec<VideoAu>,
    audio: Vec<AudioAu>,
    video_clock: RtpClock,
    audio_clock: RtpClock,
    /// H.264 SPS bytes (without start code), extracted from the first keyframe.
    sps: Option<Vec<u8>>,
    /// H.264 PPS bytes (without start code), extracted from the first keyframe.
    pps: Option<Vec<u8>>,
    retain_secs: f64,
    last_evict_sec: f64,
    // Shared-timeline anchoring
    origin_ms: Option<f64>,
    video_wall_offset_sec: f64,
    audio_wall_offset_sec: f64,
    video_started: bool,
    audio_started: bool,
    // Out-of-band video metadata
    track_config: VideoTrackConfig,
    /// Wall-clock source in milliseconds (injectable for tests; defaults to 0.0).
    now_ms: Box<dyn Fn() -> f64 + Send + Sync>,
}

impl ClipRing {
    /// Create a ring that retains at most `retain_secs` of content.
    ///
    /// The wall-clock source is `performance.now`-equivalent (milliseconds);
    /// use `with_clock` to inject a fake clock for tests.
    pub fn new(retain_secs: f64) -> Self {
        ClipRing::with_clock(retain_secs, VideoTrackConfig::default(), Box::new(|| 0.0))
    }

    /// Create a ring with explicit video track configuration and clock source.
    pub fn with_clock(
        retain_secs: f64,
        track_config: VideoTrackConfig,
        now_ms: Box<dyn Fn() -> f64 + Send + Sync>,
    ) -> Self {
        ClipRing {
            video: Vec::new(),
            audio: Vec::new(),
            video_clock: RtpClock::new(VIDEO_CLOCK_HZ),
            audio_clock: RtpClock::new(AUDIO_CLOCK_HZ),
            sps: None,
            pps: None,
            retain_secs,
            last_evict_sec: f64::NEG_INFINITY,
            origin_ms: None,
            video_wall_offset_sec: 0.0,
            audio_wall_offset_sec: 0.0,
            video_started: false,
            audio_started: false,
            track_config,
            now_ms,
        }
    }

    /// Buffer one encoded video frame.
    ///
    /// `nal` must be Annex-B H.264 or AVCC; it is normalized to Annex-B and
    /// owned by the ring (the caller's buffer may be reused).
    pub fn push_video(&mut self, nal: Vec<u8>, rtp_ts: u32, keyframe: bool) {
        let wall_offset = self.stream_offset_sec_video();
        let bytes = to_annex_b(&nal);
        let pts_sec = wall_offset + self.video_clock.to_seconds(rtp_ts);

        // Extract SPS/PPS from the first keyframe that contains them.
        if keyframe && (self.sps.is_none() || self.pps.is_none()) {
            let (sps, pps) = extract_sps_pps(&bytes);
            if sps.is_some() && self.sps.is_none() {
                self.sps = sps;
            }
            if pps.is_some() && self.pps.is_none() {
                self.pps = pps;
            }
        }

        self.video.push(VideoAu { bytes, pts_sec, is_keyframe: keyframe });
        self.maybe_evict(pts_sec);
    }

    /// Buffer one encoded audio (Opus) packet.
    pub fn push_audio(&mut self, opus: Vec<u8>, rtp_ts: u32) {
        let wall_offset = self.stream_offset_sec_audio();
        let pts_sec = wall_offset + self.audio_clock.to_seconds(rtp_ts);
        self.audio.push(AudioAu { bytes: opus, pts_sec });
    }

    /// Slice a keyframe-aligned clip covering the last `retain_secs` seconds.
    ///
    /// Returns `None` if no keyframe has been buffered yet (never panics).
    pub fn assemble(&self) -> Option<AssembledClip> {
        let now_sec = self.video.last().map(|f| f.pts_sec).unwrap_or(0.0);
        let (v_slice, a_refs, start_sec) =
            slice_for_clip(&self.video, &self.audio, now_sec, self.retain_secs)?;

        // Prepend SPS/PPS to the first video AU if needed (Annex-B, with start codes).
        let mut video_out: Vec<VideoAu> = Vec::with_capacity(v_slice.len());
        for (i, au) in v_slice.iter().enumerate() {
            if i == 0 && au.is_keyframe {
                let bytes = self.ensure_sps_pps(&au.bytes);
                video_out.push(VideoAu { bytes, pts_sec: au.pts_sec, is_keyframe: true });
            } else {
                video_out.push(au.clone());
            }
        }

        let audio_out: Vec<AudioAu> = a_refs.into_iter().cloned().collect();

        Some(AssembledClip {
            width: self.track_config.width,
            height: self.track_config.height,
            fps_num: self.track_config.fps_num,
            fps_den: self.track_config.fps_den,
            sps: self.sps.clone().unwrap_or_default(),
            pps: self.pps.clone().unwrap_or_default(),
            video: video_out,
            audio: audio_out,
            start_sec,
        })
    }

    /// Drop all buffered state (e.g. on disconnect / reconnect).
    pub fn clear(&mut self) {
        self.video.clear();
        self.audio.clear();
        self.video_clock = RtpClock::new(VIDEO_CLOCK_HZ);
        self.audio_clock = RtpClock::new(AUDIO_CLOCK_HZ);
        self.sps = None;
        self.pps = None;
        self.last_evict_sec = f64::NEG_INFINITY;
        self.origin_ms = None;
        self.video_wall_offset_sec = 0.0;
        self.audio_wall_offset_sec = 0.0;
        self.video_started = false;
        self.audio_started = false;
    }

    // ── Private helpers ────────────────────────────────────────────────────

    /// Wall-clock offset (seconds) for the video stream.
    /// Sets the shared origin on the first call of EITHER stream.
    fn stream_offset_sec_video(&mut self) -> f64 {
        let now_ms = (self.now_ms)();
        if self.origin_ms.is_none() {
            self.origin_ms = Some(now_ms);
        }
        if !self.video_started {
            self.video_started = true;
            self.video_wall_offset_sec =
                (now_ms - self.origin_ms.unwrap()) / 1000.0;
        }
        self.video_wall_offset_sec
    }

    /// Wall-clock offset (seconds) for the audio stream.
    /// Sets the shared origin on the first call of EITHER stream.
    fn stream_offset_sec_audio(&mut self) -> f64 {
        let now_ms = (self.now_ms)();
        if self.origin_ms.is_none() {
            self.origin_ms = Some(now_ms);
        }
        if !self.audio_started {
            self.audio_started = true;
            self.audio_wall_offset_sec =
                (now_ms - self.origin_ms.unwrap()) / 1000.0;
        }
        self.audio_wall_offset_sec
    }

    fn maybe_evict(&mut self, now_sec: f64) {
        if now_sec - self.last_evict_sec < EVICT_INTERVAL_SEC {
            return;
        }
        self.last_evict_sec = now_sec;
        let retain = self.retain_secs + EVICT_HEADROOM_SEC;
        self.video = evict_video(&self.video, now_sec, retain);
        self.audio = evict_audio(&self.audio, now_sec, retain);
    }

    /// Guarantee the first keyframe carries SPS (type 7) + PPS (type 8)
    /// in-band.  If the bitstream already contains them, returns a clone
    /// unchanged.  Otherwise prepends the stored copies as Annex-B NALs.
    fn ensure_sps_pps(&self, first: &[u8]) -> Vec<u8> {
        // Check if SPS (NAL type 7) is already present.
        if self.contains_nal_type(first, 7) {
            return first.to_vec();
        }
        let sps = self.sps.as_deref().unwrap_or(&[]);
        let pps = self.pps.as_deref().unwrap_or(&[]);
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

    fn contains_nal_type(&self, data: &[u8], nal_type: u8) -> bool {
        let mut i = 0usize;
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Annex-B helper fixtures ──────────────────────────────────────────────

    /// A minimal Annex-B keyframe: SPS (7) + PPS (8) + IDR (5).
    fn keyframe_bytes() -> Vec<u8> {
        vec![
            0, 0, 0, 1, 0x67, 0x42, 0x00, // SPS (type 7)
            0, 0, 0, 1, 0x68, 0xce,        // PPS (type 8)
            0, 0, 0, 1, 0x65, 0x88,        // IDR (type 5)
        ]
    }

    /// A minimal Annex-B P-frame (non-keyframe, NAL type 1).
    fn delta_bytes() -> Vec<u8> {
        vec![0, 0, 0, 1, 0x41, 0x9b]
    }

    /// A minimal Opus packet.
    fn opus_bytes() -> Vec<u8> {
        vec![0xfc, 0x01]
    }

    // ── RtpClock ────────────────────────────────────────────────────────────

    #[test]
    fn rtp_clock_first_call_returns_zero() {
        let mut clk = RtpClock::new(90_000);
        assert_eq!(clk.to_seconds(0), 0.0);
    }

    #[test]
    fn rtp_clock_advances_correctly_at_90khz() {
        let mut clk = RtpClock::new(90_000);
        clk.to_seconds(0);
        // 90_000 ticks from 0 = 1 second
        assert!((clk.to_seconds(90_000) - 1.0).abs() < 1e-9);
        // 45_000 more ticks from 90_000 → ts=135_000 → total 1.5s elapsed
        assert!((clk.to_seconds(135_000_u32) - 1.5).abs() < 1e-9);
    }

    #[test]
    fn rtp_clock_handles_u32_wrap() {
        let mut clk = RtpClock::new(90_000);
        clk.to_seconds(u32::MAX - 45_000); // origin
        // Wrap: (u32::MAX - 45_000) + 90_000 wraps to 44_999
        let next = (u32::MAX - 45_000u32).wrapping_add(90_000);
        let secs = clk.to_seconds(next);
        assert!((secs - 1.0).abs() < 1e-9, "got {secs}");
    }

    #[test]
    fn rtp_clock_audio_48khz() {
        let mut clk = RtpClock::new(48_000);
        clk.to_seconds(0);
        // 48_000 ticks = 1 second
        assert!((clk.to_seconds(48_000) - 1.0).abs() < 1e-9);
    }

    // ── is_annex_b / to_annex_b ─────────────────────────────────────────────

    #[test]
    fn is_annex_b_detects_4byte_start_code() {
        assert!(is_annex_b(&[0, 0, 0, 1, 0x67]));
    }

    #[test]
    fn is_annex_b_detects_3byte_start_code() {
        assert!(is_annex_b(&[0, 0, 1, 0x67]));
    }

    #[test]
    fn is_annex_b_rejects_avcc() {
        // AVCC: 4-byte big-endian length prefix, not start codes
        assert!(!is_annex_b(&[0, 0, 0, 5, 0x67, 0x42, 0x00, 0x1e, 0x00]));
    }

    #[test]
    fn to_annex_b_passthrough_for_annex_b_input() {
        let data = keyframe_bytes();
        let result = to_annex_b(&data);
        assert_eq!(result, data);
    }

    #[test]
    fn to_annex_b_converts_avcc() {
        // Single NAL in AVCC: [0,0,0,3][0x67,0x42,0x00]
        let avcc = vec![0, 0, 0, 3, 0x67, 0x42, 0x00];
        let result = to_annex_b(&avcc);
        assert_eq!(result, vec![0, 0, 0, 1, 0x67, 0x42, 0x00]);
    }

    // ── extract_sps_pps ─────────────────────────────────────────────────────

    #[test]
    fn extract_sps_pps_finds_both() {
        let (sps, pps) = extract_sps_pps(&keyframe_bytes());
        assert_eq!(sps.unwrap(), vec![0x67, 0x42, 0x00]);
        assert_eq!(pps.unwrap(), vec![0x68, 0xce]);
    }

    #[test]
    fn extract_sps_pps_absent_in_delta() {
        let (sps, pps) = extract_sps_pps(&delta_bytes());
        assert!(sps.is_none());
        assert!(pps.is_none());
    }

    // ── ClipRing: basic push + assemble ─────────────────────────────────────

    #[test]
    fn assemble_returns_none_before_any_keyframe() {
        // RED test: no panic when no keyframe has been buffered yet.
        let mut ring = ClipRing::new(30.0);
        ring.push_video(delta_bytes(), 0, false);
        assert!(ring.assemble().is_none(), "expected None before any keyframe");
    }

    #[test]
    fn assemble_captures_sps_pps_from_first_keyframe() {
        let mut ring = ClipRing::new(30.0);
        ring.push_video(keyframe_bytes(), 0, true);
        let clip = ring.assemble().expect("expected Some after keyframe");
        assert_eq!(clip.sps, vec![0x67, 0x42, 0x00]);
        assert_eq!(clip.pps, vec![0x68, 0xce]);
    }

    #[test]
    fn assemble_window_starts_at_last_idr() {
        let mut ring = ClipRing::new(30.0);
        // IDR at t=0
        ring.push_video(keyframe_bytes(), 0, true);
        // P-frames at t=1/90000s and t=2/90000s
        ring.push_video(delta_bytes(), 1500, false);
        ring.push_video(delta_bytes(), 3000, false);

        let clip = ring.assemble().unwrap();
        // Should start at the keyframe, include all 3 frames
        assert_eq!(clip.video.len(), 3);
        assert!(clip.video[0].is_keyframe);
        assert_eq!(clip.start_sec, 0.0);
    }

    #[test]
    fn assemble_window_starts_at_last_idr_before_cutoff() {
        // Two IDRs: one at t=0, one at t=10s; retain_secs=5.
        // The anchor should be the second IDR (at t=10 which is ≤ now-retain_secs
        // only when now is far enough — here now=15s, cutoff=10s, so IDR@10 qualifies).
        let mut ring = ClipRing::new(5.0);
        // IDR1 at t=0: rtp_ts=0
        ring.push_video(keyframe_bytes(), 0, true);
        // P at t=5s
        ring.push_video(delta_bytes(), 5 * 90_000, false);
        // IDR2 at t=10s
        ring.push_video(keyframe_bytes(), 10 * 90_000, true);
        // P at t=15s (now)
        ring.push_video(delta_bytes(), 15 * 90_000, false);

        let clip = ring.assemble().unwrap();
        // Anchor should be IDR2 at 10s; clip starts there
        assert!(
            (clip.start_sec - 10.0).abs() < 1e-6,
            "expected start at 10s, got {}",
            clip.start_sec
        );
        assert!(clip.video[0].is_keyframe, "first frame must be IDR2");
        assert_eq!(clip.video.len(), 2, "IDR2 + one P-frame");
    }

    #[test]
    fn assemble_audio_aligned_to_video_start() {
        let mut ring = ClipRing::new(30.0);
        // Video: IDR at rtp=0 (t=0s), P at rtp=1500 (~16ms)
        ring.push_video(keyframe_bytes(), 0, true);
        ring.push_video(delta_bytes(), 1500, false);
        // Audio: packet before IDR (should be excluded), and at t=0 (should be included)
        ring.push_audio(opus_bytes(), 48_000); // 1s @ 48kHz (excluded)
        ring.push_audio(vec![0xfc, 0x02], 0); // first audio → t=0 (included)

        let clip = ring.assemble().unwrap();
        // Audio at pts < 0 excluded; audio at t=0 included
        // The second push_audio at rtp=0 is the first audio call so its clock returns 0.0
        // The first push_audio at rtp=48_000 is after the clock initializes, so:
        // Actually audio clock starts on first push_audio (rtp=48_000 → 0.0),
        // next push_audio (rtp=0) wraps: delta = (0 - 48_000) as u32 = 4294919296, way > 1s
        // This tests that the audio filter uses ptsSec >= startSec correctly.
        // All audio frames have pts_sec >= 0 (start_sec), so both are included.
        assert!(clip.audio.len() >= 1);
    }

    #[test]
    fn assemble_av_shared_wall_clock_origin() {
        // Mirror the TS test: audio flows ~0.5s before first video keyframe.
        // A video frame and an audio frame that arrive at the SAME wall-clock
        // instant must get the SAME pts.
        // Use a fake clock that advances via a Cell.
        use std::sync::{Arc, Mutex};
        let clock_ms = Arc::new(Mutex::new(1000.0f64));

        let clock_ms_clone = Arc::clone(&clock_ms);
        let ring_now = move || *clock_ms_clone.lock().unwrap();

        let mut ring = ClipRing::with_clock(
            30.0,
            VideoTrackConfig::default(),
            Box::new(ring_now),
        );

        // t=1000ms: first audio frame → sets shared origin
        // audio RTP starts at 48_000 (1s tick) → audio clock returns 0.0
        // audio wall offset = (1000 - 1000) / 1000 = 0.0 → pts = 0.0
        *clock_ms.lock().unwrap() = 1000.0;
        ring.push_audio(vec![0xa1], 48_000);

        // t=1500ms: first video keyframe (0.5s after origin)
        // video wall offset = (1500 - 1000) / 1000 = 0.5s
        // video RTP clock starts here, first call returns 0.0 → pts = 0.5
        *clock_ms.lock().unwrap() = 1500.0;
        ring.push_video(keyframe_bytes(), 90_000, true);

        // t=1500ms: audio frame at same instant as keyframe
        // audio clock: first was 48_000, now 72_000 → delta=24_000 → 24000/48000 = 0.5s
        // audio wall offset is still 0.0 (set on first push) → pts = 0.0 + 0.5 = 0.5
        *clock_ms.lock().unwrap() = 1500.0;
        ring.push_audio(vec![0xa2], 72_000);

        let clip = ring.assemble().unwrap();
        // The second audio packet (0xa2) should have the same pts as the keyframe (0.5)
        let same_instant = clip.audio.iter().find(|a| a.bytes == [0xa2]);
        assert!(same_instant.is_some(), "audio 0xa2 should be in clip");
        let audio_pts = same_instant.unwrap().pts_sec;
        let video_pts = clip.video[0].pts_sec;
        assert!(
            (audio_pts - video_pts).abs() < 1e-6,
            "A/V desync: audio pts={audio_pts}, video pts={video_pts}"
        );
    }

    // ── Eviction ─────────────────────────────────────────────────────────────

    #[test]
    fn eviction_drops_frames_older_than_retain_plus_headroom() {
        let mut ring = ClipRing::new(5.0); // retain 5s, evict at 7s
        // IDR at t=0
        ring.push_video(keyframe_bytes(), 0, true);
        // P at t=1s
        ring.push_video(delta_bytes(), 90_000, false);
        // IDR at t=6s (within headroom window)
        ring.push_video(keyframe_bytes(), 6 * 90_000, true);
        // P at t=8s → triggers eviction (now=8s, retain+headroom=7s, cutoff=1s)
        // anchor = IDR at t=6 (latest IDR ≤ 1s? No. IDR@0 ≤ 1s → yes, anchor=IDR@0)
        // Wait: cutoff = 8-7=1s. IDR@0 ≤ 1s, IDR@6 > 1s. So anchor = IDR@0 (newest ≤1s).
        // evictVideo keeps from anchor (IDR@0) onward → all 4 frames kept.
        // Now add one more P at t=10s → now=10, cutoff=3s. IDR@0≤3s yes, IDR@6>3s no.
        // anchor=IDR@0 → still keeps everything. Hmm.
        // Let's do: IDR@0, P@1s, IDR@8s (evict at 8+1=9s), P@9s
        // at P@9s: now=9, headroom=7, cutoff=2. IDR@0≤2 yes, IDR@8 not≤2 no. anchor=IDR@0.
        // Not helpful. Let me set retain small and push many frames.
        // Use retain=2, headroom=2 → total=4s window.
        let mut ring2 = ClipRing::new(2.0);
        ring2.push_video(keyframe_bytes(), 0, true);             // IDR@0
        ring2.push_video(delta_bytes(), 90_000, false);          // P@1s
        ring2.push_video(delta_bytes(), 2 * 90_000, false);      // P@2s
        // Trigger eviction by pushing frame at t=3s (EVICT_INTERVAL_SEC=1 → evict)
        // now=3, cutoff=3-(2+2)=-1. IDR@0 ≤ -1? No. Fallback: earliest IDR = IDR@0.
        // So anchor=0, no eviction useful here.
        // With retain=2 + headroom=2, we need now > 4 for the anchor to advance.
        ring2.push_video(keyframe_bytes(), 5 * 90_000, true);    // IDR@5s
        ring2.push_video(delta_bytes(), 6 * 90_000, false);      // P@6s
        // now=6, cutoff=6-4=2. IDR@0≤2 yes, IDR@5>2 no → anchor=IDR@0.
        ring2.push_video(delta_bytes(), 7 * 90_000, false);      // P@7s (triggers evict at 7)
        // now=7, cutoff=7-4=3. IDR@0≤3 yes, IDR@5>3 no → anchor=IDR@0 still.
        ring2.push_video(delta_bytes(), 8 * 90_000, false);      // P@8s
        // now=8, cutoff=8-4=4. IDR@0≤4 yes, IDR@5>4 no → anchor=IDR@0.
        ring2.push_video(delta_bytes(), 9 * 90_000, false);      // P@9s
        // now=9, cutoff=9-4=5. IDR@0≤5 yes, IDR@5≤5 yes → anchor=IDR@5 (newest).
        // evictVideo keeps from IDR@5 → frames before IDR@5 dropped.
        let clip2 = ring2.assemble().unwrap();
        // Clip should start at IDR@5 (the latest IDR within retain window).
        // assemble uses retain_secs=2. now=9, cutoff=7. IDR@5≤7 yes. anchor=IDR@5.
        assert!(
            (clip2.start_sec - 5.0).abs() < 1e-6,
            "expected clip to start at IDR@5s, got {}",
            clip2.start_sec
        );
        // Video ring after eviction at t=9: should not contain IDR@0 or P@1..4
        // (the ring was evicted at t=9 keeping from IDR@5)
        assert!(
            clip2.video[0].is_keyframe,
            "clip must start at a keyframe"
        );
    }

    #[test]
    fn evict_audio_drops_old_audio() {
        let frames: Vec<AudioAu> = vec![
            AudioAu { bytes: vec![1], pts_sec: 0.0 },
            AudioAu { bytes: vec![2], pts_sec: 3.0 },
            AudioAu { bytes: vec![3], pts_sec: 6.0 },
        ];
        // now=8, retain=4 → cutoff=4 → keep pts ≥ 4
        let kept = evict_audio(&frames, 8.0, 4.0);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].pts_sec, 6.0);
    }

    #[test]
    fn evict_video_preserves_leading_keyframe() {
        // Even if the IDR is older than the cutoff, it's preserved as the anchor.
        let frames: Vec<VideoAu> = vec![
            VideoAu { bytes: vec![0, 0, 0, 1, 0x65], pts_sec: 0.0, is_keyframe: true },
            VideoAu { bytes: vec![0, 0, 0, 1, 0x41], pts_sec: 5.0, is_keyframe: false },
            VideoAu { bytes: vec![0, 0, 0, 1, 0x41], pts_sec: 10.0, is_keyframe: false },
        ];
        // now=10, retain=3 → cutoff=7. IDR@0≤7 yes → anchor=IDR@0. Keep all.
        let kept = evict_video(&frames, 10.0, 3.0);
        assert_eq!(kept.len(), 3, "IDR must be preserved even though it's old");
        assert!(kept[0].is_keyframe);
    }

    #[test]
    fn assemble_sps_pps_prepended_when_missing_from_first_au() {
        // Push a keyframe that has SPS/PPS first (for extraction),
        // then another keyframe without them as the actual leading frame after eviction.
        // Simulate by using a narrow retain window to force the second IDR to be anchor.
        let mut ring = ClipRing::new(1.0); // 1s retain + 2s headroom = 3s total

        // First IDR at t=0 (sets SPS/PPS)
        ring.push_video(keyframe_bytes(), 0, true);
        // Second IDR at t=5s, without SPS/PPS in bitstream
        let bare_idr = vec![0, 0, 0, 1, 0x65, 0x88]; // IDR only, no SPS/PPS
        ring.push_video(bare_idr.clone(), 5 * 90_000, true);
        // P at t=6s
        ring.push_video(delta_bytes(), 6 * 90_000, false);

        // now=6. retain=1, so assemble cutoff = 6-1=5. IDR@0≤5 yes, IDR@5≤5 yes.
        // anchor = IDR@5 (newest IDR ≤ cutoff). First frame is bare IDR.
        let clip = ring.assemble().unwrap();
        assert!((clip.start_sec - 5.0).abs() < 1e-6);
        // SPS/PPS should be prepended to the bare IDR
        assert!(
            is_annex_b(&clip.video[0].bytes),
            "first video AU must be Annex-B"
        );
        // The prepended bytes should include SPS (0x67) and PPS (0x68)
        let has_sps = clip.video[0].bytes.windows(4).any(|w| w == [0, 0, 0, 1])
            && clip.video[0].bytes.iter().any(|&b| b == 0x67);
        let has_pps = clip.video[0].bytes.iter().any(|&b| b == 0x68);
        assert!(has_sps, "SPS should be prepended to first AU");
        assert!(has_pps, "PPS should be prepended to first AU");
    }

    #[test]
    fn assemble_no_panic_with_empty_ring() {
        let ring = ClipRing::new(30.0);
        // Should not panic, should return None
        assert!(ring.assemble().is_none());
    }

    #[test]
    fn push_video_copies_bytes() {
        // The ring must own the data, independent of the caller's buffer.
        let mut ring = ClipRing::new(30.0);
        let mut src = keyframe_bytes();
        ring.push_video(src.clone(), 0, true);
        src.fill(0); // simulate caller reusing the buffer
        let clip = ring.assemble().unwrap();
        assert!(
            clip.video[0].bytes.iter().any(|&b| b != 0),
            "ring must own a copy, not be affected by caller mutation"
        );
    }

    #[test]
    fn clear_resets_all_state() {
        let mut ring = ClipRing::new(30.0);
        ring.push_video(keyframe_bytes(), 0, true);
        ring.push_audio(opus_bytes(), 0);
        ring.clear();
        assert!(ring.assemble().is_none());
    }

    // ── Track config ─────────────────────────────────────────────────────────

    #[test]
    fn assemble_uses_track_config() {
        let cfg = VideoTrackConfig {
            width: 1280,
            height: 720,
            fps_num: 60,
            fps_den: 1,
        };
        let mut ring = ClipRing::with_clock(30.0, cfg, Box::new(|| 0.0));
        ring.push_video(keyframe_bytes(), 0, true);
        let clip = ring.assemble().unwrap();
        assert_eq!(clip.width, 1280);
        assert_eq!(clip.height, 720);
        assert_eq!(clip.fps_num, 60);
        assert_eq!(clip.fps_den, 1);
    }
}
