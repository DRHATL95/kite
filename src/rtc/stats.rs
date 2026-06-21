//! Pure stats accumulator: derives bitrate/fps/freezes from the engine's own
//! byte + decoded-frame counters (no str0m getStats). Ports the bitrate formula
//! from `ui/src/lib/connection/stats.ts`. Default build; unit-tested anywhere.

use super::StatsSnapshot;

/// Sample cadence the engine drives this at (ms). Matches the browser's 2 s.
pub const STATS_SAMPLE_MS: f64 = 2000.0;

#[derive(Default)]
pub struct StatsAccumulator {
    bytes_total: u64,
    frames_total: u64,
    freeze_count: u32,
    last_sample_ms: Option<f64>,
    last_bytes: u64,
    last_frames: u64,
}

impl StatsAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add the size of one received **video** access unit.
    pub fn record_video_bytes(&mut self, n: usize) {
        self.bytes_total = self.bytes_total.saturating_add(n as u64);
    }

    /// Set the running total of truly-decoded frames (monotonic).
    pub fn set_frames_decoded(&mut self, total: u64) {
        self.frames_total = total;
    }

    /// Produce a snapshot for `now_ms`, computing rates over the window since the
    /// previous sample. The first sample establishes a baseline (zero rates).
    pub fn sample(&mut self, now_ms: f64) -> StatsSnapshot {
        let (mut bitrate_kbps, mut fps) = (0u32, 0u32);
        if let Some(prev_ms) = self.last_sample_ms {
            let dt = (now_ms - prev_ms) / 1000.0;
            if dt > 0.0 {
                let bytes_delta = self.bytes_total.saturating_sub(self.last_bytes);
                bitrate_kbps = ((bytes_delta as f64 * 8.0) / dt / 1000.0).round() as u32;
                let frames_delta = self.frames_total.saturating_sub(self.last_frames);
                fps = (frames_delta as f64 / dt).round() as u32;
                if frames_delta == 0 && self.frames_total > 0 {
                    self.freeze_count += 1;
                }
            }
        }
        self.last_sample_ms = Some(now_ms);
        self.last_bytes = self.bytes_total;
        self.last_frames = self.frames_total;
        StatsSnapshot {
            bitrate_kbps,
            fps,
            frames_decoded: self.frames_total,
            freeze_count: self.freeze_count,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_sample_is_baseline_zero_rates() {
        let mut a = StatsAccumulator::new();
        a.record_video_bytes(10_000);
        a.set_frames_decoded(5);
        let s = a.sample(1000.0);
        assert_eq!(s.bitrate_kbps, 0); // no prior window
        assert_eq!(s.fps, 0);
        assert_eq!(s.frames_decoded, 5);
    }

    #[test]
    fn bitrate_uses_bytes_times_8_over_seconds_over_1000() {
        let mut a = StatsAccumulator::new();
        let _ = a.sample(0.0); // baseline at t=0
        a.record_video_bytes(125_000); // 125 KB in 1.0 s → 1000 kbps
        let s = a.sample(1000.0);
        assert_eq!(s.bitrate_kbps, 1000);
    }

    #[test]
    fn fps_is_frame_delta_over_seconds() {
        let mut a = StatsAccumulator::new();
        let _ = a.sample(0.0);
        a.set_frames_decoded(60); // 60 frames in 1.0 s
        let s = a.sample(1000.0);
        assert_eq!(s.fps, 60);
        assert_eq!(s.frames_decoded, 60);
    }

    #[test]
    fn freeze_count_increments_when_flowing_then_no_progress() {
        let mut a = StatsAccumulator::new();
        let _ = a.sample(0.0);
        a.set_frames_decoded(30);
        let _ = a.sample(1000.0); // flowing (30 frames)
        // next window: no new frames
        let s = a.sample(2000.0);
        assert_eq!(s.fps, 0);
        assert_eq!(s.freeze_count, 1);
    }
}
