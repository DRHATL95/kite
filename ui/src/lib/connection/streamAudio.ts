// ui/src/lib/connection/streamAudio.ts
/**
 * streamAudio — module singleton that routes the WebRTC audio track through a
 * Web Audio graph so playback level (GainNode) and output device
 * (AudioContext.setSinkId) are both controllable. The graph is required for the
 * device picker, so it stays even though the level never exceeds unity.
 *
 * A singleton, not a Svelte prop, because two components coordinate around it:
 * Stream.svelte owns the <video> element + MediaStream; StreamControls owns the
 * volume value. The singleton bridges them and remembers the last gain + sink so
 * attach-order doesn't matter.
 *
 * The graph taps the MediaStream (createMediaStreamSource), NOT the <video>
 * element. Chromium's createMediaElementSource() returns a node that carries
 * ZERO samples when the element's source is a MediaStream (srcObject) — and it
 * does not throw, so a try/catch fallback never fires. Tapping the element left
 * the gain node silent and the volume slider inert. Tap the stream.
 *
 * Because a stream tap leaves the element's own audio output intact (an element
 * tap would have re-routed it), the element is muted while the graph is live —
 * otherwise the same audio plays twice, once at a level the slider can't reach.
 *
 * When the graph can't be built, the element's own .volume is the 0–100%
 * authority so the slider never goes inert (see applyLevel) — the spec §5
 * degradation guarantee. Mute in that mode is simply gain 0.
 *
 * Every operation is best-effort and never throws into the caller: on any
 * failure audio simply plays without boost/routing. Playback must never break.
 */

// AudioContext augmented with the (Chromium 110+) setSinkId method.
type SinkableAudioContext = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

let ctx: SinkableAudioContext | null = null;
let currentStream: MediaStream | null = null;
let managedEl: HTMLVideoElement | null = null; // element whose audio we own
let source: MediaStreamAudioSourceNode | null = null;
let gainNode: GainNode | null = null;
let lastGain = 1;
let lastSinkId = "";

function ensureContext(): SinkableAudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new AudioContext() as SinkableAudioContext;
    gainNode = ctx.createGain();
    gainNode.gain.value = lastGain;
    gainNode.connect(ctx.destination);
    return ctx;
  } catch (err) {
    console.warn("streamAudio: AudioContext unavailable", err);
    ctx = null;
    return null;
  }
}

/**
 * Apply the remembered gain to whichever authority is live. When the graph is
 * connected the GainNode is the sole authority (0–1) and the element is muted
 * so its untouched output can't double the audio. When the graph is NOT live
 * (AudioContext or createMediaStreamSource failed), the element's own .volume is
 * the authority for the 0–100% region — so the slider is never inert. Muting in
 * that mode is gain 0; `muted` is left to the caller's autoplay handling.
 */
function applyLevel(): void {
  const graphLive = !!(gainNode && source);
  if (graphLive) {
    gainNode!.gain.value = lastGain;
    if (managedEl) managedEl.muted = true;
  } else if (managedEl) {
    managedEl.volume = Math.min(1, lastGain);
  }
}

export const streamAudio = {
  /**
   * Route `stream`'s audio through the graph and hand element ownership to
   * `video`. Idempotent per stream: a focus-mode element swap re-points the
   * element without rebuilding the graph (the tap is bound to the stream, not
   * the element), and a new stream rebuilds the source.
   */
  attach(video: HTMLVideoElement, stream: MediaStream | null): void {
    managedEl = video; // remembered even if the tap fails, for the volume fallback
    if (stream && stream === currentStream && source) {
      applyLevel();
      return;
    }
    const c = ensureContext();
    if (!c || !gainNode || !stream) {
      applyLevel(); // no graph → the element's own .volume is the authority
      return;
    }
    try {
      source?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      source = c.createMediaStreamSource(stream);
      source.connect(gainNode);
      currentStream = stream;
      void this.setSinkId(lastSinkId);
    } catch (err) {
      // Source creation failed — fall back to the element's own .volume
      // (applyLevel handles it). Boost won't apply.
      console.warn("streamAudio: attach failed", err);
      source = null;
      currentStream = null;
    }
    applyLevel();
  },

  /** Set the linear gain (0–1, unity at 1). Remembered even before attach. Routed
   *  to the live authority (GainNode, or the element's .volume fallback) by
   *  applyLevel. */
  setGain(gain: number): void {
    lastGain = gain;
    applyLevel();
  },

  /** True while the Web Audio graph is carrying the audio (so the element is
   *  muted by us and autoplay/unmute keys off the context, not element.muted). */
  isGraphLive(): boolean {
    return !!(gainNode && source);
  },

  /**
   * Route output to a device id ("" / null = system default). Resolves false
   * if AudioContext.setSinkId is unsupported or the call fails (device gone).
   */
  async setSinkId(deviceId: string | null): Promise<boolean> {
    lastSinkId = deviceId ?? "";
    const c = ctx;
    if (!c || typeof c.setSinkId !== "function") return false;
    try {
      await c.setSinkId(lastSinkId);
      return true;
    } catch (err) {
      console.warn("streamAudio: setSinkId failed", err);
      return false;
    }
  },

  /** Resume the context — call from a user gesture (unmute / play). */
  resume(): void {
    void ctx?.resume().catch(() => {});
  },

  /** True while the context exists but is suspended (needs a gesture). */
  isSuspended(): boolean {
    return ctx?.state === "suspended";
  },

  /** Tear down the graph + context (stream end / unmount). Keeps last gain/sink. */
  dispose(): void {
    try {
      source?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      gainNode?.disconnect();
    } catch {
      /* ignore */
    }
    void ctx?.close().catch(() => {});
    ctx = null;
    source = null;
    gainNode = null;
    currentStream = null;
    managedEl = null;
  },
};
