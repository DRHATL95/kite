//! Lifecycle of the one stream an engine can hold: connect, cancel, replace, end.
//!
//! Everything slow (signing in, starting the stream, closing it) runs on worker
//! threads, so the commands that call in here return at once. A generation number
//! names the stream the host currently wants: every connect and disconnect bumps it,
//! and a worker that finds its generation is no longer current closes what it started
//! and stays silent.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::{Emitter, KiteEventKind};

/// How often neutral input is sent. The console drops a session that sends no input
/// for about a minute; 16 ms is the 1.x gamepad poll rate.
// ponytail: neutral frames stand in for real gamepads until Phase 2 reads them here.
const IDLE_INPUT_EVERY: Duration = Duration::from_millis(16);

/// What this module needs from a running stream. A fake stands in for tests.
pub(crate) trait Stream: Send + 'static {
    fn idle_input(&self);
    /// Close the stream and wait until it is closed on the console.
    fn stop(self);
}

/// One event from a stream, ready to be delivered.
pub(crate) type Deliver = Box<dyn FnOnce(&Emitter) + Send>;
/// Blocks for the stream's next event; ends when the stream has ended.
pub(crate) type Events = Box<dyn Iterator<Item = Deliver> + Send>;

struct Slot<S> {
    generation: u64,
    connecting: bool,
    stream: Option<S>,
    workers: Vec<JoinHandle<()>>,
}

pub(crate) struct Sessions<S: Stream> {
    slot: Arc<Mutex<Slot<S>>>,
    emitter: Arc<Emitter>,
}

fn lock<S>(slot: &Mutex<Slot<S>>) -> MutexGuard<'_, Slot<S>> {
    slot.lock().unwrap_or_else(PoisonError::into_inner)
}

impl<S: Stream> Sessions<S> {
    pub(crate) fn new(emitter: Arc<Emitter>) -> Self {
        Self {
            slot: Arc::new(Mutex::new(Slot {
                generation: 0,
                connecting: false,
                stream: None,
                workers: Vec::new(),
            })),
            emitter,
        }
    }

    /// Replace whatever is running with a new stream. `start` does the slow work and
    /// runs on a worker thread. Fails only if that thread cannot be created.
    pub(crate) fn connect(
        &self,
        start: impl FnOnce() -> Result<(S, Events), String> + Send + 'static,
    ) -> std::io::Result<()> {
        let mut slot = lock(&self.slot);
        slot.generation += 1;
        slot.connecting = true;
        let generation = slot.generation;
        let previous = slot.stream.take();
        let (shared, emitter) = (Arc::clone(&self.slot), Arc::clone(&self.emitter));
        let worker = std::thread::Builder::new()
            .name("libkite-session".into())
            .spawn(move || run(shared, emitter, generation, previous, start));
        match worker {
            Ok(worker) => {
                slot.workers.retain(|w| !w.is_finished());
                slot.workers.push(worker);
                Ok(())
            }
            Err(e) => {
                slot.connecting = false;
                Err(e)
            }
        }
    }

    /// End the stream, or cancel a connect that has not finished. Returns false when
    /// there was neither. Does not wait: `Disconnected` is emitted once it is closed.
    pub(crate) fn disconnect(&self) -> bool {
        let mut slot = lock(&self.slot);
        let was_active = slot.connecting || slot.stream.is_some();
        slot.generation += 1;
        slot.connecting = false;
        if let Some(stream) = slot.stream.take() {
            let emitter = Arc::clone(&self.emitter);
            let worker = std::thread::Builder::new()
                .name("libkite-close".into())
                .spawn(move || close(stream, &emitter));
            // If no thread can be had, the stream was dropped with the closure: the
            // engine sees its command channel close and ends by itself.
            if let Ok(worker) = worker {
                slot.workers.push(worker);
            }
        }
        was_active
    }

    /// End everything and wait for it: the stream is closed on the console and no
    /// worker thread is left running when this returns.
    pub(crate) fn shutdown(&self) {
        let (stream, workers) = {
            let mut slot = lock(&self.slot);
            slot.generation += 1;
            slot.connecting = false;
            (slot.stream.take(), std::mem::take(&mut slot.workers))
        };
        if let Some(stream) = stream {
            stream.stop();
        }
        for worker in workers {
            let _ = worker.join();
        }
    }
}

fn close<S: Stream>(stream: S, emitter: &Emitter) {
    stream.stop();
    emitter.text(KiteEventKind::Disconnected, "closed by the host");
}

/// Body of the session worker thread.
fn run<S: Stream>(
    slot: Arc<Mutex<Slot<S>>>,
    emitter: Arc<Emitter>,
    generation: u64,
    previous: Option<S>,
    start: impl FnOnce() -> Result<(S, Events), String>,
) {
    let current = |slot: &Mutex<Slot<S>>| lock(slot).generation == generation;
    if let Some(previous) = previous {
        previous.stop();
    }
    let (stream, events) = match start() {
        Ok(started) => started,
        Err(message) => {
            let mut guard = lock(&slot);
            if guard.generation == generation {
                guard.connecting = false;
                drop(guard);
                emitter.text(KiteEventKind::Error, &message);
            }
            return;
        }
    };
    {
        let mut guard = lock(&slot);
        if guard.generation != generation {
            // Cancelled or replaced while starting: never became the host's stream.
            drop(guard);
            return close(stream, &emitter);
        }
        guard.stream = Some(stream);
        guard.connecting = false;
        let shared = Arc::clone(&slot);
        let idle = std::thread::Builder::new()
            .name("libkite-input".into())
            .spawn(move || {
                loop {
                    std::thread::sleep(IDLE_INPUT_EVERY);
                    let guard = lock(&shared);
                    match &guard.stream {
                        Some(stream) if guard.generation == generation => stream.idle_input(),
                        _ => break,
                    }
                }
            });
        if let Ok(idle) = idle {
            guard.workers.push(idle);
        }
    }
    for deliver in events {
        if current(&slot) {
            deliver(&emitter);
        }
    }
    // The stream ended by itself. Clear it so the slot does not hold a dead handle.
    let ended = {
        let mut guard = lock(&slot);
        (guard.generation == generation)
            .then(|| guard.stream.take())
            .flatten()
    };
    if let Some(ended) = ended {
        ended.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::mpsc;

    #[derive(Default)]
    struct Probe {
        stopped: AtomicBool,
        idle_inputs: AtomicUsize,
    }

    /// Stopping it ends its event stream, as closing a real stream does.
    struct Fake(Arc<Probe>, mpsc::Sender<()>);

    impl Stream for Fake {
        fn idle_input(&self) {
            self.0.idle_inputs.fetch_add(1, Ordering::SeqCst);
        }
        fn stop(self) {
            self.0.stopped.store(true, Ordering::SeqCst);
            let _ = self.1.send(());
        }
    }

    fn sessions() -> Sessions<Fake> {
        Sessions::new(Arc::new(Emitter::silent()))
    }

    /// A stream that starts when `go` is sent and runs until stopped or `end` is sent.
    #[allow(clippy::type_complexity)]
    fn gated(
        probe: &Arc<Probe>,
    ) -> (
        impl FnOnce() -> Result<(Fake, Events), String> + Send + 'static,
        mpsc::Sender<()>,
        mpsc::Sender<()>,
    ) {
        let (go, started) = mpsc::channel::<()>();
        let (end, ended) = mpsc::channel::<()>();
        let probe = Arc::clone(probe);
        let end_on_stop = end.clone();
        let start = move || {
            let _ = started.recv();
            let events: Events = Box::new(std::iter::from_fn(move || {
                let _ = ended.recv();
                None
            }));
            Ok((Fake(probe, end_on_stop), events))
        };
        (start, go, end)
    }

    #[test]
    fn disconnect_cancels_a_connect_that_has_not_finished() {
        let s = sessions();
        let probe = Arc::new(Probe::default());
        let (start, go, _end) = gated(&probe);
        s.connect(start).unwrap();
        assert!(s.disconnect(), "a connect in flight counts as active");
        go.send(()).unwrap();
        s.shutdown();
        assert!(probe.stopped.load(Ordering::SeqCst), "closed, not left up");
        assert_eq!(probe.idle_inputs.load(Ordering::SeqCst), 0, "never live");
    }

    #[test]
    fn a_second_connect_closes_the_first_stream() {
        let s = sessions();
        let (first, second) = (Arc::new(Probe::default()), Arc::new(Probe::default()));
        let (start1, go1, _end1) = gated(&first);
        let (start2, go2, _end2) = gated(&second);
        s.connect(start1).unwrap();
        s.connect(start2).unwrap();
        go1.send(()).unwrap();
        go2.send(()).unwrap();
        while second.idle_inputs.load(Ordering::SeqCst) == 0 {
            std::thread::yield_now();
        }
        assert!(first.stopped.load(Ordering::SeqCst));
        assert!(!second.stopped.load(Ordering::SeqCst));
        assert_eq!(first.idle_inputs.load(Ordering::SeqCst), 0);
        s.shutdown();
        assert!(second.stopped.load(Ordering::SeqCst));
    }

    #[test]
    fn a_stream_that_ends_by_itself_leaves_nothing_to_disconnect() {
        let s = sessions();
        let probe = Arc::new(Probe::default());
        let (start, go, end) = gated(&probe);
        s.connect(start).unwrap();
        go.send(()).unwrap();
        end.send(()).unwrap();
        while !probe.stopped.load(Ordering::SeqCst) {
            std::thread::yield_now();
        }
        assert!(!s.disconnect());
        s.shutdown();
    }

    #[test]
    fn shutdown_closes_the_stream_and_leaves_no_worker_running() {
        let s = sessions();
        let probe = Arc::new(Probe::default());
        let (start, go, _end) = gated(&probe);
        s.connect(start).unwrap();
        go.send(()).unwrap();
        while probe.idle_inputs.load(Ordering::SeqCst) == 0 {
            std::thread::yield_now();
        }
        s.shutdown();
        assert!(probe.stopped.load(Ordering::SeqCst));
        let after = probe.idle_inputs.load(Ordering::SeqCst);
        std::thread::sleep(IDLE_INPUT_EVERY * 4);
        assert_eq!(probe.idle_inputs.load(Ordering::SeqCst), after);
        assert!(lock(&s.slot).workers.is_empty());
    }

    #[test]
    fn a_failed_start_is_reported_and_leaves_nothing_active() {
        let s = sessions();
        s.connect(|| Err::<(Fake, Events), _>("no".to_string()))
            .unwrap();
        s.shutdown();
        assert!(!s.disconnect());
    }
}
