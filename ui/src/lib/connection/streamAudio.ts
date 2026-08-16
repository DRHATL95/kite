// ui/src/lib/connection/streamAudio.ts
/**
 * streamAudio — module singleton that routes the browser <video> element's
 * audio through a Web Audio graph so volume can exceed 100% (GainNode) and be
 * directed to a chosen output device (AudioContext.setSinkId).
 *
 * A singleton, not a Svelte prop, because two components coordinate around it:
 * Stream.svelte owns the <video> element; StreamControls owns the volume value.
 * The singleton bridges them and remembers the last gain + sink so attach-order
 * doesn't matter.
 *
 * When the graph is live the GainNode is the sole volume authority and the
 * element's .volume is pinned neutral (1.0), so effective level == gain
 * regardless of how the browser treats element volume after the tap. When the
 * graph can't be built, the element's own .volume is the 0–100% authority so the
 * slider never goes inert (see applyLevel) — the spec §5 degradation guarantee.
 *
 * Every operation is best-effort and never throws into the caller: on any
 * failure audio simply plays without boost/routing. Playback must never break.
 */

// AudioContext augmented with the (Chromium 110+) setSinkId method.
type SinkableAudioContext = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

let ctx: SinkableAudioContext | null = null;
let currentEl: HTMLVideoElement | null = null;
let managedEl: HTMLVideoElement | null = null; // element whose .volume we fall back to
let source: MediaElementAudioSourceNode | null = null;
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
 * connected the GainNode is the sole authority (0–1.5) and the element volume is
 * pinned neutral (1.0), so effective level == gain regardless of whether the
 * browser honours element volume after the tap. When the graph is NOT live
 * (AudioContext or createMediaElementSource failed), the element's own .volume
 * is the authority for the 0–100% region — so the slider is never inert. This is
 * the spec §5 "degrade to plain audio at <=100%" guarantee.
 */
function applyLevel(): void {
  const graphLive = !!(gainNode && source);
  if (graphLive) {
    gainNode!.gain.value = lastGain;
    if (managedEl) managedEl.volume = 1;
  } else if (managedEl) {
    managedEl.volume = Math.min(1, lastGain);
  }
}

export const streamAudio = {
  /**
   * Route `video`'s audio through the graph. Idempotent per element; a NEW
   * element rebuilds the source (createMediaElementSource may tap each element
   * only once — but a focus-mode swap unmounts the old element, so this only
   * ever taps a fresh one).
   */
  attach(video: HTMLVideoElement): void {
    managedEl = video; // remembered even if the tap fails, for the volume fallback
    if (video === currentEl && source) {
      applyLevel();
      return;
    }
    const c = ensureContext();
    if (!c || !gainNode) {
      applyLevel(); // no graph → the element's own .volume is the authority
      return;
    }
    try {
      source?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      source = c.createMediaElementSource(video);
      source.connect(gainNode);
      currentEl = video;
      void this.setSinkId(lastSinkId);
    } catch (err) {
      // Element already tapped or source creation failed — fall back to the
      // element's own .volume (applyLevel handles it). Boost won't apply.
      console.warn("streamAudio: attach failed", err);
      source = null;
      currentEl = null;
    }
    applyLevel();
  },

  /** Set the linear gain (0–1.5). Remembered even before attach. Routed to the
   *  live authority (GainNode, or the element's .volume fallback) by applyLevel. */
  setGain(gain: number): void {
    lastGain = gain;
    applyLevel();
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
    currentEl = null;
    managedEl = null;
  },
};
