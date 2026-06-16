# Clipping v2 — Encoded-Frame Capture + Remux — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the re-encoding clip capture with WebRTC Insertable Streams — tap the Xbox's already-encoded H.264, buffer it in JS, transcode audio Opus→AAC via WebCodecs on-clip, and mux H.264+AAC into a native MP4 in Rust (muxide) — so clipping is lossless, never disturbs the stream, and produces clean keyframe-aligned files.

**Architecture:** JS taps encoded frames at the RTCRtpReceiver (`createEncodedStreams`), holds a small ring buffer of encoded frames, and on Clip slices from the last keyframe, transcodes the audio to AAC (WebCodecs), and ships the encoded frames to Rust over a raw IPC body. Rust muxes them with the `muxide` crate into a fragmented MP4. The working HW-H.264 `MediaRecorder` path stays as a runtime fallback.

**Tech Stack:** Svelte 5 + TS + Vitest (frontend), WebRTC Insertable Streams + WebCodecs (browser APIs), Rust + Tauri 2 + `muxide` (backend).

**Spec:** `docs/superpowers/specs/2026-06-16-clipping-encoded-frame-remux-design.md`.

---

## Orientation (read before Task 1)

- Current capture lives in `ui/src/lib/clip/ClipBuffer.ts` (MediaRecorder; now HW-H.264 — KEEP as fallback) and `ui/src/lib/clip/clipBufferLogic.ts`.
- Clip orchestration: `ui/src/lib/stores/clip.svelte.ts`. IPC: `ui/src/lib/ipc/commands.ts` (`saveClip`/`revealClip`). Backend: `save_clip` in `src/main.rs` (`mod tauri_commands`).
- Connection/WebRTC: `ui/src/lib/connection/ConnectionManager.ts` — `RTCPeerConnection` is created in `_setupWebRTC()`; tracks arrive in `_setupTrackHandler()`'s `pc.ontrack`.
- Settings already integrated: `settings.clip` in `ui/src/lib/stores/settings.svelte.ts`; UI in `ui/src/components/SettingsModal.svelte`; Clip button in `ui/src/components/StreamControls.svelte`.
- Run/verify commands: `npm --prefix ui run test` (vitest), `npm --prefix ui run check`, `cargo test`. App: `npm --prefix ui run build && cargo clean -p xbox-remote && cargo run` (must stop any running `xbox-remote.exe` first — it locks the binary).

---

## Task 1: SPIKE — confirm Insertable Streams format + stream-unaffected (HARDWARE, with owner)

De-risks the two biggest unknowns before building anything: (a) the encoded H.264 frame byte format (Annex-B start-codes vs AVCC length-prefix), (b) that `encodedInsertableStreams` + a passthrough transform does not disturb the live stream.

**Files:**
- Modify (temporary spike): `ui/src/lib/connection/ConnectionManager.ts`

**Step 1: Add the flag + a logging passthrough tap**

In `_setupWebRTC()` where `this._pc = new RTCPeerConnection({...})` is created, add `encodedInsertableStreams: true` to the options object.

In `pc.ontrack` (inside `_setupTrackHandler()`), after obtaining `event.receiver`, add a one-shot probe (guard with a `_spiked` boolean so it logs once per track kind):

```typescript
try {
  // @ts-expect-error createEncodedStreams is non-standard (Chromium/WebView2)
  const { readable, writable } = event.receiver.createEncodedStreams();
  let logged = false;
  const transform = new TransformStream({
    transform: (frame, controller) => {
      if (!logged) {
        logged = true;
        const data = new Uint8Array((frame as RTCEncodedVideoFrame).data);
        const head = Array.from(data.slice(0, 8)).map((b) => b.toString(16).padStart(2, "0")).join(" ");
        this._log(`SPIKE ${event.track.kind}: bytes=${data.length} type=${(frame as RTCEncodedVideoFrame).type ?? "n/a"} head=[${head}] ts=${(frame as RTCEncodedVideoFrame).timestamp}`);
      }
      controller.enqueue(frame); // passthrough — MUST re-enqueue or playback stops
    },
  });
  readable.pipeThrough(transform).pipeTo(writable);
} catch (e) {
  this._log("SPIKE createEncodedStreams failed: " + String(e));
}
```

**Step 2: Build + run on hardware**

Run: `npm --prefix ui run build && cargo clean -p xbox-remote && cargo run`
Owner streams a console (clipping setting irrelevant for the spike).

**Step 3: Read the spike output**

Read the app's stdout log (the background task output file). Confirm and RECORD:
- Video `head=[...]`: `00 00 00 01` / `00 00 01` ⇒ **Annex-B**; otherwise (e.g. a 4-byte big-endian length) ⇒ **AVCC** → Task 3 must convert.
- Video `type` reports `key`/`delta` (keyframe detection source).
- **The stream plays normally** (passthrough did not break it). This validates the §6.4 risk.

Expected: frames flow, `head` reveals the format, video stays up.

**Step 4: Revert the spike**

Remove the spike logging block (keep nothing from this task except the knowledge). The real wiring is Task 9. Do NOT commit the spike.

> If the stream breaks or `createEncodedStreams` throws, STOP and report — the whole approach is in question and we fall back to finishing Path A instead.

---

## Task 2: Rust — `muxide` mux function + payload parser (TDD)

**Files:**
- Modify: `Cargo.toml`
- Create: `src/clip.rs`
- Modify: `src/main.rs` (add `mod clip;`)

**Step 1: Add the dependency**

In `Cargo.toml` `[dependencies]`: add `muxide = "*"` (pin the exact latest version after `cargo add muxide`; check the real API at <https://docs.rs/muxide> — the calls below are from its README and MUST be reconciled with the actual crate before relying on them).

**Step 2: Write the failing test**

Create `src/clip.rs` with the payload type + a test module. The wire payload (produced by JS in Task 6) is:

```
[u32 magic 'XCLP'][u8 version=1]
[u16 width][u16 height][u16 fps_num][u16 fps_den]
[u32 sps_len][sps bytes][u32 pps_len][pps bytes]
[u32 aac_config_len][aac config bytes]
[u32 video_count]  then video_count × [u8 keyframe][f64 pts_sec][u32 len][nal bytes (Annex-B)]
[u32 audio_count]  then audio_count × [f64 pts_sec][u32 len][aac bytes]
```

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_round_trips_a_minimal_payload() {
        let payload = ClipPayload {
            width: 1920, height: 1080, fps_num: 60, fps_den: 1,
            sps: vec![0x67, 0x42], pps: vec![0x68, 0xce],
            aac_config: vec![0x12, 0x10],
            video: vec![VideoFrame { keyframe: true, pts_sec: 0.0, nal: vec![0,0,0,1,0x65] }],
            audio: vec![AudioFrame { pts_sec: 0.0, aac: vec![0xff, 0xf1] }],
        };
        let bytes = payload.to_bytes();
        let parsed = ClipPayload::parse(&bytes).unwrap();
        assert_eq!(parsed.width, 1920);
        assert_eq!(parsed.video.len(), 1);
        assert!(parsed.video[0].keyframe);
        assert_eq!(parsed.audio[0].aac, vec![0xff, 0xf1]);
    }
}
```

**Step 3: Run it (fails to compile)**

Run: `cargo test clip::` — Expected: FAIL (types not defined).

**Step 4: Implement the payload types + parser + muxer**

In `src/clip.rs` implement `ClipPayload`, `VideoFrame`, `AudioFrame`, `to_bytes()` (for the test only), `parse(&[u8]) -> Result<ClipPayload, String>` (bounds-checked, validates magic+version), and:

```rust
/// Mux an encoded payload into a fragmented MP4, returned as bytes.
pub fn mux_to_mp4(p: &ClipPayload) -> Result<Vec<u8>, String> {
    // NOTE: reconcile these calls with the real muxide API (docs.rs/muxide).
    use muxide::{MuxerBuilder, VideoCodec, AudioCodec};
    let mut out: Vec<u8> = Vec::new();
    let fps = p.fps_num as f32 / p.fps_den.max(1) as f32;
    let mut muxer = MuxerBuilder::new(&mut out)
        .video(VideoCodec::H264, p.width, p.height, fps)
        .audio(AudioCodec::Aac, 48000, 2)
        .with_sps(&p.sps)
        .with_pps(&p.pps)
        .new_with_fragment()
        .map_err(|e| format!("muxer init: {e}"))?;
    // Interleave by pts so the muxer sees monotonic timestamps per track.
    for f in &p.video { muxer.write_video(f.pts_sec, &f.nal, f.keyframe).map_err(|e| format!("write_video: {e}"))?; }
    for f in &p.audio { muxer.write_audio(f.pts_sec, &f.aac).map_err(|e| format!("write_audio: {e}"))?; }
    muxer.finish().map_err(|e| format!("finish: {e}"))?;
    Ok(out)
}
```

Add `mod clip;` to `src/main.rs`.

**Step 5: Add a muxide smoke test**

Add a test that builds a tiny synthetic payload (one IDR NAL with SPS/PPS, one AAC frame) and asserts `mux_to_mp4(...)` returns `Ok` with a non-empty buffer starting with an `ftyp` box (`....ftyp` at offset 4). Adjust to muxide's real output.

**Step 6: Run + commit**

Run: `cargo test clip::` — Expected: PASS.
```bash
git add Cargo.toml Cargo.lock src/clip.rs src/main.rs
git commit -m "feat(clip): muxide payload parser + H.264/AAC mux fn"
```

---

## Task 3: JS pure — Annex-B normalization + SPS/PPS extraction (TDD)

**Files:**
- Create: `ui/src/lib/clip/annexB.ts`, `ui/src/lib/clip/annexB.test.ts`

**Step 1: Failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { toAnnexB, extractSpsPps, isAnnexB } from "./annexB.js";

describe("annexB", () => {
  it("detects an Annex-B start code", () => {
    expect(isAnnexB(new Uint8Array([0,0,0,1,0x67]))).toBe(true);
    expect(isAnnexB(new Uint8Array([0,0,0,5,0x67]))).toBe(false); // AVCC length prefix
  });
  it("converts AVCC (4-byte length) to Annex-B", () => {
    // one NAL of length 3: bytes 0x67,0x01,0x02
    const avcc = new Uint8Array([0,0,0,3, 0x67,0x01,0x02]);
    expect(Array.from(toAnnexB(avcc))).toEqual([0,0,0,1, 0x67,0x01,0x02]);
  });
  it("passes Annex-B through unchanged", () => {
    const ab = new Uint8Array([0,0,0,1,0x65,0x09]);
    expect(Array.from(toAnnexB(ab))).toEqual(Array.from(ab));
  });
  it("extracts SPS (type 7) and PPS (type 8) from a keyframe", () => {
    const sps = [0x67,0x42,0x00]; const pps = [0x68,0xce]; const idr = [0x65,0x88];
    const frame = new Uint8Array([0,0,0,1,...sps, 0,0,0,1,...pps, 0,0,0,1,...idr]);
    const { sps: s, pps: p } = extractSpsPps(frame);
    expect(Array.from(s!)).toEqual(sps);
    expect(Array.from(p!)).toEqual(pps);
  });
});
```

**Step 2:** Run `npm --prefix ui run test -- annexB` → FAIL (module missing).

**Step 3: Implement** `ui/src/lib/clip/annexB.ts`:
- `isAnnexB(data)`: true if it starts with `00 00 01` or `00 00 00 01`.
- `toAnnexB(data)`: if `isAnnexB`, return as-is; else treat as AVCC with 4-byte big-endian length prefixes, walk the NALs, and rewrite each length prefix as `00 00 00 01`.
- `extractSpsPps(annexBFrame)`: split on start codes; return the first NAL with `nal[0] & 0x1f === 7` (SPS) and `=== 8` (PPS).

**Step 4:** Run `npm --prefix ui run test -- annexB` → PASS.

**Step 5: Commit**
```bash
git add ui/src/lib/clip/annexB.ts ui/src/lib/clip/annexB.test.ts
git commit -m "feat(clip): Annex-B normalization + SPS/PPS extraction"
```

---

## Task 4: JS pure — RTP timestamp → seconds (TDD)

**Files:** Create `ui/src/lib/clip/rtpTime.ts` + `.test.ts`.

**Step 1: Failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { RtpClock } from "./rtpTime.js";

describe("RtpClock", () => {
  it("converts deltas from the first timestamp at the given rate", () => {
    const c = new RtpClock(90000);          // video clock
    expect(c.toSeconds(1000)).toBe(0);      // first ts = origin
    expect(c.toSeconds(1000 + 90000)).toBeCloseTo(1.0, 6);
  });
  it("handles uint32 wraparound", () => {
    const c = new RtpClock(90000);
    c.toSeconds(0xffffffff - 100);          // near max
    expect(c.toSeconds(0x00000000 + 800)).toBeCloseTo((100 + 800 + 1) / 90000, 6);
  });
});
```

**Step 2-4:** Run (FAIL) → implement `RtpClock` (store first ts as origin; track unwrapped 64-bit accumulator across uint32 wraps; `toSeconds(ts) = (unwrapped - origin) / rate`) → run (PASS).

**Step 5: Commit** `feat(clip): RTP timestamp clock`.

---

## Task 5: JS pure — encoded ring-buffer logic (TDD)

**Files:** Create `ui/src/lib/clip/encodedTapLogic.ts` + `.test.ts`.

Types: `EncodedFrame { bytes: Uint8Array; ptsSec: number; isKeyframe: boolean }`.

**Step 1: Failing tests** — cover:
- `evictVideo(frames, nowSec, retainSec)`: drops frames older than `nowSec - retainSec` but **keeps back to the keyframe preceding the window** (never strands the window without a leading keyframe).
- `sliceForClip(video, audio, nowSec, retainSec)`: returns `{ video, audio, startSec }` from the newest video keyframe with `ptsSec ≤ nowSec - retainSec` (warm-up: earliest keyframe), audio filtered to `ptsSec ≥ startSec`.

```typescript
import { describe, it, expect } from "vitest";
import { sliceForClip, evictVideo, type EncodedFrame } from "./encodedTapLogic.js";
const vf = (pts: number, key: boolean): EncodedFrame => ({ bytes: new Uint8Array([key?0x65:0x61]), ptsSec: pts, isKeyframe: key });
const af = (pts: number): EncodedFrame => ({ bytes: new Uint8Array([0xff]), ptsSec: pts, isKeyframe: false });

describe("sliceForClip", () => {
  it("starts at the newest keyframe at least retainSec old", () => {
    const video = [vf(0,true), vf(1,false), vf(2,true), vf(3,false), vf(4,false)];
    const audio = [af(0.5), af(2.5), af(3.5)];
    const r = sliceForClip(video, audio, 5, 3); // cutoff = 2 → keyframe at pts=2
    expect(r.startSec).toBe(2);
    expect(r.video[0].ptsSec).toBe(2);
    expect(r.audio.map(a => a.ptsSec)).toEqual([2.5, 3.5]);
  });
  it("falls back to the earliest keyframe during warm-up", () => {
    const video = [vf(4,true), vf(4.5,false)];
    const r = sliceForClip(video, [], 5, 3);
    expect(r.startSec).toBe(4);
  });
});

describe("evictVideo", () => {
  it("keeps the keyframe preceding the window", () => {
    const video = [vf(0,true), vf(1,false), vf(2,true), vf(3,false)];
    const kept = evictVideo(video, 4, 1.5); // window start ~2.5 → keep from keyframe at 2
    expect(kept[0].ptsSec).toBe(2);
  });
});
```

**Step 2-5:** Run (FAIL) → implement → run (PASS) → commit `feat(clip): encoded ring-buffer slice/evict logic`.

---

## Task 6: JS pure — clip payload packing (TDD, round-trips Task 2's format)

**Files:** Create `ui/src/lib/clip/clipPayload.ts` + `.test.ts`.

`packClipPayload({ width, height, fpsNum, fpsDen, sps, pps, aacConfig, video, audio }): Uint8Array` — emits the exact byte layout from Task 2 (magic `XCLP`=0x58434C50, version 1, big-endian/little-endian — **fix one convention and match Rust**; use little-endian to match `f64`/`u32` LE on both sides via `DataView`).

**Step 1: Failing test** — build a known-small struct, pack it, and assert specific bytes (magic, version, counts) + that a local `unpack` mirror round-trips it. Also add a Rust-parity assertion comment referencing Task 2's `ClipPayload::parse`.

**Step 2-5:** Run (FAIL) → implement with `DataView` (LE) → run (PASS) → commit `feat(clip): binary clip payload packing`.

> After this task, manually cross-check: a payload from `packClipPayload` parses in `src/clip.rs::ClipPayload::parse` (add a temporary Rust test fixture if practical). Endianness mismatches surface here, not on hardware.

---

## Task 7: JS — WebCodecs Opus→AAC transcode (on-clip)

**Files:** Create `ui/src/lib/clip/audioTranscode.ts`. Verified by type-check + hardware (Task 11); no unit test (DOM API).

```typescript
import type { EncodedFrame } from "./encodedTapLogic.js";

export interface AacResult { config: Uint8Array; frames: { bytes: Uint8Array; ptsSec: number }[]; }

/** Decode buffered Opus packets and re-encode to AAC, preserving timestamps. */
export async function transcodeOpusToAac(
  opus: EncodedFrame[],
  sampleRate = 48000,
  channels = 2,
  bitrate = 128_000,
): Promise<AacResult> {
  const out: AacResult = { config: new Uint8Array(), frames: [] };
  const decoded: AudioData[] = [];
  const decoder = new AudioDecoder({
    output: (d) => decoded.push(d),
    error: (e) => { throw e; },
  });
  decoder.configure({ codec: "opus", sampleRate, numberOfChannels: channels });
  for (const f of opus) {
    decoder.decode(new EncodedAudioChunk({
      type: "key", timestamp: Math.round(f.ptsSec * 1e6), data: f.bytes,
    }));
  }
  await decoder.flush();

  await new Promise<void>((resolve, reject) => {
    const encoder = new AudioEncoder({
      output: (chunk, meta) => {
        if (meta?.decoderConfig?.description) out.config = new Uint8Array(meta.decoderConfig.description as ArrayBuffer);
        const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b);
        out.frames.push({ bytes: b, ptsSec: chunk.timestamp / 1e6 });
      },
      error: reject,
    });
    encoder.configure({ codec: "mp4a.40.2", sampleRate, numberOfChannels: channels, bitrate });
    for (const d of decoded) { encoder.encode(d); d.close(); }
    encoder.flush().then(() => resolve()).catch(reject);
  });
  return out;
}
```

**Verify:** `npm --prefix ui run check` → 0 errors. **Commit** `feat(clip): WebCodecs Opus->AAC transcode`.

---

## Task 8: JS — `EncodedTap` (ring buffers + assemble)

**Files:** Create `ui/src/lib/clip/EncodedTap.ts`. Type-check verified.

Owns two `EncodedFrame[]` (video, audio) + an `RtpClock` per stream. Public:
- `pushVideo(data: Uint8Array, isKeyframe: boolean, rtpTs: number)` / `pushAudio(...)` — copy bytes, normalize video via `toAnnexB`, record `ptsSec` via the clock; capture SPS/PPS from the first keyframe; periodically `evictVideo`/evict audio against `retainSec + headroom`.
- `assemble(retainSec): { width,height,fps, sps,pps, video, audio } | null` — uses `sliceForClip`; pulls `width/height/fps` from the stored video track settings (passed in at construction).
- `clear()`.

Constructor takes `{ lengthSec, videoTrackSettings }`. No DOM dependency beyond the data it's handed (so its logic stays testable through Tasks 3–5). **Commit** `feat(clip): EncodedTap ring buffer`.

---

## Task 9: ConnectionManager — Insertable Streams wiring (sensitive)

**Files:** Modify `ui/src/lib/connection/ConnectionManager.ts`.

**Step 1:** Add `encodedInsertableStreams: true` to the `new RTCPeerConnection({...})` options in `_setupWebRTC()`.

**Step 2:** In `pc.ontrack` (`_setupTrackHandler()`), for each receiver wire a passthrough transform ONCE per receiver that always `enqueue`s the frame and, when a tap is attached, forwards `{data, type, timestamp}` to it:

```typescript
private _wireEncodedTap(receiver: RTCRtpReceiver, kind: "video" | "audio"): void {
  try {
    // @ts-expect-error non-standard
    const { readable, writable } = receiver.createEncodedStreams();
    const t = new TransformStream({
      transform: (frame, controller) => {
        const tap = this._encodedTap;
        if (tap) {
          const data = new Uint8Array((frame as RTCEncodedVideoFrame).data);
          const ts = (frame as RTCEncodedVideoFrame).timestamp;
          if (kind === "video") tap.pushVideo(data, (frame as RTCEncodedVideoFrame).type === "key", ts);
          else tap.pushAudio(data, false, ts);
        }
        controller.enqueue(frame);
      },
    });
    readable.pipeThrough(t).pipeTo(writable);
  } catch (e) {
    this._log("createEncodedStreams unavailable: " + String(e));
    this._encodedStreamsAvailable = false;
  }
}
```

**Step 3:** Add `setEncodedTap(tap: EncodedTap | null)` / `get encodedStreamsAvailable()` accessors. Clear the tap reference in `_cleanupConnection()`.

**Step 4: Verify** `npm --prefix ui run check` → 0 errors; `npm --prefix ui run build`. (Behavioral verification is Task 11.)

**Step 5: Commit** `feat(clip): wire encoded-frame tap into ConnectionManager`.

> Invariant: when `_encodedTap` is null the transform only re-enqueues → the stream is unchanged. Task 11 confirms a clipping-off stream is unaffected.

---

## Task 10: clipStore + IPC — strategy select, saveClip flow, .mp4

**Files:** Modify `ui/src/lib/stores/clip.svelte.ts`, `ui/src/lib/ipc/commands.ts`, `ui/src/lib/clip/clipBufferLogic.ts` (filename).

**Step 1: IPC** — change `saveClip` to send the packed binary payload (raw IPC body) and return the path; keep the `X-Clip-Name` header:

```typescript
export async function saveClip(payload: Uint8Array, fileName: string): Promise<string> {
  return invoke<string>("save_clip", payload, { headers: { "X-Clip-Name": fileName } });
}
```

**Step 2: Filename** — parameterize `clipFileName(d, ext = "mp4")` in `clipBufferLogic.ts` and update its test to expect `.mp4`.

**Step 3: clipStore.attach** — choose the strategy:
- If `connectionManager.encodedStreamsAvailable` → create an `EncodedTap`, call `manager.setEncodedTap(tap)`, store it.
- Else → the existing `ClipBuffer` (HW-H.264 MediaRecorder) fallback.

**Step 4: clipStore.saveClip** — for the EncodedTap strategy:
```
const a = tap.assemble(lengthSec); if (!a) { toast "not ready"; return; }
const aac = await transcodeOpusToAac(a.audio);
const payload = packClipPayload({ ...a.dimensions, sps:a.sps, pps:a.pps, aacConfig: aac.config,
                                  video: a.video, audio: aac.frames });
const path = await saveClip(payload, clipFileName(new Date(), "mp4"));
toast "Clip saved · Reveal" → revealClip(path)
```
(MediaRecorder fallback keeps the v1 blob→saveClip path, but `saveClip` now takes bytes; wrap the blob's `arrayBuffer()` accordingly.)

**Step 5: Backend** — rework `save_clip` (Task 2's `src/clip.rs`): read the raw body, `ClipPayload::parse`, `mux_to_mp4`, write to `<video_dir>/Xbox Remote Clips/<name>`, return the path. (The existing path-safety helper + dir creation stay.)

**Step 6: Verify** `npm --prefix ui run check && npm --prefix ui run test && cargo test` all green; `npm --prefix ui run build`.

**Step 7: Commit** `feat(clip): encoded-frame clip pipeline (tap → AAC → muxide MP4)`.

---

## Task 11: Hardware integration + verification (OWNER)

**Step 1:** `npm --prefix ui run build && cargo clean -p xbox-remote && cargo run` (stop any running app first).

**Step 2 — the gates:**
- Enable clipping (Settings → CLIPPING), stream → **picture comes up and stays up** (no reconnect loop). ✅ the core regression gate.
- Clip after ~30 s → toast → Reveal → an **`.mp4`** in `Videos\Xbox Remote Clips\`.
- The MP4 **plays in the Xbox media player, Discord, and VLC**, with **correct A/V sync** and ~30 s length.
- Turn clipping OFF, stream → unchanged from baseline (no regression).
- Force a reconnect → after recovery, clipping still works (tap re-wired).

**Step 3:** If A/V drift or playback issues appear, debug with the systematic-debugging skill — most likely the §6.3 timestamp base or §6.1 NAL/SPS handling. The MediaRecorder fallback remains available.

**Step 4: Docs + cleanup** — update `CLAUDE.md` (clip module table → `EncodedTap`, `annexB`, `audioTranscode`, `src/clip.rs`, `muxide`; note MP4 output + insertable-streams) and the README clip line (MP4, native). Remove the dead v1 `ClipBuffer` rotation/WebM bits if the EncodedTap path is confirmed primary (keep the MediaRecorder fallback). Commit `docs(clip): document encoded-frame remux pipeline`.

---

## Self-review notes (author)

- **Spec coverage:** Insertable Streams capture (T1,T9), JS ring buffer (T5,T8), Annex-B/SPS-PPS (T3), timestamps (T4), Opus→AAC WebCodecs (T7), muxide MP4 (T2), payload (T2,T6), strategy+fallback (T10), corrupt-file fix via keyframe slice (T5), stream-unaffected gate (T1,T11). All §4–§8 mapped.
- **Type consistency:** `EncodedFrame {bytes,ptsSec,isKeyframe}` shared T5/T8; `ClipPayload` byte layout defined once (T2) and matched by `packClipPayload` (T6, LE); `saveClip(payload: Uint8Array, fileName)` (T10) matches the Rust raw-body command (T2/T10).
- **Known soft spots (by design):** muxide's exact API (T2 — reconcile with docs.rs first) and the insertable-streams NAL format (T1 spike resolves; T3 auto-detects either way). These are sequenced first on purpose.
