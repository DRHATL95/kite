//! Audio output: a pure, bounded sample ring (unit-tested in the default build)
//! drained by a cpal output stream (gated behind `native-webrtc`).

use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

/// A bounded interleaved-i16 sample ring. The decode side `push`es; the audio
/// callback `fill`s. On overflow the oldest samples are dropped (favor latency
/// over backlog); on underrun the tail is filled with silence. `fill` applies a
/// per-output gain (volume), read lock-free from `gain`.
pub struct AudioRing {
    buf: Mutex<VecDeque<i16>>,
    cap: usize,
    /// Output gain as f32 bits; 1.0 = unity. Applied in `fill`.
    gain: AtomicU32,
}

impl AudioRing {
    pub fn new(cap: usize) -> Self {
        Self {
            buf: Mutex::new(VecDeque::with_capacity(cap)),
            cap,
            gain: AtomicU32::new(1.0_f32.to_bits()),
        }
    }

    /// Set the output gain. 0.0 = mute, 1.0 = unity; clamped to [0, 2].
    pub fn set_gain(&self, gain: f32) {
        self.gain
            .store(gain.clamp(0.0, 2.0).to_bits(), Ordering::Relaxed);
    }

    pub fn push(&self, samples: &[i16]) {
        let mut buf = self.buf.lock().unwrap();
        buf.extend(samples.iter().copied());
        while buf.len() > self.cap {
            buf.pop_front();
        }
    }

    /// Fill `out` from the ring (gain-scaled); any shortfall becomes silence (0).
    pub fn fill(&self, out: &mut [i16]) {
        let gain = f32::from_bits(self.gain.load(Ordering::Relaxed));
        let mut buf = self.buf.lock().unwrap();
        for slot in out.iter_mut() {
            let s = buf.pop_front().unwrap_or(0);
            *slot = if gain == 1.0 {
                s
            } else {
                (s as f32 * gain).clamp(i16::MIN as f32, i16::MAX as f32) as i16
            };
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
            // cpal 0.18: SampleRate is a plain `u32` alias, no longer a tuple struct.
            let config = cpal::StreamConfig {
                channels: 2,
                sample_rate: 48_000,
                buffer_size: cpal::BufferSize::Default,
            };
            let ring = Arc::new(AudioRing::new(Self::RING_CAP));
            let cb_ring = ring.clone();
            let stream = device
                // cpal 0.18 takes the config by value.
                .build_output_stream(
                    config,
                    move |out: &mut [i16], _| cb_ring.fill(out),
                    |e| tracing::warn!("cpal stream error: {e}"),
                    None,
                )
                .map_err(|e| RtcError::Decode(format!("build audio stream: {e}")))?;
            stream
                .play()
                .map_err(|e| RtcError::Decode(format!("play audio stream: {e}")))?;
            Ok(Self {
                ring,
                _stream: stream,
            })
        }

        pub fn submit(&self, pcm: &AudioPcm) {
            self.ring.push(&pcm.samples);
        }

        /// Set the playback volume (0.0 = mute, 1.0 = unity).
        pub fn set_volume(&self, gain: f32) {
            self.ring.set_gain(gain);
        }
    }
}

#[cfg(feature = "native-webrtc")]
pub use cpal_sink::AudioSink;

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
        assert_eq!(out, [5, 0, 0]);
    }

    #[test]
    fn gain_scales_samples_on_fill() {
        let ring = AudioRing::new(8);
        ring.set_gain(0.5);
        ring.push(&[100, -100]);
        let mut out = [0i16; 2];
        ring.fill(&mut out);
        assert_eq!(out, [50, -50]);
    }

    #[test]
    fn gain_zero_mutes_and_clamps_high_gain() {
        let muted = AudioRing::new(8);
        muted.set_gain(0.0);
        muted.push(&[1000, -2000]);
        let mut out = [0i16; 2];
        muted.fill(&mut out);
        assert_eq!(out, [0, 0]);

        // 2x gain on a near-max sample clamps to i16::MAX, not wrap.
        let loud = AudioRing::new(8);
        loud.set_gain(2.0);
        loud.push(&[20_000]);
        let mut one = [0i16; 1];
        loud.fill(&mut one);
        assert_eq!(one, [i16::MAX]);
    }

    #[test]
    fn overflow_drops_oldest() {
        let ring = AudioRing::new(4);
        ring.push(&[1, 2, 3, 4, 5, 6]); // 6 > 4 → keep newest 4
        let mut out = [0i16; 4];
        ring.fill(&mut out);
        assert_eq!(out, [3, 4, 5, 6]);
    }
}
