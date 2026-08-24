import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { streamAudio } from "./streamAudio.js";

/**
 * Fake Web Audio + <video> doubles. streamAudio must never touch a real
 * AudioContext in tests, and the assertions only need the observable surface:
 * which source node was created, the gain value, and the element's audio state.
 */
type Calls = { elementTaps: number; streamTaps: unknown[] };

let calls: Calls;
let gain: { gain: { value: number }; connect: () => void; disconnect: () => void };

function installAudioContext(opts: { throws?: boolean } = {}) {
  calls = { elementTaps: 0, streamTaps: [] };
  class FakeAudioContext {
    state = "running";
    destination = {};
    constructor() {
      if (opts.throws) throw new Error("AudioContext unavailable");
    }
    createGain() {
      gain = { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
      return gain;
    }
    createMediaElementSource() {
      calls.elementTaps++;
      return { connect: () => {}, disconnect: () => {} };
    }
    createMediaStreamSource(stream: unknown) {
      calls.streamTaps.push(stream);
      return { connect: () => {}, disconnect: () => {} };
    }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  (globalThis as Record<string, unknown>).AudioContext = FakeAudioContext;
}

function fakeVideo() {
  return { volume: 1, muted: false } as HTMLVideoElement;
}
const fakeStream = () => ({ id: "stream-1" }) as unknown as MediaStream;

beforeEach(() => installAudioContext());
afterEach(() => streamAudio.dispose());

describe("streamAudio — WebRTC audio tap", () => {
  it("taps the MediaStream, not the <video> element", () => {
    // Chromium's createMediaElementSource() yields a SILENT node for an element
    // whose source is a MediaStream (srcObject) — and does not throw, so the
    // catch-based fallback never fires. Tapping the stream is the only path
    // that carries samples.
    const stream = fakeStream();
    streamAudio.attach(fakeVideo(), stream);

    expect(calls.elementTaps).toBe(0);
    expect(calls.streamTaps).toEqual([stream]);
  });

  it("routes the slider gain to the GainNode while the graph is live", () => {
    streamAudio.attach(fakeVideo(), fakeStream());
    streamAudio.setGain(1.5);
    expect(gain.gain.value).toBe(1.5);
  });

  it("mutes the element while the graph is live so audio is not doubled", () => {
    // A stream tap leaves the element's own output intact (unlike an element
    // tap, which re-routes it), so the element must be silenced explicitly.
    const video = fakeVideo();
    streamAudio.attach(video, fakeStream());
    expect(video.muted).toBe(true);
  });

  it("falls back to element .volume when the AudioContext cannot be built", () => {
    installAudioContext({ throws: true });
    const video = fakeVideo();
    streamAudio.attach(video, fakeStream());

    streamAudio.setGain(0.4);
    expect(video.volume).toBeCloseTo(0.4);
    expect(video.muted).toBe(false); // still audible — the slider is never inert
  });

  it("re-points a focus-mode element swap at the same live graph", () => {
    const stream = fakeStream();
    const first = fakeVideo();
    streamAudio.attach(first, stream);
    const second = fakeVideo();
    streamAudio.attach(second, stream);

    expect(calls.streamTaps).toHaveLength(1); // same stream — no re-tap
    expect(second.muted).toBe(true);
  });
});
