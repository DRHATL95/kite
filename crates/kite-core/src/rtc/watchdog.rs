//! Pure media-flow watchdog. Port of `ui/src/lib/connection/mediaMonitor.ts`:
//! while awaiting the first frame, nudge a keyframe at 4 s/7 s and give up
//! (reconnect) at 10 s; once flowing, nudge at 4 s of no progress and reconnect
//! at 8 s. Drivable off `(frames_decoded, now_ms)` — default build, unit-tested.

pub const START_NUDGE_1_MS: f64 = 4000.0;
pub const START_NUDGE_2_MS: f64 = 7000.0;
pub const START_TIMEOUT_MS: f64 = 10_000.0;
pub const STALL_NUDGE_MS: f64 = 4000.0;
pub const STALL_TIMEOUT_MS: f64 = 8000.0;
/// Cadence the engine calls `tick()` at (ms). Matches the browser's 1 s.
pub const MONITOR_TICK_MS: f64 = 1000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchdogReason {
    MediaNeverStarted,
    MediaStalled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchdogAction {
    Nudge,
    Recover(WatchdogReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Idle,
    AwaitingFirstFrame,
    Flowing,
}

pub struct MediaWatchdog {
    phase: Phase,
    armed_at: Option<f64>,
    start_nudges_sent: u8,
    last_frames: Option<u64>,
    last_progress_at: f64,
    stall_nudge_sent: bool,
}

impl MediaWatchdog {
    pub fn new() -> Self {
        Self {
            phase: Phase::Idle,
            armed_at: None,
            start_nudges_sent: 0,
            last_frames: None,
            last_progress_at: 0.0,
            stall_nudge_sent: false,
        }
    }

    /// Begin watching for the first frame (call once channels are ready).
    pub fn arm(&mut self, now_ms: f64) {
        self.phase = Phase::AwaitingFirstFrame;
        self.armed_at = Some(now_ms);
        self.start_nudges_sent = 0;
        self.last_frames = None;
        self.last_progress_at = now_ms;
        self.stall_nudge_sent = false;
    }

    /// Advance one tick. Returns at most one action (mirrors the JS early-returns).
    pub fn tick(&mut self, frames_decoded: Option<u64>, now_ms: f64) -> Option<WatchdogAction> {
        match self.phase {
            Phase::AwaitingFirstFrame => {
                let armed_at = *self.armed_at.get_or_insert(now_ms);
                if let Some(f) = frames_decoded
                    && f > 0
                {
                    self.phase = Phase::Flowing;
                    self.last_frames = Some(f);
                    self.last_progress_at = now_ms;
                    return None;
                }
                let elapsed = now_ms - armed_at;
                if elapsed >= START_TIMEOUT_MS {
                    self.phase = Phase::Idle;
                    return Some(WatchdogAction::Recover(WatchdogReason::MediaNeverStarted));
                }
                if self.start_nudges_sent == 0 && elapsed >= START_NUDGE_1_MS {
                    self.start_nudges_sent = 1;
                    return Some(WatchdogAction::Nudge);
                }
                if self.start_nudges_sent == 1 && elapsed >= START_NUDGE_2_MS {
                    self.start_nudges_sent = 2;
                    return Some(WatchdogAction::Nudge);
                }
                None
            }
            Phase::Flowing => {
                if let Some(f) = frames_decoded {
                    if self.last_frames.is_some_and(|lf| f > lf) {
                        self.last_frames = Some(f);
                        self.last_progress_at = now_ms;
                        self.stall_nudge_sent = false;
                        return None;
                    }
                    self.last_frames = Some(f);
                }
                let stalled = now_ms - self.last_progress_at;
                if stalled >= STALL_TIMEOUT_MS {
                    self.phase = Phase::Idle;
                    return Some(WatchdogAction::Recover(WatchdogReason::MediaStalled));
                }
                if !self.stall_nudge_sent && stalled >= STALL_NUDGE_MS {
                    self.stall_nudge_sent = true;
                    return Some(WatchdogAction::Nudge);
                }
                None
            }
            Phase::Idle => None,
        }
    }
}

impl Default for MediaWatchdog {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nudges_at_4s_then_7s_then_recovers_at_10s_if_no_frame() {
        let mut w = MediaWatchdog::new();
        w.arm(0.0);
        assert_eq!(w.tick(Some(0), 1000.0), None);
        assert_eq!(w.tick(Some(0), 4000.0), Some(WatchdogAction::Nudge));
        assert_eq!(w.tick(Some(0), 5000.0), None); // already sent nudge #1
        assert_eq!(w.tick(Some(0), 7000.0), Some(WatchdogAction::Nudge));
        assert_eq!(
            w.tick(Some(0), 10_000.0),
            Some(WatchdogAction::Recover(WatchdogReason::MediaNeverStarted))
        );
    }

    #[test]
    fn first_frame_transitions_to_flowing_no_action() {
        let mut w = MediaWatchdog::new();
        w.arm(0.0);
        assert_eq!(w.tick(Some(1), 500.0), None); // frames>0 → flowing
        assert_eq!(w.tick(Some(2), 1500.0), None); // progress
    }

    #[test]
    fn stall_nudges_at_4s_then_recovers_at_8s() {
        let mut w = MediaWatchdog::new();
        w.arm(0.0);
        let _ = w.tick(Some(10), 1000.0); // flowing, lastProgress=1000
        assert_eq!(w.tick(Some(10), 5000.0), Some(WatchdogAction::Nudge)); // 4s stalled
        assert_eq!(
            w.tick(Some(10), 9000.0),
            Some(WatchdogAction::Recover(WatchdogReason::MediaStalled))
        ); // 8s stalled
    }

    #[test]
    fn progress_resets_the_stall_clock_and_nudge() {
        let mut w = MediaWatchdog::new();
        w.arm(0.0);
        let _ = w.tick(Some(10), 1000.0);
        assert_eq!(w.tick(Some(10), 5000.0), Some(WatchdogAction::Nudge));
        let _ = w.tick(Some(11), 5500.0); // progress → reset
        assert_eq!(w.tick(Some(11), 9000.0), None);
    }
}
