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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rtc::media::AudioDecoder;
    use opus::{Application, Channels, Encoder};

    #[test]
    fn decodes_a_real_opus_packet_to_48k_stereo_pcm() {
        // Encode 20ms of 48kHz stereo with a non-trivial signal (ramp) to avoid
        // any DTX edge case that might produce an unexpectedly short frame.
        let frame = 48_000 / 50; // 960 samples/channel for 20ms
        let pcm_in: Vec<i16> = (0..frame * 2)
            .map(|i| (i as i16).wrapping_mul(32))
            .collect();
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
