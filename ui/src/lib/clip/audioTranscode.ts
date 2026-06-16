/**
 * audioTranscode.ts — transcode buffered Opus packets to AAC on Clip.
 *
 * WebRTC delivers audio as Opus; the most-native clip container wants AAC. This
 * runs the OS encoder via WebCodecs (no fdk-aac / licensing) and only fires when
 * the user clips — never during streaming — so it has zero impact on the live
 * session. Timestamps are preserved end-to-end so A/V stays in sync.
 *
 * The encoder emits *raw* AAC plus an AudioSpecificConfig; the Rust muxer
 * ADTS-wraps the frames, so `config` is informational here. On any failure the
 * caller falls back to muxing the original Opus (still a valid MP4).
 */
import type { EncodedFrame } from "./encodedTapLogic.js";

export interface AacResult {
  /** AudioSpecificConfig from the encoder (informational; muxer derives ADTS). */
  config: Uint8Array;
  /** Encoded AAC frames with preserved presentation times. */
  frames: { bytes: Uint8Array; ptsSec: number }[];
}

/** Decode buffered Opus packets and re-encode to AAC-LC, preserving timestamps. */
export async function transcodeOpusToAac(
  opus: EncodedFrame[],
  sampleRate = 48000,
  channels = 2,
  bitrate = 128_000,
): Promise<AacResult> {
  const out: AacResult = { config: new Uint8Array(), frames: [] };
  if (opus.length === 0) return out;

  const decoded: AudioData[] = [];
  const decoder = new AudioDecoder({
    output: (d) => decoded.push(d),
    error: (e) => {
      throw e;
    },
  });
  decoder.configure({ codec: "opus", sampleRate, numberOfChannels: channels });
  for (const f of opus) {
    decoder.decode(
      new EncodedAudioChunk({
        type: "key",
        timestamp: Math.round(f.ptsSec * 1e6),
        data: f.bytes,
      }),
    );
  }
  await decoder.flush();
  decoder.close();

  await new Promise<void>((resolve, reject) => {
    const encoder = new AudioEncoder({
      output: (chunk, meta) => {
        const desc = meta?.decoderConfig?.description;
        if (desc) out.config = new Uint8Array(desc as ArrayBuffer);
        const b = new Uint8Array(chunk.byteLength);
        chunk.copyTo(b);
        out.frames.push({ bytes: b, ptsSec: chunk.timestamp / 1e6 });
      },
      error: reject,
    });
    encoder.configure({
      codec: "mp4a.40.2", // AAC-LC
      sampleRate,
      numberOfChannels: channels,
      bitrate,
    });
    for (const d of decoded) {
      encoder.encode(d);
      d.close();
    }
    encoder
      .flush()
      .then(() => {
        encoder.close();
        resolve();
      })
      .catch(reject);
  });

  return out;
}
