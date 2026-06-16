/**
 * clipPayload.ts — pack a captured clip into the binary wire format that
 * `src/clip.rs::ClipPayload::parse` reads. Little-endian throughout (via
 * DataView). The byte layout is defined once in `src/clip.rs` and mirrored here;
 * a shared byte fixture in both test suites guards against drift.
 *
 * ```text
 * [u32 magic 'XCLP' = 0x58434C50][u8 version = 1]
 * [u16 width][u16 height][u16 fps_num][u16 fps_den]
 * [u32 sps_len][sps][u32 pps_len][pps][u32 aac_config_len][aac config]
 * [u32 video_count] then × [u8 keyframe][f64 pts_sec][u32 len][nal bytes]
 * [u32 audio_count] then × [f64 pts_sec][u32 len][aac bytes]
 * ```
 */

export const CLIP_MAGIC = 0x58434c50; // 'XCLP'
export const CLIP_VERSION = 1;

export interface PackVideoFrame {
  bytes: Uint8Array;
  ptsSec: number;
  isKeyframe: boolean;
}
export interface PackAudioFrame {
  bytes: Uint8Array;
  ptsSec: number;
}

export interface ClipPayloadInput {
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  sps: Uint8Array;
  pps: Uint8Array;
  aacConfig: Uint8Array;
  video: PackVideoFrame[];
  audio: PackAudioFrame[];
}

/** Serialize a clip to the binary payload consumed by the Rust `save_clip` command. */
export function packClipPayload(p: ClipPayloadInput): Uint8Array {
  let size = 4 + 1 + 8; // magic + version + (width, height, fpsNum, fpsDen)
  size += 4 + p.sps.length + 4 + p.pps.length + 4 + p.aacConfig.length;
  size += 4; // video_count
  for (const f of p.video) size += 1 + 8 + 4 + f.bytes.length;
  size += 4; // audio_count
  for (const f of p.audio) size += 8 + 4 + f.bytes.length;

  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  const out = new Uint8Array(buf);
  let o = 0;

  view.setUint32(o, CLIP_MAGIC, true);
  o += 4;
  view.setUint8(o, CLIP_VERSION);
  o += 1;
  view.setUint16(o, p.width, true);
  o += 2;
  view.setUint16(o, p.height, true);
  o += 2;
  view.setUint16(o, p.fpsNum, true);
  o += 2;
  view.setUint16(o, p.fpsDen, true);
  o += 2;

  o = writeBlob(view, out, o, p.sps);
  o = writeBlob(view, out, o, p.pps);
  o = writeBlob(view, out, o, p.aacConfig);

  view.setUint32(o, p.video.length, true);
  o += 4;
  for (const f of p.video) {
    view.setUint8(o, f.isKeyframe ? 1 : 0);
    o += 1;
    view.setFloat64(o, f.ptsSec, true);
    o += 8;
    o = writeBlob(view, out, o, f.bytes);
  }

  view.setUint32(o, p.audio.length, true);
  o += 4;
  for (const f of p.audio) {
    view.setFloat64(o, f.ptsSec, true);
    o += 8;
    o = writeBlob(view, out, o, f.bytes);
  }

  return out;
}

function writeBlob(
  view: DataView,
  out: Uint8Array,
  offset: number,
  blob: Uint8Array,
): number {
  view.setUint32(offset, blob.length, true);
  offset += 4;
  out.set(blob, offset);
  return offset + blob.length;
}
