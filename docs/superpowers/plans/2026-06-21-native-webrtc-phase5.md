# Native WebRTC Phase 5 — Wire the rest (stats, keepalive, idle pulse, clip, reconnect) — Implementation Plan

> **STATUS: ⬜ NOT STARTED (authored 2026-06-21).** Phases 0–4 are complete +
> live-validated (origin tip `47bfac5`). This phase wires the remaining runtime
> behaviors onto the proven engine. Built **here on Windows** (pure modules =
> default-build tests run anywhere); the engine-integration tasks compile under
> `--features native-webrtc` (WSL Ubuntu) and live-validate on the CachyOS box.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a native Linux session self-sustaining and observable — port the media-flow watchdog (keyframe-nudge → reconnect), real stats (bitrate/fps/freezes), API keepalive, the idle micro-pulse that answers Xbox's idle warning, and retroactive clip save (Opus-direct MP4) — reusing the already-built reconnect ladder, signaling keepalive seam, and clip ring.

**Architecture:** Push all decision logic into **pure, default-build modules** behind the existing hexagonal seams; keep `engine.rs` wiring thin. `StatsAccumulator` and `MediaWatchdog` are pure state machines fed `(bytes, frames_decoded, now_ms)`; the engine feeds them from its event loop and acts on their outputs (`Nudge` → keyframe request on `control`; `Recover` → drop so the Phase-2 reconnect ladder fires). API keepalive calls the existing `Signaling::keepalive` seam on a timer; the idle micro-pulse reuses the existing `GamepadFrame::idle_pulse()`. Clips reuse the existing pure `clip_tap::ClipRing` (fed live from the engine's AU stream) and a new Opus-direct `muxide` path in `clip.rs` (no Opus→AAC transcode).

**Tech Stack:** Rust (engine on tokio current-thread), `str0m` (data-channel writes), `muxide 0.2.5` (`AudioCodec::Opus` — confirmed in the crate, raw 48 kHz packets), the existing `clip_tap`/`protocol`/`input` pure modules. Tests: inline `#[cfg(test)]` units (default build) for every pure module; `insta` only where a wire format is asserted; the live `tests/rtc_e2e.rs` extended for stats + clip.

**Spec / source of truth:** Master plan `docs/superpowers/plans/2026-06-19-native-rust-webrtc.md` §Phase 5 + Decision (3) "mux Opus directly, drop the AAC transcode". Behavior ported verbatim from `ui/src/lib/connection/{mediaMonitor.ts,stats.ts,constants.ts,ConnectionManager.ts,input.ts}`.

**Branch:** `feat/native-webrtc-linux` (continue; checked out in worktree `busy-curie-96519f`).

---

## Global Constraints

- **Rust edition 2024 / 1.85+.** Match the existing crate.
- **Feature gating:** all codec/engine integration is behind the `native-webrtc` Cargo feature. **Pure modules (`stats.rs`, `watchdog.rs`, `keepalive.rs`, `channels.rs`, `clip.rs`) MUST compile and test in the default build** (no feature) so they run on native Windows. `engine.rs` and the `MediaPipeline` are gated.
- **Do NOT expect `--features native-webrtc` or the live E2E to build/run on *native* Windows** (ffmpeg dev libs). Use **WSL Ubuntu 24.04** for the feature build; the CachyOS box for live runs. The default `cargo test` (pure modules) is the Windows gate.
- **Byte-exact protocol values, copied verbatim** (from `constants.ts`):
  watchdog `START_NUDGE_1 = 4000`, `START_NUDGE_2 = 7000`, `START_TIMEOUT = 10000`, `STALL_NUDGE = 4000`, `STALL_TIMEOUT = 8000`, `MONITOR_TICK = 1000` (ms); stats sample every `2000` ms; `API_KEEPALIVE = 30000` ms; `IDLE_KEEPALIVE_INTERVAL = 30000` ms; `IDLE_PULSE_LEFT_THUMB_X = 4096`; `IDLE_PULSE_RECENTER = 32` ms; reconnect backoff `[3,6,9]` s (already in `state.rs`).
- **Reuse, don't duplicate:** `Signaling::keepalive` (exists), `GamepadFrame::{idle_pulse,neutral}` + `encode_gamepad` (exist), `protocol::keyframe_request()` (exists), `clip_tap::ClipRing` (exists), `state.rs` reconnect ladder (exists), `clip.rs::ensure_sps_pps` (exists).
- **TDD, frequent commits.** One commit per task minimum. Conventional commit messages, `feat(rtc):` / `fix(rtc):` scope.
- End commit messages with the Co-Authored-By trailer the repo uses.

---

## File Structure

```
src/rtc/
  stats.rs       CREATE  — PURE StatsAccumulator (bitrate/fps/freeze). Default build. (Task 5.1)
  watchdog.rs    CREATE  — PURE MediaWatchdog state machine (nudge/recover). Default build. (Task 5.2)
  keepalive.rs   CREATE  — PURE keepalive interval const + keepalive_should_stop(). Default build. (Task 5.4)
  channels.rs    MODIFY  — split idle WARNING from real disconnect (take_idle_warning). PURE. (Task 5.5)
  mod.rs         MODIFY  — `pub mod stats; pub mod watchdog; pub mod keepalive;`. (Task 5.1/5.2/5.4)
  engine.rs      MODIFY  — feed stats+watchdog; keepalive timer; idle-pulse; clip ring; Clip cmd. GATED. (5.3/5.4/5.5/5.6)
src/clip.rs      MODIFY  — mux_opus_to_mp4(&AssembledClip) + save_assembled_clip(). PURE/default. (Task 5.7)
src/main.rs      MODIFY  — register the `rtc_save_clip` command. GATED wiring. (Task 5.8)
tests/rtc_e2e.rs MODIFY  — assert stats events + a saved clip on the live run. GATED/live. (Task 5.3/5.8)
```

Note on the master scaffold: it listed `stats.rs` as "bitrate/fps/freeze counters **+ watchdog**". We split the watchdog into its own `watchdog.rs` for single-responsibility (two distinct state machines). Deliberate, documented here.

---

## Decisions (locked for this phase)

1. **Stats from engine counters, not str0m getStats.** Bitrate = bytes of received **video** AUs over the sample window (`(bytesΔ*8)/dtSec/1000`, rounded); fps = decoded-frame delta / dt; freeze = a sample window with no frame progress while previously flowing. This is fully portable + unit-testable and matches the JS `stats.ts` bitrate formula. (jitter/RTT/loss are str0m-internal and **deferred** — `StatsSnapshot` has no fields for them; not in scope.)
2. **Watchdog drives reconnect via the existing ladder.** `Recover` returns `SessionEnd::Dropped(reason)` from the stream loop; `drive()`'s existing `state.on_dropped()` path handles backoff + `Reconnecting` events. No new reconnect code.
3. **Idle WARNING ≠ disconnect.** `WarningForBeingIdle` must NOT drop the session (today it wrongly does). The sequencer surfaces it separately (`take_idle_warning`); the engine answers with the micro-pulse and stays connected. `KickForBeingIdle`/`Other` still drop.
4. **Idle micro-pulse only (no steady 1 s neutral-frame ticker).** The reactive pulse-on-warning satisfies "60 s idle session stays alive" (Xbox always warns before kicking). The steady 60 Hz / idle-every-~1 s neutral-frame cadence belongs to the input loop (gilrs, Phase 6) and is out of scope here.
5. **Clip audio is muxed as Opus directly** (`AudioCodec::Opus`, raw 48 kHz packets) — no Opus→AAC transcode. Removes the AAC-priming A/V residual (master Decision 3). Caveat (accepted): MP4+Opus needs a modern player (VLC/mpv/Chrome/Win11); recorded here as the known trade-off vs the legacy AAC path, which is left intact for the browser flow.
6. **Clip ring fed inline in the engine loop**, alongside decode (cheap: a `Vec` push + a clone per AU, same as the browser tap). `rtp_ts` is derived from the AU's `pts_micros`: video `(pts_micros*9/100)` (90 kHz), audio `(pts_micros*48/1000)` (48 kHz).

---

## Task 5.1: `StatsAccumulator` — bitrate / fps / freeze (PURE)

**Files:**
- Create: `src/rtc/stats.rs`
- Modify: `src/rtc/mod.rs` (add `pub mod stats;`)
- Test: inline `#[cfg(test)] mod tests` in `src/rtc/stats.rs` (default build)

**Interfaces:**
- Consumes: `super::StatsSnapshot` (exists in `mod.rs`: `{ bitrate_kbps:u32, fps:u32, frames_decoded:u64, freeze_count:u32 }`, `#[derive(Default)]`).
- Produces: `StatsAccumulator::{new, record_video_bytes(usize), set_frames_decoded(u64), sample(f64)->StatsSnapshot}`.

- [ ] **Step 1: Add the module** to `src/rtc/mod.rs` (near the other `pub mod` lines):

```rust
pub mod stats;
```

- [ ] **Step 2: Write the failing test** (`src/rtc/stats.rs`, at the bottom):

```rust
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
```

- [ ] **Step 3: Run, verify it fails.**

Run: `cargo test -p xbox-remote rtc::stats`
Expected: FAIL (unresolved `StatsAccumulator`).

- [ ] **Step 4: Implement** `src/rtc/stats.rs` (top of file):

```rust
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
```

- [ ] **Step 5: Run, verify pass.**

Run: `cargo test -p xbox-remote rtc::stats`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit.**

```bash
git add src/rtc/stats.rs src/rtc/mod.rs
git commit -m "feat(rtc): pure StatsAccumulator (bitrate/fps/freeze) — TDD"
```

---

## Task 5.2: `MediaWatchdog` — keyframe-nudge → reconnect (PURE)

**Files:**
- Create: `src/rtc/watchdog.rs`
- Modify: `src/rtc/mod.rs` (add `pub mod watchdog;`)
- Test: inline `#[cfg(test)] mod tests` in `src/rtc/watchdog.rs` (default build)

**Interfaces:**
- Produces: `WatchdogAction` (`Nudge` | `Recover(WatchdogReason)`), `WatchdogReason` (`MediaNeverStarted` | `MediaStalled`), `MediaWatchdog::{new, arm(f64), tick(Option<u64>, f64)->Option<WatchdogAction>}`.
- Port of `ui/src/lib/connection/mediaMonitor.ts` (`idle`/`awaitingFirstFrame`/`flowing`).

- [ ] **Step 1: Add the module** to `src/rtc/mod.rs`:

```rust
pub mod watchdog;
```

- [ ] **Step 2: Write the failing test** (`src/rtc/watchdog.rs`, bottom):

```rust
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
        assert_eq!(w.tick(Some(11), 9000.0), Some(WatchdogAction::Nudge)); // 3.5s since reset → not yet 4s? -> see note
    }
}
```

> Note for the implementer: the fourth test asserts that after progress at
> 5500 ms (new `last_progress_at`), 9000 ms is 3500 ms later — under the 4000 ms
> stall-nudge — so it should be `None`, not `Nudge`. **Fix the expected value to
> `None` when you write the test** (this is intentional: prove the reset works).
> Keep the first three tests exactly as written.

- [ ] **Step 3: Run, verify it fails.**

Run: `cargo test -p xbox-remote rtc::watchdog`
Expected: FAIL (unresolved `MediaWatchdog`).

- [ ] **Step 4: Implement** `src/rtc/watchdog.rs` (top):

```rust
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
```

- [ ] **Step 5: Run, verify pass.**

Run: `cargo test -p xbox-remote rtc::watchdog`
Expected: PASS (4 tests; with the fourth's expected value set to `None` per the note).

- [ ] **Step 6: Commit.**

```bash
git add src/rtc/watchdog.rs src/rtc/mod.rs
git commit -m "feat(rtc): pure MediaWatchdog (keyframe-nudge → reconnect) — TDD"
```

---

## Task 5.3: Wire stats + watchdog into the engine (GATED)

**Files:**
- Modify: `src/rtc/engine.rs` (the `stream()` loop, ~lines 237–342 + the `MediaData` handler ~437–465)
- Verify only: `cargo build --features native-webrtc` (WSL); live check deferred to 5.8.

**Interfaces:**
- Consumes: `super::stats::{StatsAccumulator, STATS_SAMPLE_MS}`, `super::watchdog::{MediaWatchdog, WatchdogAction, WatchdogReason, MONITOR_TICK_MS}`, existing `protocol::keyframe_request()`, existing `apply_write`/`ChannelWrite`/`ChannelLabel::Control`, existing `SessionEnd::Dropped`.
- The engine already owns `frames: u64` (line 260) and emits `RtcEvent::Stats` on the 500 ms `ice_tick` (lines 321–325). **Replace** that placeholder heartbeat with real stats + watchdog ticks.

- [ ] **Step 1: Add imports** at the top of `engine.rs` (with the other `use super::` lines):

```rust
use super::stats::{StatsAccumulator, STATS_SAMPLE_MS};
use super::watchdog::{MediaWatchdog, WatchdogAction};
use crate::rtc::protocol::keyframe_request;
```

- [ ] **Step 2: Construct the accumulator + watchdog** inside `stream()`, next to `let mut frames: u64 = 0;` (~line 260):

```rust
let mut stats = StatsAccumulator::new();
let mut watchdog = MediaWatchdog::new();
let mut watchdog_armed = false;
let now_ms = || Instant::now().elapsed().as_secs_f64() * 1000.0; // monotonic since process start
let mut last_stats_ms = 0.0_f64;
let mut last_tick_ms = 0.0_f64;
```

> The engine already has a session start `Instant`; reuse it if present. If not,
> add `let started = Instant::now();` and define
> `let now_ms = || started.elapsed().as_secs_f64() * 1000.0;`.

- [ ] **Step 3: Record video bytes** in the `MediaData` video branch (right where `au` is built, ~line 440), before/after `dec.feed`:

```rust
if data.mid == media.video_mid {
    stats.record_video_bytes(data.data.len()); // NEW
    if let Some(dec) = media.video_dec.as_mut() {
        // ... existing decode loop; after `*frames += 1;` add:
        // stats.set_frames_decoded(*frames);
    }
}
```

Add `stats.set_frames_decoded(*frames);` immediately after the existing `*frames += 1;` line.

- [ ] **Step 4: Replace the placeholder stats heartbeat** (the `ice_tick` block, lines 321–325) with real stats emission + watchdog ticks on the 500 ms `ice_tick`:

```rust
// (inside the ice_tick branch, after the existing poll_ice work)
let t = now_ms();

// Arm the watchdog once the handshake is ready (channels up).
if !watchdog_armed && seq.is_ready() {
    watchdog.arm(t);
    watchdog_armed = true;
}

// Drive the media watchdog ~every MONITOR_TICK_MS.
if watchdog_armed && t - last_tick_ms >= MONITOR_TICK_MS {
    last_tick_ms = t;
    match watchdog.tick(Some(*frames), t) {
        Some(WatchdogAction::Nudge) => {
            apply_write(&mut rtc, &ids, &ChannelWrite {
                label: ChannelLabel::Control,
                bytes: serde_json::to_vec(&keyframe_request()).expect("serialize"),
            });
        }
        Some(WatchdogAction::Recover(reason)) => {
            return SessionEnd::Dropped(format!("media watchdog: {reason:?}"));
        }
        None => {}
    }
}

// Emit real stats ~every STATS_SAMPLE_MS.
if t - last_stats_ms >= STATS_SAMPLE_MS {
    last_stats_ms = t;
    let _ = event_tx.send(RtcEvent::Stats(stats.sample(t)));
}
```

> `seq` is the `HandshakeSequencer` already in scope. `apply_write`,
> `ChannelWrite`, `ChannelLabel`, `ids`, `rtc`, `event_tx`, `frames` are all
> already in `stream()`. `stream()` returns `SessionEnd` (not `Option`) at this
> level — confirm the return type at the call site; the watchdog `Recover` must
> propagate as `SessionEnd::Dropped` so `drive()`'s ladder fires.

- [ ] **Step 5: Build under the feature** (WSL Ubuntu):

Run: `cargo build --features native-webrtc`
Expected: compiles clean (no warnings introduced). On native Windows this step is skipped — instead run `cargo build` (default) and `cargo test -p xbox-remote rtc::` to confirm the pure modules still pass.

- [ ] **Step 6: Commit.**

```bash
git add src/rtc/engine.rs
git commit -m "feat(rtc): drive real stats + media watchdog from the engine loop"
```

---

## Task 5.4: API keepalive on a timer (GATED) + pure stop-decision helper

**Files:**
- Create: `src/rtc/keepalive.rs` (PURE: interval const + `keepalive_should_stop`)
- Modify: `src/rtc/mod.rs` (`pub mod keepalive;`)
- Modify: `src/rtc/engine.rs` (`stream()` select loop — add a keepalive interval branch)
- Test: inline tests in `keepalive.rs` (default build)

**Interfaces:**
- Produces: `keepalive::{API_KEEPALIVE_SECS, keepalive_should_stop(&str)->bool}`.
- Consumes (engine): the existing `Signaling::keepalive(&self, &SessionInfo) -> Result<()>` seam (already implemented by `XHomeSignaling`).

- [ ] **Step 1: Add the module** to `src/rtc/mod.rs`:

```rust
pub mod keepalive;
```

- [ ] **Step 2: Write the failing test** (`src/rtc/keepalive.rs`, bottom):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stops_on_session_in_unexpected_state() {
        assert!(keepalive_should_stop("keepalive: ApiError 400 SessionInUnexpectedState"));
    }

    #[test]
    fn stops_on_400() {
        assert!(keepalive_should_stop("keepalive: HTTP 400 Bad Request"));
    }

    #[test]
    fn keeps_going_on_transient_errors() {
        assert!(!keepalive_should_stop("keepalive: network timeout"));
        assert!(!keepalive_should_stop("keepalive: HTTP 503"));
    }
}
```

- [ ] **Step 3: Run, verify it fails.**

Run: `cargo test -p xbox-remote rtc::keepalive`
Expected: FAIL (unresolved `keepalive_should_stop`).

- [ ] **Step 4: Implement** `src/rtc/keepalive.rs`:

```rust
//! Pure helpers for the engine's API-side keepalive. The xHome keepalive is only
//! valid while the session is provisioning; once media flows, Xbox rejects it
//! with 400 / "SessionInUnexpectedState" (the data-channel traffic is the live
//! keepalive). Port of the stop condition in
//! `ui/src/lib/connection/ConnectionManager.ts` `_startApiKeepalive`.

/// Fixed keepalive cadence (s). Matches the browser's hardcoded 30 s; the Xbox
/// `keepAlivePulseInSeconds` hint is intentionally not used (the browser ignores
/// it too — 30 s is well inside the ~56 s expiry).
pub const API_KEEPALIVE_SECS: u64 = 30;

/// True if a keepalive error means we should stop pulsing (session moved past
/// provisioning). Transient/network errors return false (keep trying).
pub fn keepalive_should_stop(err: &str) -> bool {
    err.contains("400") || err.contains("SessionInUnexpectedState")
}
```

- [ ] **Step 5: Run, verify pass.**

Run: `cargo test -p xbox-remote rtc::keepalive`
Expected: PASS (3 tests).

- [ ] **Step 6: Wire the timer into `engine.rs`** `stream()`. Add a keepalive interval beside `ice_tick` (~line 262):

```rust
use super::keepalive::{API_KEEPALIVE_SECS, keepalive_should_stop};
// ...
let mut keepalive_tick = tokio::time::interval(Duration::from_secs(API_KEEPALIVE_SECS));
keepalive_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
let mut keepalive_on = true;
```

Add a branch to the `tokio::select!` in `stream()`:

```rust
_ = keepalive_tick.tick(), if keepalive_on => {
    if let Err(e) = signaling.keepalive(session).await {
        let es = e.to_string();
        if keepalive_should_stop(&es) {
            keepalive_on = false; // provisioning over; data channel is the keepalive now
        }
        // transient errors: keep the timer running
    }
}
```

> `signaling` and `session` are already parameters of `stream()`
> (`signaling: &S`, `session: &SessionInfo`). The first `interval` tick fires
> immediately — call `keepalive_tick.tick().await` once before the loop, or rely
> on the immediate first pulse being harmless (the browser delays the first by
> 30 s; to match, do one throwaway `keepalive_tick.tick().await;` right after
> constructing it so the first real pulse lands at +30 s).

- [ ] **Step 7: Build under the feature** (WSL): `cargo build --features native-webrtc` → clean. (Windows: `cargo test -p xbox-remote rtc::keepalive`.)

- [ ] **Step 8: Commit.**

```bash
git add src/rtc/keepalive.rs src/rtc/mod.rs src/rtc/engine.rs
git commit -m "feat(rtc): API keepalive timer + pure stop-condition helper (TDD)"
```

---

## Task 5.5: Idle micro-pulse — distinguish warning from kick (PURE fix + GATED wire)

**Files:**
- Modify: `src/rtc/channels.rs` (`HandshakeSequencer`: surface idle warning separately)
- Modify: `src/rtc/engine.rs` (react to the warning: send pulse + recenter + 30 s repeat)
- Test: inline tests in `channels.rs` (default build)

**Interfaces:**
- Produces: `HandshakeSequencer::take_idle_warning(&mut self) -> Option<u32>` (seconds-until-kick); `take_disconnect()` no longer returns `WarningForBeingIdle`.
- Consumes (engine): existing `GamepadFrame::{idle_pulse, neutral}`, `encode_gamepad`, `ChannelLabel::Input`, `write_channel`.

- [ ] **Step 1: Write the failing test** in `channels.rs` `mod tests` (add two tests):

```rust
#[test]
fn idle_warning_is_surfaced_as_warning_not_disconnect() {
    let mut seq = HandshakeSequencer::new(Box::new(det_ids()));
    let msg = serde_json::json!({
        "type":"Message","target":"x/serverInitiatedDisconnect",
        "content":"{\"reason\":\"WarningForBeingIdle\",\"secondsUntilKick\":60}"
    });
    let bytes = serde_json::to_vec(&msg).unwrap();
    let w = seq.on_event(ChannelEvent::Inbound { label: ChannelLabel::Message, data: bytes });
    assert!(w.is_empty());
    assert_eq!(seq.take_idle_warning(), Some(60)); // surfaced as a warning
    assert!(seq.take_disconnect().is_none());      // NOT a disconnect
}

#[test]
fn kick_is_still_a_disconnect_not_a_warning() {
    let mut seq = HandshakeSequencer::new(Box::new(det_ids()));
    let msg = serde_json::json!({
        "type":"Message","target":"x/serverInitiatedDisconnect",
        "content":"{\"reason\":\"KickForBeingIdle\"}"
    });
    let bytes = serde_json::to_vec(&msg).unwrap();
    let _ = seq.on_event(ChannelEvent::Inbound { label: ChannelLabel::Message, data: bytes });
    assert!(seq.take_idle_warning().is_none());
    assert!(matches!(seq.take_disconnect(), Some(protocol::DisconnectReason::KickForBeingIdle)));
}
```

- [ ] **Step 2: Run, verify it fails.**

Run: `cargo test -p xbox-remote rtc::channels`
Expected: FAIL (`take_idle_warning` not found; and the warning currently lands in `disconnect`).

- [ ] **Step 3: Implement** the split in `channels.rs`. Add a field + accessor and branch the match:

```rust
// struct HandshakeSequencer { ... add: }
    idle_warning: Option<u32>,
```

```rust
// in `new()`: idle_warning: None,
```

```rust
/// Take any pending idle warning (seconds until kick); answer with a keepalive
/// pulse and STAY connected — this is not a disconnect.
pub fn take_idle_warning(&mut self) -> Option<u32> {
    self.idle_warning.take()
}
```

```rust
// in `on_inbound`, replace the ServerDisconnect arm:
InboundMsg::ServerDisconnect(DisconnectReason::WarningForBeingIdle { seconds_until_kick }) => {
    self.idle_warning = Some(seconds_until_kick);
    Vec::new()
}
InboundMsg::ServerDisconnect(reason) => {
    self.disconnect = Some(reason);
    Vec::new()
}
```

> Add `DisconnectReason` to the existing `use crate::rtc::protocol::{... DisconnectReason ...}` import (already imported per channels.rs:14).

- [ ] **Step 4: Run, verify pass.**

Run: `cargo test -p xbox-remote rtc::channels`
Expected: PASS (existing 4 + 2 new). Confirm `server_disconnect_is_surfaced_not_written` still passes (it uses `KickForBeingIdle`).

- [ ] **Step 5: Commit the pure fix.**

```bash
git add src/rtc/channels.rs
git commit -m "fix(rtc): surface idle warning separately from disconnect (TDD)"
```

- [ ] **Step 6: Wire the pulse in `engine.rs`** (GATED). In the `Event::ChannelData` handler (~lines 422–435), after `seq.on_event`, check the warning before the disconnect:

```rust
// after the `for w in seq.on_event(...)` apply loop, BEFORE take_disconnect():
if let Some(secs) = seq.take_idle_warning() {
    let _ = secs; // (logged; informational)
    // Micro-pulse: stick to 4096 for one frame, then recenter to neutral.
    send_input_frame(&mut rtc, &ids, &mut input_seq, GamepadFrame::idle_pulse(), now_ms());
    send_input_frame(&mut rtc, &ids, &mut input_seq, GamepadFrame::neutral(), now_ms());
    idle_keepalive_on = true; // start the periodic repeat (see Step 7)
}
```

Add a small helper near `write_channel`:

```rust
fn send_input_frame(
    rtc: &mut Rtc,
    ids: &ChannelMap,
    seq: &mut u32,
    frame: GamepadFrame,
    ts_ms: f64,
) {
    let bytes = encode_gamepad(&frame, *seq, ts_ms);
    *seq = seq.wrapping_add(1);
    write_channel(rtc, ids.get(ChannelLabel::Input), &bytes);
}
```

> The exact 32 ms gap between pulse and recenter (`IDLE_PULSE_RECENTER_MS`) is a
> nicety the browser used to avoid games seeing movement; in the engine's
> single-threaded loop, sending the neutral frame on the very next statement is
> acceptable for a keepalive (the stick returns to center within one frame). If a
> game proves sensitive, schedule the recenter via a `tokio::time::sleep(32ms)`
> task — note this in the live-run findings, don't pre-optimize.

- [ ] **Step 7: Add a periodic idle repeat** beside the keepalive timer in `stream()`:

```rust
let mut idle_tick = tokio::time::interval(Duration::from_secs(30)); // IDLE_KEEPALIVE_INTERVAL
idle_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
let mut idle_keepalive_on = false;
let mut input_seq: u32 = 0; // if not already present from Phase 2 input handling — reuse the existing one
```

select branch:

```rust
_ = idle_tick.tick(), if idle_keepalive_on => {
    send_input_frame(&mut rtc, &ids, &mut input_seq, GamepadFrame::idle_pulse(), now_ms());
    send_input_frame(&mut rtc, &ids, &mut input_seq, GamepadFrame::neutral(), now_ms());
}
```

> If `input_seq` already exists (Phase-2 `SendInput` uses one), reuse it — do NOT
> introduce a second counter (sequence must be monotonic across all input
> frames). Search `engine.rs` for `input_seq` first.

- [ ] **Step 8: Build under the feature** (WSL): `cargo build --features native-webrtc` → clean.

- [ ] **Step 9: Commit the wiring.**

```bash
git add src/rtc/engine.rs
git commit -m "feat(rtc): answer idle warning with stick micro-pulse keepalive"
```

---

## Task 5.6: Feed the clip ring from the live AU stream + Clip command (GATED)

**Files:**
- Modify: `src/rtc/engine.rs` (`MediaPipeline` owns a `ClipRing`; push every AU; `EngineCommand::Clip`; `RtcHandle::clip()`)
- Verify: `cargo build --features native-webrtc` (WSL).

**Interfaces:**
- Consumes: `crate::rtc::clip_tap::{ClipRing, AssembledClip, VideoTrackConfig}`, existing `EngineCommand`, `RtcHandle`, `mpsc`/`tokio::sync::oneshot`.
- Produces: `EngineCommand::Clip(oneshot::Sender<Option<AssembledClip>>)`, `RtcHandle::clip(&self) -> impl Future<Output = Option<AssembledClip>>`.

- [ ] **Step 1: Add `oneshot` import** and the command variant in `engine.rs`:

```rust
use tokio::sync::oneshot;
// ...
pub enum EngineCommand {
    SendInput(GamepadFrame),
    Clip(oneshot::Sender<Option<AssembledClip>>), // NEW
    Disconnect,
}
```

Add to `RtcHandle`:

```rust
/// Request a retroactive clip of the last buffered seconds. Returns the
/// assembled (keyframe-aligned) clip, or None if nothing is buffered / engine gone.
pub async fn clip(&self) -> Option<AssembledClip> {
    let (tx, rx) = oneshot::channel();
    if self.cmd_tx.send(EngineCommand::Clip(tx)).is_err() {
        return None;
    }
    rx.await.ok().flatten()
}
```

- [ ] **Step 2: Own a `ClipRing` in `MediaPipeline`** (struct ~lines 369–389). Add a field and construct it in `MediaPipeline::new`:

```rust
clip_ring: ClipRing,
```

```rust
// in MediaPipeline::new(...):
clip_ring: ClipRing::with_clock(
    20.0, // retain ~20 s; tune later
    VideoTrackConfig::default(), // 1920x1080@60 (SPS-parse for exact dims is a follow-up)
    Box::new(|| {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64() * 1000.0
    }),
),
```

- [ ] **Step 3: Push every AU into the ring** in the `MediaData` handler. Video branch (after `record_video_bytes`):

```rust
let pts = media_time_micros(&data); // existing helper, microseconds
let v_rtp = (pts.max(0) as i128 * 9 / 100) as u32; // 90 kHz
media.clip_ring.push_video(data.data.to_vec(), v_rtp, data.is_keyframe());
```

Audio branch (alongside the existing decode):

```rust
let a_pts = media_time_micros(&data);
let a_rtp = (a_pts.max(0) as i128 * 48 / 1000) as u32; // 48 kHz
media.clip_ring.push_audio(data.data.to_vec(), a_rtp);
```

> Confirm `media_time_micros` returns a signed integer microseconds value; if it
> returns `u64`, drop the `.max(0)` and cast directly. The clip ring uses these
> only to compute relative wall-clock seconds at the track rate — monotonic is
> what matters.

- [ ] **Step 4: Handle `EngineCommand::Clip`** in the `cmd` select branch (beside `SendInput`/`Disconnect`):

```rust
EngineCommand::Clip(reply) => {
    let _ = reply.send(media.clip_ring.assemble());
}
```

> `media` (the `MediaPipeline`) must be in scope at the command-handling site. It
> is constructed in `stream()` (line 263) and the command loop is in the same
> function — pass it through or keep both in `stream()`. If `cmd` handling lives
> in a sub-fn that doesn't see `media`, hoist the `Clip` arm up to `stream()`.

- [ ] **Step 5: Build under the feature** (WSL): `cargo build --features native-webrtc` → clean.

- [ ] **Step 6: Commit.**

```bash
git add src/rtc/engine.rs
git commit -m "feat(rtc): feed clip ring from live AUs + Clip command/handle"
```

---

## Task 5.7: Opus-direct MP4 mux + save to disk (PURE / default build)

**Files:**
- Modify: `src/clip.rs` (add `mux_opus_to_mp4` + `save_assembled_clip`)
- Test: inline tests in `src/clip.rs` `mod tests` (default build — `clip.rs` is NOT feature-gated)

**Interfaces:**
- Consumes: `crate::rtc::clip_tap::AssembledClip` (`{ width:u32, height:u32, fps_num:u32, fps_den:u32, sps:Vec<u8>, pps:Vec<u8>, video:Vec<VideoAu>, audio:Vec<AudioAu>, start_sec:f64 }`), existing `ensure_sps_pps`.
- Produces: `pub fn mux_opus_to_mp4(clip: &AssembledClip) -> Result<Vec<u8>, String>`, `pub fn save_assembled_clip(clip: &AssembledClip, dir: &std::path::Path) -> Result<std::path::PathBuf, String>`.

- [ ] **Step 1: Write the failing test** (`src/clip.rs` `mod tests`):

```rust
#[test]
fn mux_opus_produces_playable_mp4_with_opus_track() {
    use crate::rtc::clip_tap::{AssembledClip, VideoAu, AudioAu};
    // Minimal H.264 keyframe (SPS+PPS+IDR) — same shape muxide's own test uses.
    let mut kf = Vec::new();
    kf.extend_from_slice(&[0,0,0,1,0x67,0x42,0x00,0x1e,0xab,0x40,0xf0,0x28,0xd0]); // SPS
    kf.extend_from_slice(&[0,0,0,1,0x68,0xce,0x38,0x80]);                          // PPS
    kf.extend_from_slice(&[0,0,0,1,0x65,0x88,0x84,0x00,0x10]);                     // IDR
    // Valid Opus packet: TOC config=4 (SILK 20ms) stereo 1 frame = 0x24.
    let opus = vec![0x24u8, 0xc0, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05];

    let clip = AssembledClip {
        width: 1920, height: 1080, fps_num: 60, fps_den: 1,
        sps: vec![], pps: vec![], // in-band in the keyframe above
        video: vec![VideoAu { bytes: kf, pts_sec: 0.0, is_keyframe: true }],
        audio: vec![
            AudioAu { bytes: opus.clone(), pts_sec: 0.0 },
            AudioAu { bytes: opus, pts_sec: 0.02 },
        ],
        start_sec: 0.0,
    };

    let mp4 = mux_opus_to_mp4(&clip).expect("mux ok");
    assert!(mp4.windows(4).any(|w| w == b"ftyp"), "fast-start ftyp present");
    assert!(mp4.windows(4).any(|w| w == b"Opus"), "Opus sample entry present");
    assert!(mp4.windows(4).any(|w| w == b"dOps"), "Opus config box present");
}

#[test]
fn mux_opus_rejects_empty_video() {
    use crate::rtc::clip_tap::AssembledClip;
    let clip = AssembledClip {
        width: 1920, height: 1080, fps_num: 60, fps_den: 1,
        sps: vec![], pps: vec![], video: vec![], audio: vec![], start_sec: 0.0,
    };
    assert!(mux_opus_to_mp4(&clip).is_err());
}

#[test]
fn save_assembled_clip_writes_an_mp4_file() {
    use crate::rtc::clip_tap::{AssembledClip, VideoAu};
    let mut kf = Vec::new();
    kf.extend_from_slice(&[0,0,0,1,0x67,0x42,0x00,0x1e,0xab,0x40,0xf0,0x28,0xd0]);
    kf.extend_from_slice(&[0,0,0,1,0x68,0xce,0x38,0x80]);
    kf.extend_from_slice(&[0,0,0,1,0x65,0x88,0x84,0x00,0x10]);
    let clip = AssembledClip {
        width: 1920, height: 1080, fps_num: 60, fps_den: 1,
        sps: vec![], pps: vec![],
        video: vec![VideoAu { bytes: kf, pts_sec: 0.0, is_keyframe: true }],
        audio: vec![], start_sec: 0.0,
    };
    let dir = std::env::temp_dir().join("xbox-remote-clip-test");
    let path = save_assembled_clip(&clip, &dir).expect("save ok");
    assert!(path.exists());
    assert_eq!(path.extension().and_then(|e| e.to_str()), Some("mp4"));
    let _ = std::fs::remove_file(&path);
}
```

- [ ] **Step 2: Run, verify it fails.**

Run: `cargo test -p xbox-remote clip::tests::mux_opus`
Expected: FAIL (`mux_opus_to_mp4` not found).

- [ ] **Step 3: Implement** in `src/clip.rs` (below `mux_to_mp4`):

```rust
/// Mux an assembled native clip (Opus audio, Annex-B H.264) into a fast-start
/// MP4. Audio is written as **raw Opus** directly (muxide `AudioCodec::Opus`,
/// always 48 kHz) — no AAC transcode, removing the AAC-priming A/V residual.
pub fn mux_opus_to_mp4(clip: &crate::rtc::clip_tap::AssembledClip) -> Result<Vec<u8>, String> {
    use muxide::api::{AudioCodec, MuxerBuilder, VideoCodec};

    if clip.video.is_empty() {
        return Err("clip has no video frames".to_string());
    }
    if !clip.video[0].is_keyframe {
        return Err("first video frame must be a keyframe".to_string());
    }

    let fps = clip.fps_num as f64 / clip.fps_den.max(1) as f64;
    let has_audio = !clip.audio.is_empty();
    let t0 = clip.video[0].pts_sec;

    let mut out: Vec<u8> = Vec::new();
    {
        let mut builder =
            MuxerBuilder::new(&mut out).video(VideoCodec::H264, clip.width, clip.height, fps);
        if has_audio {
            builder = builder.audio(AudioCodec::Opus, 48_000, 2);
        }
        let mut muxer = builder.build().map_err(|e| format!("muxer init: {e}"))?;

        for (i, f) in clip.video.iter().enumerate() {
            let pts = (f.pts_sec - t0).max(0.0);
            let data = if i == 0 {
                ensure_sps_pps(&f.bytes, &clip.sps, &clip.pps)
            } else {
                f.bytes.clone()
            };
            muxer
                .write_video(pts, &data, f.is_keyframe)
                .map_err(|e| format!("write_video[{i}]: {e}"))?;
        }
        if has_audio {
            for (i, f) in clip.audio.iter().enumerate() {
                let pts = (f.pts_sec - t0).max(0.0);
                muxer
                    .write_audio(pts, &f.bytes) // raw Opus, no ADTS
                    .map_err(|e| format!("write_audio[{i}]: {e}"))?;
            }
        }
        muxer.finish().map_err(|e| format!("finish: {e}"))?;
    }
    Ok(out)
}

/// Mux + write the clip to `dir` as `clip-<unix_ms>.mp4`, returning the path.
pub fn save_assembled_clip(
    clip: &crate::rtc::clip_tap::AssembledClip,
    dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let mp4 = mux_opus_to_mp4(clip)?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create dir: {e}"))?;
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("clip-{ms}.mp4"));
    std::fs::write(&path, &mp4).map_err(|e| format!("write mp4: {e}"))?;
    Ok(path)
}
```

- [ ] **Step 4: Run, verify pass.**

Run: `cargo test -p xbox-remote clip::`
Expected: PASS (3 new + existing clip tests still green).

- [ ] **Step 5: Commit.**

```bash
git add src/clip.rs
git commit -m "feat(clip): Opus-direct MP4 mux + save_assembled_clip (TDD)"
```

---

## Task 5.8: `rtc_save_clip` Tauri command + live E2E coverage (GATED / live)

**Files:**
- Modify: `src/main.rs` (register a `rtc_save_clip` command that drives the engine handle → `save_assembled_clip`)
- Modify: `tests/rtc_e2e.rs` (assert ≥1 `Stats` event with nonzero bitrate; request a clip and assert a file is written)
- Verify: `cargo build --features native-webrtc` (WSL); live `XBOX_E2E` run on CachyOS.

**Interfaces:**
- Consumes: `RtcHandle::clip()` (Task 5.6), `clip::save_assembled_clip` (Task 5.7), the existing clips directory helper (search `main.rs`/`clip.rs` for the `<Videos>/Xbox Remote Clips` path used by the existing `save_clip`).

- [ ] **Step 1: Locate the existing engine handle + clips dir.** In `main.rs`, find where the native engine `RtcHandle` is stored in Tauri state (added in an earlier phase or to be added) and the clips directory used by the current browser `save_clip` command. Reuse both.

> If the native `RtcHandle` is not yet in Tauri-managed state, this task includes
> adding it (an `Arc<Mutex<Option<RtcHandle>>>` in `State`), set on `rtc_connect`.
> Keep that change minimal and behind `#[cfg(feature = "native-webrtc")]`.

- [ ] **Step 2: Add the command** (gated) in `main.rs`:

```rust
#[cfg(feature = "native-webrtc")]
#[tauri::command]
async fn rtc_save_clip(state: tauri::State<'_, AppState>) -> std::result::Result<String, String> {
    let handle = state.rtc.lock().await;
    let h = handle.as_ref().ok_or("no active native session")?;
    let clip = h.clip().await.ok_or("nothing buffered to clip")?;
    let dir = clips_dir()?; // the existing <Videos>/Xbox Remote Clips helper
    let path = crate::clip::save_assembled_clip(&clip, &dir)?;
    Ok(path.to_string_lossy().into_owned())
}
```

Register it in the `tauri::generate_handler!` list (gated arm).

> Match the real `AppState`/lock types in this codebase — the snippet names are
> illustrative. The acceptance is: a `rtc_save_clip` command exists, compiles
> under the feature, and returns the saved path.

- [ ] **Step 3: Extend the live E2E** (`tests/rtc_e2e.rs`, gated `XBOX_E2E`). After the existing "≥100 decoded frames" assertion, drain a few more events and assert at least one `RtcEvent::Stats` carried `bitrate_kbps > 0`; then call `handle.clip().await` and assert `Some(clip)` with non-empty `video`, mux it via `clip::mux_opus_to_mp4`, and assert the bytes contain `b"ftyp"`.

```rust
// pseudo-additions inside the existing test, after frame assertions:
let mut saw_bitrate = false;
// ... while draining events: if let RtcEvent::Stats(s) = ev { if s.bitrate_kbps > 0 { saw_bitrate = true; } }
assert!(saw_bitrate, "expected a stats sample with nonzero bitrate");

let clip = handle.clip().await.expect("a clip");
assert!(!clip.video.is_empty());
let mp4 = xbox_remote::clip::mux_opus_to_mp4(&clip).expect("mux");
assert!(mp4.windows(4).any(|w| w == b"ftyp"));
```

- [ ] **Step 4: Build under the feature** (WSL): `cargo build --features native-webrtc` → clean.

- [ ] **Step 5: Live-validate on CachyOS** (owner-run; not a CI gate):

```bash
XBOX_E2E=1 XBOX_SERVER_ID=<id> \
  cargo test --features native-webrtc --test rtc_e2e -- --nocapture
```

Expected: Connected → FirstFrame → ≥100 decoded frames → a Stats sample with nonzero bitrate → a clip assembles and muxes. Manually confirm: a 60 s idle session stays connected (idle pulse answered the warning); pulling the stream triggers nudge→reconnect; the saved MP4 plays in mpv/VLC with synced A/V.

- [ ] **Step 6: Commit.**

```bash
git add src/main.rs tests/rtc_e2e.rs
git commit -m "feat(rtc): rtc_save_clip command + stats/clip coverage in live E2E"
```

---

## Self-Review

**Spec coverage (master §Phase 5):**
- "stats watchdog (keyframe nudge at 4s/7s → reconnect at 10s)" → Tasks 5.2 (pure) + 5.3 (wired). ✅ (start path 4/7/10; stall path 4/8 — both ported.)
- "API keepalive (reuse send_session_keepalive)" → Task 5.4 (reuses `Signaling::keepalive` → `send_keepalive`). ✅
- "input-channel idle micro-pulse (LeftThumbX=4096)" → Task 5.5 (warning split + pulse). ✅
- "wire clip_tap to the live AU stream and the existing save_clip/muxide path" → Tasks 5.6 (feed ring) + 5.7 (Opus mux/save) + 5.8 (command). ✅
- Acceptance "60 s idle stays alive / pull triggers nudge→reconnect / Save clip → playable fast-start MP4" → covered by 5.8 Step 5 live checks. ✅
- Real stats (bitrate/fps/freezes) populate the already-present `StatsSnapshot` fields → Task 5.1. ✅

**Placeholder scan:** every code step has complete code. Engine-wiring steps that depend on exact in-scope names (`media`, `seq`, `input_seq`, `media_time_micros` signedness, `stream()` return type) carry explicit "confirm at the call site" notes rather than guesses — these are integration realities, not placeholders, and each names the exact symbol to check.

**Type consistency:**
- `StatsSnapshot` fields used in 5.1 match `mod.rs` exactly (`bitrate_kbps`, `fps`, `frames_decoded`, `freeze_count`). ✅
- `AssembledClip` fields used in 5.6/5.7/5.8 match `clip_tap.rs` (`video: Vec<VideoAu>{bytes,pts_sec,is_keyframe}`, `audio: Vec<AudioAu>{bytes,pts_sec}`, `sps`,`pps`,`width`,`height`,`fps_num`,`fps_den`,`start_sec`). ✅
- `Signaling::keepalive(&self, &SessionInfo)` used in 5.4 matches `signaling.rs:53`. ✅
- `protocol::keyframe_request()` / `DisconnectReason::WarningForBeingIdle{seconds_until_kick}` match `protocol.rs`. ✅
- muxide API (`MuxerBuilder::new(&mut out)`, `.audio(AudioCodec::Opus,48000,2)`, `write_video(pts,&data,kf)`, `write_audio(pts,&pkt)`, `finish()`) matches `muxide 0.2.5` (verified against its `tests/opus_muxing.rs`). ✅

**Pure-vs-gated split (the "build here" guarantee):** Tasks 5.1, 5.2, 5.4 (helper), 5.5 (channels fix), 5.7 are **default-build, Windows-testable now**. Tasks 5.3, 5.4 (timer), 5.5 (wire), 5.6, 5.8 compile under `--features native-webrtc` (WSL) and live-validate on CachyOS. ✅
