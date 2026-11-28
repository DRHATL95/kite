//! `SharedFrame`: the cross-thread render seam. The engine's decode thread `put`s
//! decoded frames; the GTK thread takes them for display.
//!
//! Two ways to take:
//! - [`take_due`](SharedFrame::take_due): paced playout for the app window. Frames
//!   wait in a short queue and come out on their own timestamps plus a small fixed
//!   delay, so uneven arrival is shown evenly.
//! - [`take_latest`](SharedFrame::take_latest): the freshest frame, dropping the
//!   rest. Used by the standalone GLArea renderer and the examples.
//!
//! Why the queue: frames arrive 60 a second but in bursts (measured 2026-11-16: gaps
//! of 8 ms and 28 ms alternating). With a single latest-wins slot polled every 16 ms,
//! 12 to 22 frames a second were overwritten unseen and gameplay showed 37 to 48 fps.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::rtc::media::DecodedFrame;

/// Frames held for playout. More than this means the display is not keeping up, and
/// the oldest are dropped so latency stays bounded.
const QUEUE_CAP: usize = 4;
/// How long a frame waits past its timestamp-derived slot. Covers the measured arrival
/// jitter (about +-12 ms) at the cost of that much latency.
const PLAYOUT_DELAY: Duration = Duration::from_millis(12);
/// A frame further than this from its slot means the timeline broke (stream restart,
/// freeze, clock drift): start a new timeline from that frame instead of waiting.
const RESYNC: Duration = Duration::from_millis(100);

#[derive(Default)]
struct Playout {
    queue: VecDeque<DecodedFrame>,
    /// (frame timestamp, local time) pair that anchors the timeline.
    base: Option<(u64, Instant)>,
}

impl Playout {
    /// Keep the timeline on the earliest arrival seen. Without this, a timeline
    /// started by a frame that came late holds every later frame back by that
    /// lateness (measured 2026-11-27: a steady 54 ms from arrival to draw, not 16).
    // ponytail: only ever moves earlier; a sender clock running slow is left to RESYNC.
    fn note_arrival(&mut self, pts: u64, now: Instant) {
        if let Some((pts0, t0)) = self.base
            && let Some(d) = pts.checked_sub(pts0).map(Duration::from_micros)
            && t0 + d > now
        {
            // Shift the line, keep its origin: frames still queued are older than
            // this one and must stay on the same timeline.
            self.base = now.checked_sub(d).map(|t0| (pts0, t0));
        }
    }

    /// Local time the front frame is due, anchoring the timeline to it when there is
    /// none or when it has drifted more than [`RESYNC`] from `now`.
    fn front_due(&mut self, now: Instant) -> Option<Instant> {
        let pts = self.queue.front()?.pts_micros;
        let due = self.base.and_then(|(pts0, t0)| {
            let due = t0 + Duration::from_micros(pts.checked_sub(pts0)?) + PLAYOUT_DELAY;
            let off = if due > now { due - now } else { now - due };
            (off <= RESYNC).then_some(due)
        });
        Some(due.unwrap_or_else(|| {
            // New timeline: this frame is due now, and the ones after it wait the
            // full playout delay. (Anchoring at `now - PLAYOUT_DELAY` left them no
            // margin at all when this frame happened to be a fast one.)
            self.base = Some((pts, now));
            now
        }))
    }
}

#[derive(Default)]
pub struct SharedFrame {
    playout: Mutex<Playout>,
    pending: AtomicBool,
    cleared: AtomicBool,
}

impl SharedFrame {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn put(&self, frame: DecodedFrame) {
        self.put_at(frame, Instant::now());
    }

    /// [`put`](Self::put) with the arrival time passed in, so tests need no sleeps.
    fn put_at(&self, frame: DecodedFrame, now: Instant) {
        let mut p = self.playout.lock().unwrap();
        p.note_arrival(frame.pts_micros, now);
        p.queue.push_back(frame);
        if p.queue.len() > QUEUE_CAP {
            // Behind: keep the newest frame only and start a new timeline from it.
            let keep = p.queue.len() - 1;
            p.queue.drain(..keep);
            p.base = None;
        }
        self.pending.store(true, Ordering::Release);
    }

    /// The next frame, if its playout time has come.
    pub fn take_due(&self, now: Instant) -> Option<DecodedFrame> {
        let mut p = self.playout.lock().unwrap();
        if p.front_due(now)? > now {
            return None;
        }
        let frame = p.queue.pop_front();
        self.pending.store(!p.queue.is_empty(), Ordering::Release);
        frame
    }

    /// True when [`take_due`](Self::take_due) would return a frame at `now`.
    pub fn has_due(&self, now: Instant) -> bool {
        self.has_pending()
            && self
                .playout
                .lock()
                .unwrap()
                .front_due(now)
                .is_some_and(|due| due <= now)
    }

    /// The freshest frame, discarding any older ones still queued.
    pub fn take_latest(&self) -> Option<DecodedFrame> {
        let mut p = self.playout.lock().unwrap();
        let frame = p.queue.pop_back();
        p.queue.clear();
        p.base = None;
        self.pending.store(false, Ordering::Release);
        frame
    }

    /// Drop any unconsumed frames and tell the renderer to forget its picture.
    /// Called when a stream ends so its last frame never lingers on screen.
    pub fn clear(&self) {
        *self.playout.lock().unwrap() = Playout::default();
        self.pending.store(false, Ordering::Release);
        self.cleared.store(true, Ordering::Release);
    }

    /// True once after each [`clear`](Self::clear).
    pub fn take_cleared(&self) -> bool {
        self.cleared.swap(false, Ordering::AcqRel)
    }

    pub fn has_pending(&self) -> bool {
        self.pending.load(Ordering::Acquire)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rtc::media::{DecodedFrame, FramePixels, PixelFormat};

    fn frame(tag: u8) -> DecodedFrame {
        DecodedFrame {
            width: 2,
            height: 2,
            pts_micros: tag as u64,
            pixels: FramePixels::Cpu {
                format: PixelFormat::I420,
                planes: vec![vec![tag; 4], vec![tag; 1], vec![tag; 1]],
                strides: vec![2, 1, 1],
            },
        }
    }

    #[test]
    fn clear_drops_the_frame_and_reports_once() {
        let sink = SharedFrame::new();
        sink.put(frame(3));
        sink.clear();
        assert!(!sink.has_pending() && sink.take_latest().is_none());
        assert!(sink.take_cleared());
        assert!(!sink.take_cleared(), "reported once");
    }

    #[test]
    fn take_latest_is_none_when_empty() {
        let sink = SharedFrame::new();
        assert!(sink.take_latest().is_none());
    }

    #[test]
    fn put_then_take_returns_the_frame_once() {
        let sink = SharedFrame::new();
        sink.put(frame(7));
        let got = sink.take_latest().expect("a frame");
        assert_eq!(got.pts_micros, 7);
        assert!(sink.take_latest().is_none(), "consumed — slot now empty");
    }

    #[test]
    fn has_pending_tracks_put_and_take() {
        let sink = SharedFrame::new();
        assert!(!sink.has_pending(), "empty → nothing pending");
        sink.put(frame(1));
        assert!(sink.has_pending(), "after put → pending");
        let _ = sink.take_latest();
        assert!(!sink.has_pending(), "after take → not pending");
    }

    #[test]
    fn put_replaces_an_unconsumed_frame_latest_wins() {
        let sink = SharedFrame::new();
        sink.put(frame(1));
        sink.put(frame(2)); // 1 was never taken → dropped
        assert_eq!(sink.take_latest().unwrap().pts_micros, 2);
        assert!(sink.take_latest().is_none());
    }

    fn at(ms: u64) -> DecodedFrame {
        let mut f = frame(0);
        f.pts_micros = ms * 1000;
        f
    }

    #[test]
    fn take_due_paces_a_burst_by_timestamp() {
        let sink = SharedFrame::new();
        let t = Instant::now();
        // Two frames 16 ms apart in stream time arrive together.
        sink.put(at(1000));
        sink.put(at(1016));
        assert_eq!(
            sink.take_due(t).unwrap().pts_micros,
            1_000_000,
            "first frame starts the timeline"
        );
        assert!(
            sink.take_due(t + Duration::from_millis(8)).is_none(),
            "second is not due yet"
        );
        assert!(sink.has_pending() && !sink.has_due(t + Duration::from_millis(8)));
        assert_eq!(
            sink.take_due(t + Duration::from_millis(16) + PLAYOUT_DELAY)
                .unwrap()
                .pts_micros,
            1_016_000
        );
        assert!(!sink.has_pending());
    }

    #[test]
    fn a_late_first_frame_does_not_delay_the_rest() {
        let sink = SharedFrame::new();
        let t = Instant::now();
        let ms = Duration::from_millis;
        // Frame 0 is shown 40 ms late; frame 1 (16 ms later in stream time) arrives then.
        sink.put_at(at(1000), t);
        assert!(sink.take_due(t + ms(40)).is_some());
        sink.put_at(at(1016), t + ms(40));
        assert!(
            sink.take_due(t + ms(40) + PLAYOUT_DELAY).is_some(),
            "due one playout delay after it arrived, not 16 ms after the late frame"
        );
    }

    #[test]
    fn frames_after_the_first_wait_the_full_playout_delay() {
        let sink = SharedFrame::new();
        let t = Instant::now();
        let ms = Duration::from_millis;
        sink.put_at(at(1000), t);
        assert!(
            sink.take_due(t).is_some(),
            "first frame starts the timeline"
        );
        // The next frame arrives exactly on time, 16 ms later.
        sink.put_at(at(1016), t + ms(16));
        assert!(
            sink.take_due(t + ms(16) + PLAYOUT_DELAY / 2).is_none(),
            "held for the playout delay so a slower frame behind it is still on time"
        );
        assert!(sink.take_due(t + ms(16) + PLAYOUT_DELAY).is_some());
    }

    #[test]
    fn an_early_arrival_keeps_queued_frames_on_the_timeline() {
        let sink = SharedFrame::new();
        let t = Instant::now();
        let ms = Duration::from_millis;
        sink.put_at(at(1000), t);
        assert!(sink.take_due(t + ms(40)).is_some());
        // Two frames arrive together. The second sets the pace, so the first was
        // already late and shows at once; the second keeps its place on the same
        // timeline, one playout delay after it arrived.
        let t = t + ms(40);
        sink.put_at(at(1016), t);
        sink.put_at(at(1033), t);
        assert_eq!(sink.take_due(t).unwrap().pts_micros, 1_016_000);
        assert!(sink.take_due(t).is_none(), "1033 waits its playout delay");
        assert_eq!(
            sink.take_due(t + PLAYOUT_DELAY).unwrap().pts_micros,
            1_033_000,
            "and no longer than that"
        );
    }

    #[test]
    fn take_due_resyncs_after_a_gap_instead_of_waiting() {
        let sink = SharedFrame::new();
        let t = Instant::now();
        sink.put(at(1000));
        assert!(sink.take_due(t).is_some());
        // Half a second of nothing, then a frame whose timestamp jumped 5 s.
        sink.put(at(6000));
        assert!(
            sink.take_due(t + Duration::from_millis(500)).is_some(),
            "shown at once on a new timeline"
        );
    }

    #[test]
    fn put_past_the_cap_keeps_only_the_newest() {
        let sink = SharedFrame::new();
        for i in 0..=QUEUE_CAP as u64 {
            sink.put(at(1000 + 16 * i));
        }
        let t = Instant::now();
        assert_eq!(
            sink.take_due(t).unwrap().pts_micros,
            (1000 + 16 * QUEUE_CAP as u64) * 1000
        );
        assert!(sink.take_due(t).is_none());
    }

    #[test]
    fn shared_across_threads() {
        use std::sync::Arc;
        let sink = SharedFrame::new();
        let w = Arc::clone(&sink);
        std::thread::spawn(move || w.put(frame(9))).join().unwrap();
        assert_eq!(sink.take_latest().unwrap().pts_micros, 9);
    }
}
