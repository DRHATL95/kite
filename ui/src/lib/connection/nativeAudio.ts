// ui/src/lib/connection/nativeAudio.ts
/**
 * nativeAudio — on Windows, plays the stream's audio from kite.exe, not WebView2.
 *
 * Discord's window share sends only the audio of the shared window's own
 * process. WebView2 renders page audio in a child msedgewebview2.exe, so a Kite
 * window share went out silent. Here an AudioWorklet (pcmTap.worklet.js) turns
 * the graph's post-volume audio into 48 kHz stereo i16 chunks, and a pump hands
 * them to Rust (src/audio_out.rs), which plays them through its own stream.
 *
 * streamAudio owns the graph and calls this; on any failure it rewires the graph
 * back to the page's own output, so audio never stops because this path broke.
 */
import tapUrl from "./pcmTap.worklet.js?url&no-inline";
import { audioOutPush, audioOutStart } from "$lib/ipc/commands.js";

/** The wire format src/audio_out.rs expects. The worklet does not resample. */
export const NATIVE_SAMPLE_RATE = 48_000;

/** Chunks (~10 ms each) allowed to wait behind a slow IPC call before the
 *  oldest are dropped; Rust's ring caps latency at 80 ms anyway. */
const MAX_QUEUED = 8;

/**
 * Forward chunks in order, one IPC call at a time. Chunks that arrive while a
 * call is in flight go out merged in the next call, so a slow IPC round trip
 * costs fewer calls, never reordered audio. Stops at the first failure and
 * reports it once.
 */
export function createPcmPump(
  push: (pcm: ArrayBuffer) => Promise<void>,
  onFailure: (err: unknown) => void,
): { send(chunk: ArrayBuffer): void } {
  let queue: ArrayBuffer[] = [];
  let inFlight = false;
  let failed = false;

  async function drain(): Promise<void> {
    inFlight = true;
    while (queue.length > 0 && !failed) {
      const batch = queue;
      queue = [];
      try {
        await push(concat(batch));
      } catch (err) {
        failed = true;
        queue = [];
        onFailure(err);
      }
    }
    inFlight = false;
  }

  return {
    send(chunk) {
      if (failed) return;
      queue.push(chunk);
      if (queue.length > MAX_QUEUED) queue.shift();
      if (!inFlight) void drain();
    },
  };
}

function concat(chunks: ArrayBuffer[]): ArrayBuffer {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(new Uint8Array(c), at);
    at += c.byteLength;
  }
  return out.buffer;
}

/**
 * Start native playback on `device` ("" = system default) and return the tap
 * node to wire in after the GainNode. Resolves null where there is no native
 * path (not Windows, or a context the tap can't serve); throws if starting
 * failed. The node's own output is silent.
 */
export async function startNativeAudio(
  ctx: AudioContext,
  device: string,
  onFailure: (err: unknown) => void,
): Promise<AudioWorkletNode | null> {
  if (ctx.sampleRate !== NATIVE_SAMPLE_RATE || !ctx.audioWorklet) return null;
  if (!(await audioOutStart(device))) return null;
  await ctx.audioWorklet.addModule(tapUrl);
  const node = new AudioWorkletNode(ctx, "pcm-tap", {
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  const pump = createPcmPump(audioOutPush, onFailure);
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => pump.send(e.data);
  return node;
}
