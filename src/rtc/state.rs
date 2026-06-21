//! Pure connection / reconnect state machine (str0m-free; default build).
//!
//! Reconnect backoff is 3s/6s/9s (master plan — tuned to Xbox session expiry),
//! then give up. `on_connected` resets the ladder.

use std::time::Duration;

/// Backoff ladder in seconds; length = max reconnect attempts before giving up.
pub const RECONNECT_BACKOFFS_SECS: [u64; 3] = [3, 6, 9];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Connecting,
    Connected,
    WaitingToReconnect,
    Failed,
}

/// What the engine should do after a drop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    ScheduleReconnect(Duration),
    GiveUp,
}

pub struct ConnectionState {
    phase: Phase,
    attempt: usize,
}

impl ConnectionState {
    pub fn new() -> Self {
        Self {
            phase: Phase::Connecting,
            attempt: 0,
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    /// Reconnect attempts made so far (1-based immediately after a drop).
    pub fn attempt(&self) -> u32 {
        self.attempt as u32
    }

    /// Mark a successful (re)connection; resets the backoff ladder.
    pub fn on_connected(&mut self) {
        self.phase = Phase::Connected;
        self.attempt = 0;
    }

    /// Handle a drop: schedule the next backoff, or give up once exhausted.
    pub fn on_dropped(&mut self) -> Transition {
        if self.attempt >= RECONNECT_BACKOFFS_SECS.len() {
            self.phase = Phase::Failed;
            return Transition::GiveUp;
        }
        let secs = RECONNECT_BACKOFFS_SECS[self.attempt];
        self.attempt += 1;
        self.phase = Phase::WaitingToReconnect;
        Transition::ScheduleReconnect(Duration::from_secs(secs))
    }
}

impl Default for ConnectionState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn backoff_is_3_6_9_then_give_up() {
        let mut s = ConnectionState::new();
        assert_eq!(
            s.on_dropped(),
            Transition::ScheduleReconnect(Duration::from_secs(3))
        );
        assert_eq!(
            s.on_dropped(),
            Transition::ScheduleReconnect(Duration::from_secs(6))
        );
        assert_eq!(
            s.on_dropped(),
            Transition::ScheduleReconnect(Duration::from_secs(9))
        );
        assert_eq!(s.on_dropped(), Transition::GiveUp);
        assert_eq!(s.phase(), Phase::Failed);
    }

    #[test]
    fn connected_resets_the_backoff() {
        let mut s = ConnectionState::new();
        assert_eq!(
            s.on_dropped(),
            Transition::ScheduleReconnect(Duration::from_secs(3))
        );
        s.on_connected();
        assert_eq!(s.phase(), Phase::Connected);
        // After a successful reconnect, the next drop starts the ladder over.
        assert_eq!(
            s.on_dropped(),
            Transition::ScheduleReconnect(Duration::from_secs(3))
        );
    }

    #[test]
    fn starts_connecting() {
        assert_eq!(ConnectionState::new().phase(), Phase::Connecting);
    }
}
