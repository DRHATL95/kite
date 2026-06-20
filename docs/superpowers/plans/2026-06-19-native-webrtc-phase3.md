# Native WebRTC Phase 3 — Decode Pipeline (software) + Audio — Implementation Plan

> **STATUS: ✅ CODE COMPLETE, ⬜ LIVE RUN PENDING (2026-06-19).** Tasks 3.1–3.4
> implemented via subagent-driven TDD with review; commits `172e07e..115da02`.
> 106 pure unit tests green; `cargo build --features native-webrtc` clean. Review
> caught + fixed a dropped `set_pts` (A/V-sync bug, Task 3.1) and dead over-gating
> in the engine (Task 3.4). **Task 3.5 — the live `XBOX_E2E` decode+audio run — is
> NOT done** (needs the Linux box + powered-on console + speakers). HW VA-API
> decode + zero-copy GPU output were **deferred to co-design with Phase 4** (see
> Decision 1). Resume by running the Task 3.5 live command, then start Phase 4.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase-2 engine's *received* encoded access units into *decoded* media — H.264 → CPU frames via ffmpeg (software), Opus → PCM via the `opus` crate, played through the speakers via `cpal` — so a live session decodes video frames and you can **hear** the Xbox, end to end on Linux.

**Architecture:** Two decoder adapters behind the existing media seams (`VideoDecoder`, `AudioDecoder` in `src/rtc/media/mod.rs`) plus an audio output sink. `FfmpegDecoder` decodes H.264 Annex-B to `DecodedFrame::Cpu` (I420). `OpusDecoder` decodes Opus packets to `AudioPcm`. `AudioSink` (cpal) plays PCM through a pure, unit-tested `AudioRing`. The Phase-2 `engine.rs` owns a `Box<dyn VideoDecoder>` + `Box<dyn AudioDecoder>` + the sink, feeding each received AU to the right decoder, emitting `FirstFrame` on the first *decoded* frame and a decoded-frame count in stats. Video frames are decoded-and-dropped for now (the renderer consumes them in **Phase 4**); audio is fully wired (decode → play).

**Tech Stack:** `ffmpeg-the-third` (software H.264 decode — proven in the Phase-0 spike), the `opus` crate (Opus decode), **`cpal`** (new — cross-platform audio output), tokio (engine). All behind the existing `native-webrtc` feature. Tests: fixture-based ffmpeg decode + Opus encode→decode round-trip (run under `--features native-webrtc`); a pure `AudioRing` unit test in the default build; a live `XBOX_E2E` decode+audio integration test.

**Spec / source of truth:** Master plan `docs/superpowers/plans/2026-06-19-native-rust-webrtc.md` §Phase 3; the live findings `docs/superpowers/specs/2026-06-19-native-webrtc-sdp-findings.md` (Xbox sends H.264 ≤L4.2 + Opus 48 kHz stereo; str0m emits **Annex-B** ready for ffmpeg); the Phase-0 spike `examples/rtc_spike.rs` (proven ffmpeg H.264 decode).

**Branch:** `feat/native-webrtc-linux` (continue).

---

## Decisions (locked for this phase)

1. **Software decode first; HW/VA-API deferred.** Phase 3 ships ffmpeg **software** H.264 decode (CPU I420 frames) + Opus + cpal — a complete, testable, shippable slice that unblocks Phase 4. **VA-API/NVDEC HW decode and the zero-copy `FramePixels::Gpu { texture }` path are deferred to a focused follow-up co-designed with the Phase-4 wgpu renderer** (zero-copy only pays off when a GPU renderer consumes the texture; ffmpeg hwaccel in Rust is a separate de-risk). Software 1080p60 decode is proven (the spike) and fine for a first version on a desktop.
2. **CPU frames only.** Decoders output `DecodedFrame::Cpu { format: I420, planes, strides }`. The `Gpu` variant is **not** added this phase.
3. **Video decodes-and-drops; audio plays.** With no renderer yet (Phase 4), decoded video frames are counted + the first emits `FirstFrame`, then dropped. Audio is fully wired: decode → `AudioSink` → speakers. So Phase 3's tangible win is **hearing the Xbox**; video display is Phase 4.
4. **`Stats.frames_decoded` now means truly decoded frames** (was "received AUs" in Phase 2). `FirstFrame` now fires on the first *decoded* frame, not the first received AU. This is the intended Phase-3 refinement noted in `mod.rs`.
5. **Decode runs on the engine thread, inline in the event loop.** Feeding an AU + polling frames is cheap relative to the 16 ms frame budget; no separate decode thread this phase (revisit if the live test shows the loop starving). The cpal callback runs on its own audio thread (cpal-managed) and only drains the lock-free-ish `AudioRing`.
6. **Feature-gated tests.** ffmpeg/opus decode tests need the codec libs, so they run under `cargo test --features native-webrtc` (not the default 103). Only the pure `AudioRing` test runs in the default build.

---

## File Structure

```
src/rtc/media/
  mod.rs            MODIFY  — declare the new gated submodules; (seam types unchanged)
  decode_ffmpeg.rs  CREATE  — FfmpegDecoder: H.264 Annex-B → DecodedFrame::Cpu(I420). Gated.
  decode_opus.rs    CREATE  — OpusDecoder: Opus packet → AudioPcm (48k stereo). Gated.
  audio_sink.rs     CREATE  — AudioRing (PURE, default-build, TDD) + CpalSink (gated, cpal).
src/rtc/engine.rs   MODIFY  — own the decoders + sink; decode received AUs; FirstFrame on
                              first decoded frame; decoded-frame count in Stats.
src/rtc/mod.rs      (no change expected — RtcEvent/StatsSnapshot already fit)
tests/
  fixtures/test_h264.h264   CREATE — tiny Annex-B clip (generated via ffmpeg CLI) for the
                                     offline FfmpegDecoder test.
  rtc_decode.rs     CREATE  — gated unit/fixture tests entrypoint? NO — keep decoder tests
                              inline in their modules; this file is unused (delete from plan).
  rtc_e2e.rs        MODIFY  — extend the live test: assert ≥N *decoded* frames + audio ran.
Cargo.toml          MODIFY  — add `cpal` to the native-webrtc feature (optional dep).
```

> One shippable slice: a live session that decodes video frames and plays audio. The decoder adapters are independently testable (fixture / round-trip); the integration is proven by the live test.

---

## Task 3.1: `FfmpegDecoder` — H.264 Annex-B → `DecodedFrame::Cpu(I420)`

**Files:**
- Create: `src/rtc/media/decode_ffmpeg.rs`
- Create: `tests/fixtures/test_h264.h264` (generated, committed)
- Modify: `src/rtc/media/mod.rs` (`#[cfg(feature = "native-webrtc")] mod decode_ffmpeg;`)
- Test: inline `#[cfg(test)] mod tests` in `decode_ffmpeg.rs` (gated)

Port the Phase-0 spike's proven ffmpeg decode into the `VideoDecoder` seam, emitting I420 planes instead of RGB.

- [ ] **Step 1: Generate the test fixture** (a 2-frame 320×240 H.264 Annex-B clip; deterministic, a few KB):

```bash
mkdir -p tests/fixtures
ffmpeg -y -f lavfi -i testsrc=size=320x240:rate=1 -frames:v 2 \
  -c:v libx264 -profile:v baseline -pix_fmt yuv420p -bsf:v h264_mp4toannexb \
  -f h264 tests/fixtures/test_h264.h264
ls -l tests/fixtures/test_h264.h264   # expect a small (<50 KB) file
```

- [ ] **Step 2: Add the module** to `src/rtc/media/mod.rs` (below the seam traits):

```rust
#[cfg(feature = "native-webrtc")]
mod decode_ffmpeg;
#[cfg(feature = "native-webrtc")]
pub use decode_ffmpeg::FfmpegDecoder;
```

- [ ] **Step 3: Write the failing test** (`decode_ffmpeg.rs`, at the bottom):

```rust
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
        starts.windows(2).map(|w| buf[w[0]..w[1]].to_vec()).collect()
    }

    #[test]
    fn decodes_fixture_to_i420_frame() {
        let raw = std::fs::read("tests/fixtures/test_h264.h264").expect("fixture present");
        let mut dec = FfmpegDecoder::new_h264().expect("decoder");

        let mut got: Option<crate::rtc::media::DecodedFrame> = None;
        for au in annexb_aus(&raw) {
            dec.feed(AccessUnit { data: &au, pts_micros: 0, keyframe: false }).unwrap();
            if let Some(f) = dec.poll() {
                got = Some(f);
                break;
            }
        }
        let f = got.expect("decoded at least one frame");
        assert_eq!(f.width, 320);
        assert_eq!(f.height, 240);
        match f.pixels {
            FramePixels::Cpu { format, planes, strides } => {
                assert_eq!(format, PixelFormat::I420);
                assert_eq!(planes.len(), 3, "Y/U/V");
                assert_eq!(strides, vec![320, 160, 160]);
                assert_eq!(planes[0].len(), 320 * 240); // Y full res
                assert_eq!(planes[1].len(), 160 * 120); // U quarter
                assert_eq!(planes[2].len(), 160 * 120); // V quarter
            }
        }
    }
}
```

- [ ] **Step 4: Run, verify it fails.** Run: `cargo test --features native-webrtc -p xbox-remote decode_ffmpeg` → FAIL (`FfmpegDecoder` undefined).

- [ ] **Step 5: Implement** `src/rtc/media/decode_ffmpeg.rs`:

```rust
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
        packet.set_pts(Some(au.pts_micros as i64));
        // EAGAIN-style "need more data" before the first keyframe is normal; only
        // surface a real send error.
        match self.decoder.send_packet(&packet) {
            Ok(()) => Ok(()),
            Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::util::error::EAGAIN => Ok(()),
            Err(e) => Err(RtcError::Decode(format!("send_packet: {e}"))),
        }
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
    let cw = wu.div_ceil(2); // chroma width
    let ch = hu.div_ceil(2); // chroma height

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
```

> NOTE: `RtcError::Decode(String)` already exists in `src/rtc/mod.rs`. `div_ceil` is stable on `usize` (Rust ≥1.73). The `ffmpeg::Error::Other { errno }` / `EAGAIN` match: if the exact variant path differs in ffmpeg-the-third 5.x, fall back to ignoring all `send_packet` errors that are non-fatal — but try the precise match first (`cargo build --features native-webrtc` will tell you the right path; the spike just did `let _ = send_packet(...)`, which is also acceptable if the match is awkward).

- [ ] **Step 6: Run, verify pass.** Run: `cargo test --features native-webrtc decode_ffmpeg` → PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/rtc/media/decode_ffmpeg.rs src/rtc/media/mod.rs tests/fixtures/test_h264.h264
git commit -m "feat(rtc): FfmpegDecoder — software H.264 → I420 CPU frames (fixture TDD)"
```

---

## Task 3.2: `OpusDecoder` — Opus packet → `AudioPcm`

**Files:**
- Create: `src/rtc/media/decode_opus.rs`
- Modify: `src/rtc/media/mod.rs` (`#[cfg(feature = "native-webrtc")] mod decode_opus;`)
- Test: inline gated tests (Opus encode→decode round-trip)

- [ ] **Step 1: Add the module** to `src/rtc/media/mod.rs`:

```rust
#[cfg(feature = "native-webrtc")]
mod decode_opus;
#[cfg(feature = "native-webrtc")]
pub use decode_opus::OpusDecoder;
```

- [ ] **Step 2: Write the failing test** (`decode_opus.rs`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::rtc::media::AudioDecoder;
    use opus::{Application, Channels, Encoder};

    #[test]
    fn decodes_a_real_opus_packet_to_48k_stereo_pcm() {
        // Encode 20ms of 48kHz stereo silence → a valid Opus packet.
        let frame = 48_000 / 50; // 960 samples/channel for 20ms
        let pcm_in = vec![0i16; frame * 2]; // interleaved stereo
        let mut enc = Encoder::new(48_000, Channels::Stereo, Application::Audio).unwrap();
        let mut packet = vec![0u8; 4000];
        let n = enc.encode(&pcm_in, &mut packet).unwrap();
        packet.truncate(n);

        let mut dec = OpusDecoder::new_48k_stereo().unwrap();
        let pcm = dec.decode(&packet, 123).unwrap();
        assert_eq!(pcm.sample_rate, 48_000);
        assert_eq!(pcm.channels, 2);
        assert_eq!(pcm.pts_micros, 123);
        assert_eq!(pcm.samples.len(), frame * 2); // 960 stereo frames → 1920 i16
    }
}
```

- [ ] **Step 3: Run → FAIL.** Run: `cargo test --features native-webrtc decode_opus` → FAIL.

- [ ] **Step 4: Implement** `src/rtc/media/decode_opus.rs`:

```rust
//! Opus → PCM decoder adapter over the `opus` crate. Xbox sends Opus 48 kHz
//! stereo (see the SDP findings).

use opus::{Channels, Decoder};

use crate::rtc::media::{AudioDecoder, AudioPcm};
use crate::rtc::{Result, RtcError};

const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: u16 = 2;
/// Max samples a single Opus packet can yield per channel (120 ms @ 48 kHz).
const MAX_FRAME: usize = 5760;

pub struct OpusDecoder {
    decoder: Decoder,
}

impl OpusDecoder {
    pub fn new_48k_stereo() -> Result<Self> {
        let decoder = Decoder::new(SAMPLE_RATE, Channels::Stereo)
            .map_err(|e| RtcError::Decode(format!("opus decoder: {e}")))?;
        Ok(Self { decoder })
    }
}

impl AudioDecoder for OpusDecoder {
    fn decode(&mut self, packet: &[u8], pts_micros: u64) -> Result<AudioPcm> {
        let mut out = vec![0i16; MAX_FRAME * CHANNELS as usize];
        let frames = self
            .decoder
            .decode(packet, &mut out, false)
            .map_err(|e| RtcError::Decode(format!("opus decode: {e}")))?;
        out.truncate(frames * CHANNELS as usize); // `frames` is per-channel
        Ok(AudioPcm {
            sample_rate: SAMPLE_RATE,
            channels: CHANNELS,
            pts_micros,
            samples: out,
        })
    }
}
```

- [ ] **Step 5: Run → PASS.** Run: `cargo test --features native-webrtc decode_opus` → PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/rtc/media/decode_opus.rs src/rtc/media/mod.rs
git commit -m "feat(rtc): OpusDecoder — Opus → 48k stereo PCM (round-trip TDD)"
```

---

## Task 3.3: `AudioSink` — pure `AudioRing` (TDD) + cpal playback

**Files:**
- Create: `src/rtc/media/audio_sink.rs`
- Modify: `src/rtc/media/mod.rs` (`mod audio_sink;` — ungated; the cpal parts inside are gated)
- Modify: `Cargo.toml` (add `cpal` to the `native-webrtc` feature)
- Test: inline `#[cfg(test)] mod tests` for the pure `AudioRing` (runs in the **default** build)

- [ ] **Step 1: Add the cpal dependency.** In `Cargo.toml`, add an optional dep and include it in the feature:

```toml
cpal = { version = "0.15", optional = true }
```

and extend the feature:

```toml
native-webrtc = ["dep:str0m", "dep:opus", "dep:ffmpeg-the-third", "dep:bytes", "dep:cpal"]
```

- [ ] **Step 2: Add the module** to `src/rtc/media/mod.rs`:

```rust
pub mod audio_sink;
```

- [ ] **Step 3: Write the failing test** for the pure ring (`audio_sink.rs`):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_pushes_and_drains_in_order() {
        let ring = AudioRing::new(8);
        ring.push(&[1, 2, 3, 4]);
        let mut out = [0i16; 2];
        ring.fill(&mut out);
        assert_eq!(out, [1, 2]);
        ring.fill(&mut out);
        assert_eq!(out, [3, 4]);
    }

    #[test]
    fn underrun_fills_silence() {
        let ring = AudioRing::new(8);
        ring.push(&[5]);
        let mut out = [9i16; 3];
        ring.fill(&mut out);
        assert_eq!(out, [5, 0, 0]); // one sample, rest silence
    }

    #[test]
    fn overflow_drops_oldest() {
        let ring = AudioRing::new(4); // capacity 4
        ring.push(&[1, 2, 3, 4, 5, 6]); // 6 > 4 → keep newest 4
        let mut out = [0i16; 4];
        ring.fill(&mut out);
        assert_eq!(out, [3, 4, 5, 6]);
    }
}
```

- [ ] **Step 4: Run → FAIL.** Run: `cargo test rtc::media::audio_sink` → FAIL (`AudioRing` undefined).

- [ ] **Step 5: Implement** `src/rtc/media/audio_sink.rs` (pure ring ungated; cpal sink gated):

```rust
//! Audio output: a pure, bounded sample ring (unit-tested in the default build)
//! drained by a cpal output stream (gated behind `native-webrtc`).

use std::collections::VecDeque;
use std::sync::Mutex;

/// A bounded interleaved-i16 sample ring. The decode side `push`es; the audio
/// callback `fill`s. On overflow the oldest samples are dropped (favor latency
/// over backlog); on underrun the tail is filled with silence.
pub struct AudioRing {
    buf: Mutex<VecDeque<i16>>,
    cap: usize,
}

impl AudioRing {
    pub fn new(cap: usize) -> Self {
        Self { buf: Mutex::new(VecDeque::with_capacity(cap)), cap }
    }

    pub fn push(&self, samples: &[i16]) {
        let mut buf = self.buf.lock().unwrap();
        buf.extend(samples.iter().copied());
        while buf.len() > self.cap {
            buf.pop_front();
        }
    }

    /// Fill `out` from the ring; any shortfall becomes silence (0).
    pub fn fill(&self, out: &mut [i16]) {
        let mut buf = self.buf.lock().unwrap();
        for slot in out.iter_mut() {
            *slot = buf.pop_front().unwrap_or(0);
        }
    }
}

#[cfg(feature = "native-webrtc")]
mod cpal_sink {
    use std::sync::Arc;

    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    use super::AudioRing;
    use crate::rtc::media::AudioPcm;
    use crate::rtc::{Result, RtcError};

    /// Plays 48 kHz stereo PCM through the default output device. Holds the cpal
    /// stream alive; `submit` pushes decoded PCM into the shared ring.
    pub struct AudioSink {
        ring: Arc<AudioRing>,
        _stream: cpal::Stream,
    }

    impl AudioSink {
        /// ~200 ms of 48 kHz stereo buffered (favor low latency).
        const RING_CAP: usize = 48_000 * 2 / 5;

        pub fn new() -> Result<Self> {
            let host = cpal::default_host();
            let device = host
                .default_output_device()
                .ok_or_else(|| RtcError::Decode("no audio output device".into()))?;
            let config = cpal::StreamConfig {
                channels: 2,
                sample_rate: cpal::SampleRate(48_000),
                buffer_size: cpal::BufferSize::Default,
            };
            let ring = Arc::new(AudioRing::new(Self::RING_CAP));
            let cb_ring = ring.clone();
            let stream = device
                .build_output_stream(
                    &config,
                    move |out: &mut [i16], _| cb_ring.fill(out),
                    |e| tracing::warn!("cpal stream error: {e}"),
                    None,
                )
                .map_err(|e| RtcError::Decode(format!("build audio stream: {e}")))?;
            stream
                .play()
                .map_err(|e| RtcError::Decode(format!("play audio stream: {e}")))?;
            Ok(Self { ring, _stream: stream })
        }

        pub fn submit(&self, pcm: &AudioPcm) {
            self.ring.push(&pcm.samples);
        }
    }
}

#[cfg(feature = "native-webrtc")]
pub use cpal_sink::AudioSink;
```

- [ ] **Step 6: Run → PASS** (default build). Run: `cargo test rtc::media::audio_sink` → 3 pass. Also confirm `cargo build --features native-webrtc` compiles the cpal sink.

- [ ] **Step 7: Commit.**

```bash
git add src/rtc/media/audio_sink.rs src/rtc/media/mod.rs Cargo.toml Cargo.lock
git commit -m "feat(rtc): audio sink — pure AudioRing (TDD) + cpal playback stream"
```

---

## Task 3.4: Wire decoders + audio sink into the engine

**Files:**
- Modify: `src/rtc/engine.rs`

The engine constructs the decoders + sink and feeds each received AU to the right one. Video: decode + count + `FirstFrame` on first decoded frame, then drop. Audio: decode → `sink.submit` (plays).

- [ ] **Step 1: Add imports + decoder/sink fields to the stream loop.** In `engine.rs`, at the top of `stream`, after `let mut seq = …`, construct the media pipeline:

```rust
use crate::rtc::media::{AccessUnit, AudioDecoder, FfmpegDecoder, OpusDecoder, VideoDecoder};
use crate::rtc::media::audio_sink::AudioSink;
// ...
let mut video_dec = FfmpegDecoder::new_h264().ok();
let mut audio_dec = OpusDecoder::new_48k_stereo().ok();
let audio_sink = AudioSink::new().ok(); // None if no output device — non-fatal
```

(Place the `use` lines at the module top with the other imports, not inside the fn.)

- [ ] **Step 2: Decode in `handle_event`.** The `Event::MediaData` arm must distinguish video (decode → frame) from audio (decode → play). `handle_event` needs access to the decoders/sink/audio_mid — thread them through (the `#[allow(clippy::too_many_arguments)]` is already present). Replace the current video-only `MediaData` arm:

```rust
Event::MediaData(data) => {
    if data.mid == video_mid {
        let au = AccessUnit {
            data: &data.data,
            pts_micros: media_time_micros(&data),
            keyframe: data.is_keyframe(),
        };
        if let Some(dec) = video_dec.as_mut() {
            if dec.feed(au).is_ok() {
                while let Some(_frame) = dec.poll() {
                    *frames += 1; // decoded-frame count (Phase 4 renders `_frame`)
                    if !*first_frame {
                        *first_frame = true;
                        let _ = event_tx.send(RtcEvent::FirstFrame);
                    }
                }
            }
        }
    } else if let (Some(dec), Some(sink)) = (audio_dec.as_mut(), audio_sink.as_ref()) {
        if let Ok(pcm) = dec.decode(&data.data, media_time_micros(&data)) {
            sink.submit(&pcm);
        }
    }
}
```

Add the `video_dec`, `audio_dec`, `audio_sink`, and `audio_mid` parameters to `handle_event`'s signature (and pass them at the call site in `stream`). Capture `audio_mid` in `connect` (the `add_media(Audio, …)` already returns a `Mid` — currently discarded; bind it and return it through the `connect` tuple → `stream`).

- [ ] **Step 3: Add the RTP-time helper** (bottom of `engine.rs`):

```rust
/// MediaData RTP media-time → microseconds (best-effort; real A/V sync is Phase 5).
fn media_time_micros(data: &str0m::media::MediaData) -> u64 {
    let t = data.time; // MediaTime: numerator/denominator
    let denom = t.denominator().max(1);
    (t.numerator().saturating_mul(1_000_000) / denom) as u64
}
```

> If `MediaTime`'s accessor names differ in str0m 0.20 (e.g. `numer()/denom()` or a `.as_micros()`/`.rebase()` helper), use whatever the compiler accepts — the exact value is best-effort this phase; `data.network_time` elapsed is an acceptable fallback. Confirm via `cargo doc -p str0m` or the source.

- [ ] **Step 4: Verify the feature build + default tests.**

Run: `cargo build --features native-webrtc` → success (fix any seam/`MediaData` API mismatches).
Run: `cargo test` → still 103 + the new pure `AudioRing` tests (= 106).

- [ ] **Step 5: Commit.**

```bash
git add src/rtc/engine.rs
git commit -m "feat(rtc): wire FfmpegDecoder + OpusDecoder + cpal sink into the engine"
```

---

## Task 3.5: Live decode + audio integration test

**Files:**
- Modify: `tests/rtc_e2e.rs`

Extend the live test so a passing run proves the stream actually **decodes** (not just receives) and that audio ran. `frames_decoded` now counts decoded frames, so the existing `>= 100` assertion already proves decode — make that intent explicit and add a short audio-played note.

- [ ] **Step 1: Update the assertion comment + threshold context.** In `tests/rtc_e2e.rs`, the loop already breaks on `last_frames >= 100`; keep it, and update the final asserts to make clear these are decoded frames:

```rust
    handle.disconnect();
    assert!(connected, "never reached Connected");
    assert!(first_frame, "never decoded a video frame");
    assert!(last_frames >= 100, "expected >=100 DECODED frames, got {last_frames}");
    // Audio: cpal played decoded Opus through the default device during the run
    // (no programmatic assertion — verified by ear; the engine logs submit errors).
```

- [ ] **Step 2: Run it live (interactive — needs the powered-on console + speakers).**

Run: `XBOX_E2E=1 XBOX_SERVER_ID=<id> cargo test --features native-webrtc --test rtc_e2e -- --nocapture`
Expected: PASS — ≥100 **decoded** 1080p frames; **you hear the Xbox dashboard audio**. **Pause and ask the human to power on the console (and unmute) before this step.**

- [ ] **Step 3: Commit.**

```bash
git add tests/rtc_e2e.rs
git commit -m "test(rtc): live decode+audio E2E (decoded frames + cpal playback)"
```

---

## Phase 3 Acceptance

- `cargo test` (no features): 103 prior + the pure `AudioRing` tests (= 106) green.
- `cargo test --features native-webrtc`: `FfmpegDecoder` fixture test + `OpusDecoder` round-trip green.
- `cargo build --features native-webrtc`: decoders + cpal sink compile.
- **Live** `XBOX_E2E`: ≥100 decoded 1080p frames; Opus audio plays through the speakers.

On green, the master-plan STATUS updates (Phase 3 ✅) and the next slice is **Phase 4 — Linux render**: a `VideoRenderer` that presents the decoded `DecodedFrame`s under the transparent HUD (wgpu/gtkglsink), at which point the deferred **HW VA-API decode + zero-copy `FramePixels::Gpu`** is co-designed with it. The engine already produces `DecodedFrame`s and emits `FirstFrame`; Phase 4 swaps the decode-and-drop for decode-and-present (a frame channel/callback to the renderer).

---

## Self-Review

- **Spec coverage (master §Phase 3):** H.264 decode ✅ (3.1, software — HW deferred w/ rationale); Opus decode ✅ (3.2); audio sink (Open Q #4 — cpal) ✅ (3.3); engine wiring ✅ (3.4); live 1080p decode ✅ (3.5). **Deferred with documented rationale:** VA-API/NVDEC HW path + zero-copy `FramePixels::Gpu` (Decision 1) → Phase 4 co-design. `XBOX_FORCE_SW_DECODE` toggle is moot this phase (software is the only path); it returns when HW lands.
- **Placeholder scan:** none — every code step is concrete. Two compiler-guided spots are flagged explicitly (the ffmpeg `EAGAIN` match path; the `MediaTime` accessor names) with a stated fallback, not a vague "handle it."
- **Type consistency:** `FfmpegDecoder::new_h264`, `OpusDecoder::new_48k_stereo`, `AudioSink::new`/`submit`, `AudioRing::{new,push,fill}` are defined in 3.1–3.3 and used unchanged in 3.4; `DecodedFrame`/`FramePixels::Cpu`/`PixelFormat::I420`/`AudioPcm`/`AccessUnit` are the existing `media/mod.rs` seam types; `RtcError::Decode` exists in `mod.rs`; `Stats.frames_decoded`/`RtcEvent::FirstFrame` reused from Phase 2 (semantics tightened per Decision 4).
- **Known follow-ups (not blockers):** real A/V sync (Phase 5 — `media_time_micros` is best-effort); decode-on-engine-thread may need a dedicated decode thread if the live loop starves (Decision 5); HW decode (deferred).
