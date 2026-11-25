// pcmTap.worklet.js — AudioWorklet for nativeAudio.ts (runs on the audio thread).
//
// Converts the graph's audio (after the volume GainNode) to interleaved 16-bit
// stereo and posts it to the page in 10 ms chunks (480 frames at the 48 kHz the
// context is created at). Each chunk's buffer is transferred, not copied. The
// node's own output stays silent: kite.exe plays the audio instead.

const CHUNK_FRAMES = 480;

class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Int16Array(CHUNK_FRAMES * 2);
    this.frames = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input.length === 0) return true; // no source connected yet / stream ended
    const left = input[0];
    const right = input[1] ?? left; // mono source: same signal on both sides
    for (let i = 0; i < left.length; i++) {
      const at = this.frames * 2;
      this.chunk[at] = toI16(left[i]);
      this.chunk[at + 1] = toI16(right[i]);
      if (++this.frames === CHUNK_FRAMES) {
        this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
        this.chunk = new Int16Array(CHUNK_FRAMES * 2);
        this.frames = 0;
      }
    }
    return true;
  }
}

function toI16(x) {
  const s = x < -1 ? -1 : x > 1 ? 1 : x;
  return s < 0 ? s * 0x8000 : s * 0x7fff;
}

registerProcessor("pcm-tap", PcmTap);
