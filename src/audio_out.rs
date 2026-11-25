//! audio_out — plays the stream's audio from kite.exe itself (Windows).
//!
//! Discord's window share sends only the audio rendered by the shared window's
//! own process. WebView2 renders page audio in a child `msedgewebview2.exe`, so a
//! Kite window share went out silent. On Windows the page therefore taps the
//! stream's PCM (an AudioWorklet, `ui/src/lib/connection/nativeAudio.ts`) and
//! pushes it here, and a cpal stream owned by this process plays it.
//!
//! Wire format: interleaved 48 kHz stereo i16, little-endian, as a raw IPC body.
//! WASAPI converts to the device's mix format (cpal opens output streams with
//! AUTOCONVERTPCM), so no resampling happens here. Volume is applied in the
//! page's Web Audio graph before the tap, so the ring runs at unity gain.
//!
//! Every failure is reported to the page, which falls back to WebView2 playback:
//! audio must never stop because this path broke.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::State;

/// Managed state: the live player, if the page has started one.
#[derive(Default)]
pub struct AudioOut {
    #[cfg(windows)]
    player: std::sync::Mutex<Option<imp::Player>>,
}

#[cfg(windows)]
mod imp {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    use crate::rtc::media::audio_sink::AudioRing;

    const RATE: u32 = 48_000;
    const CHANNELS: u16 = 2;

    /// Interleaved samples in `ms` milliseconds of audio.
    const fn samples(ms: usize) -> usize {
        RATE as usize * CHANNELS as usize * ms / 1000
    }
    /// Held back before playing, and after any underrun, so IPC jitter (chunks
    /// arrive every ~10 ms, not on the device clock) costs no crackle.
    const PREBUFFER: usize = samples(30);
    /// Oldest samples drop past this, so a stall can't leave latency raised.
    const CAP: usize = samples(80);

    pub struct Player {
        ring: Arc<AudioRing>,
        failed: Arc<AtomicBool>,
        _stream: cpal::Stream,
    }

    impl Player {
        /// Open an output stream on the device named `device` (the label the
        /// page's picker shows: both read the endpoint's friendly name), or on
        /// the system default when it is empty or no longer present. A default
        /// stream follows Windows' default device as it changes.
        pub fn open(device: &str) -> Result<Self, String> {
            let host = cpal::default_host();
            let named = (!device.is_empty())
                .then(|| {
                    host.output_devices()
                        .ok()?
                        .find(|d| d.description().is_ok_and(|desc| desc.name() == device))
                })
                .flatten();
            if named.is_none() && !device.is_empty() {
                tracing::warn!("audio_out: device {device:?} not found, using default");
            }
            let dev = named
                .or_else(|| host.default_output_device())
                .ok_or("no audio output device")?;

            let config = cpal::StreamConfig {
                channels: CHANNELS,
                sample_rate: RATE,
                buffer_size: cpal::BufferSize::Default,
            };
            let ring = Arc::new(AudioRing::with_prebuffer(CAP, PREBUFFER));
            let failed = Arc::new(AtomicBool::new(false));
            let (cb_ring, cb_failed) = (ring.clone(), failed.clone());
            let stream = dev
                .build_output_stream(
                    config,
                    move |out: &mut [i16], _| cb_ring.fill(out),
                    move |e| {
                        tracing::warn!("audio_out: stream error: {e}");
                        cb_failed.store(true, Ordering::Relaxed);
                    },
                    None,
                )
                .map_err(|e| format!("build audio stream: {e}"))?;
            stream
                .play()
                .map_err(|e| format!("play audio stream: {e}"))?;
            Ok(Self {
                ring,
                failed,
                _stream: stream,
            })
        }

        pub fn push(&self, bytes: &[u8]) -> Result<(), String> {
            if self.failed.load(Ordering::Relaxed) {
                return Err("audio output stream failed".into());
            }
            self.ring.push(&decode_le_i16(bytes)?);
            Ok(())
        }
    }

    /// Little-endian i16 samples from a raw IPC body. Rejects a body that splits
    /// a stereo frame: a misaligned stream would swap channels for good.
    pub fn decode_le_i16(bytes: &[u8]) -> Result<Vec<i16>, String> {
        let frame = 2 * CHANNELS as usize;
        if !bytes.len().is_multiple_of(frame) {
            return Err(format!(
                "audio chunk of {} bytes splits a frame",
                bytes.len()
            ));
        }
        Ok(bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&b| i16::from_le_bytes(b))
            .collect())
    }
}

/// Start (or restart on `device`) native playback. Resolves `false` where this
/// platform has no native path, so the page keeps playing audio itself.
#[tauri::command]
pub async fn audio_out_start(state: State<'_, AudioOut>, device: String) -> Result<bool, String> {
    #[cfg(windows)]
    {
        // Drop the old stream before opening the next, so two never overlap.
        let mut player = state.player.lock().map_err(|e| e.to_string())?;
        *player = None;
        *player = Some(imp::Player::open(&device)?);
        tracing::info!("audio_out: native playback started ({device:?})");
        Ok(true)
    }
    #[cfg(not(windows))]
    {
        let _ = (state, device);
        Ok(false)
    }
}

/// Queue one raw chunk of PCM (see the module docs for the format).
#[tauri::command]
pub async fn audio_out_push(
    request: tauri::ipc::Request<'_>,
    state: State<'_, AudioOut>,
) -> Result<(), String> {
    let bytes: std::borrow::Cow<[u8]> = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.into(),
        // After any failed custom-protocol fetch, Tauri's IPC script switches to
        // postMessage for the rest of the session, and that path sends a byte
        // buffer as a JSON array of numbers. Slower, but audio keeps flowing.
        tauri::ipc::InvokeBody::Json(v) => {
            static WARNED: AtomicBool = AtomicBool::new(false);
            if !WARNED.swap(true, Ordering::Relaxed) {
                tracing::warn!("audio_out: IPC fell back to postMessage; audio arrives as JSON");
            }
            serde_json::from_value::<Vec<u8>>(v.clone())
                .map_err(|e| format!("audio body: {e}"))?
                .into()
        }
    };
    #[cfg(windows)]
    {
        let player = state.player.lock().map_err(|e| e.to_string())?;
        player
            .as_ref()
            .ok_or("audio output not started")?
            .push(&bytes)
    }
    #[cfg(not(windows))]
    {
        let _ = (bytes, state);
        Err("native audio output is Windows-only".into())
    }
}

/// Stop native playback (stream end, or the page fell back).
#[tauri::command]
pub async fn audio_out_stop(state: State<'_, AudioOut>) -> Result<(), String> {
    #[cfg(windows)]
    if let Some(p) = state.player.lock().map_err(|e| e.to_string())?.take() {
        drop(p);
        tracing::info!("audio_out: native playback stopped");
    }
    #[cfg(not(windows))]
    let _ = state;
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::imp::decode_le_i16;

    #[test]
    fn decodes_little_endian_samples_in_order() {
        let bytes = [0x01, 0x00, 0xff, 0xff, 0x00, 0x80, 0xff, 0x7f];
        assert_eq!(decode_le_i16(&bytes).unwrap(), [1, -1, i16::MIN, i16::MAX]);
    }

    #[test]
    fn rejects_a_chunk_that_splits_a_stereo_frame() {
        assert!(decode_le_i16(&[0; 6]).is_err());
        assert!(decode_le_i16(&[]).unwrap().is_empty());
    }
}
