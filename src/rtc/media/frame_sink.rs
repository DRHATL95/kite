//! `SharedFrame`: the cross-thread render seam. The engine's decode thread `put`s
//! the latest decoded frame; the GTK GL thread `take_latest`s it for upload.
//! Latest-wins (an unconsumed frame is dropped on the next `put`) — for live
//! video we want the freshest frame, not a backlog.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::rtc::media::DecodedFrame;

#[derive(Default)]
pub struct SharedFrame {
    slot: Mutex<Option<DecodedFrame>>,
    /// Mirrors `slot.is_some()` for a lock-free `has_pending()` poll.
    pending: AtomicBool,
}

impl SharedFrame {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Store the latest frame, dropping any previous unconsumed one.
    pub fn put(&self, frame: DecodedFrame) {
        *self.slot.lock().unwrap() = Some(frame);
        self.pending.store(true, Ordering::Release);
    }

    /// Take the latest frame if present, clearing the slot.
    pub fn take_latest(&self) -> Option<DecodedFrame> {
        let frame = self.slot.lock().unwrap().take();
        if frame.is_some() {
            self.pending.store(false, Ordering::Release);
        }
        frame
    }

    /// Lock-free check for a waiting frame. Lets the GTK render tick skip
    /// `queue_render` when idle so it doesn't churn the main thread (and starve
    /// the WebKit HUD) at 60fps with nothing new to show.
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

    #[test]
    fn shared_across_threads() {
        use std::sync::Arc;
        let sink = SharedFrame::new();
        let w = Arc::clone(&sink);
        std::thread::spawn(move || w.put(frame(9))).join().unwrap();
        assert_eq!(sink.take_latest().unwrap().pts_micros, 9);
    }
}
