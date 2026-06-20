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
        Self {
            buf: Mutex::new(VecDeque::with_capacity(cap)),
            cap,
        }
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
            Ok(Self {
                ring,
                _stream: stream,
            })
        }

        pub fn submit(&self, pcm: &AudioPcm) {
            self.ring.push(&pcm.samples);
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
    fn overflow_drops_oldest() {
        let ring = AudioRing::new(4);
        ring.push(&[1, 2, 3, 4, 5, 6]); // 6 > 4 → keep newest 4
        let mut out = [0i16; 4];
        ring.fill(&mut out);
        assert_eq!(out, [3, 4, 5, 6]);
    }
}
