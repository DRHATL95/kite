# Clipping v2 — Encoded-Frame Capture + Remux (Design Spec)

- **Date:** 2026-06-16
- **Status:** Approved — ready for implementation plan
- **Branch:** `claude/elegant-sinoussi-0a6727` (already merged up to `origin/master` v0.5.0)
- **Supersedes:** the capture mechanism of `2026-06-16-clipping-design.md` (v1). The settings
  integration, save/reveal flow, opener plugin, and Toast from v1 remain.

## 1. Why this rewrite

v1 clipping used `MediaRecorder` to **re-encode** the decoded video. Hardware testing proved
this is incompatible with streaming: software VP8 encode starved the WebRTC pipeline
(`controlChannelClosed` → reconnect loop → "couldn't get video"). Switching to a **hardware
H.264** codec made the stream survive, but re-encoding is still lossy, hardware-dependent, and
the rolling-buffer's segment rotation produces multi-header files that won't play (~7 s then
"filetype error").

**The root insight:** the Xbox already sends us encoded H.264 over WebRTC. The correct design
captures those *already-encoded* frames and **remuxes** them into a file — no encoder competing
with the stream. This is how Shadowplay / OBS replay buffer work. It is lossless, near-zero CPU,
hardware-independent, and — because encoded frames carry keyframe flags — produces clean,
keyframe-aligned clips (the corrupt-file bug disappears by construction).

WebView2 capability probe (confirmed on the target machine): `createEncodedStreams`,
`RTCRtpScriptTransform`, WebCodecs `AudioEncoder`/`AudioDecoder`, and `MediaRecorder`
`video/mp4;codecs=avc1` are **all available**.

## 2. Goals / Non-goals

### Goals
- Clipping never disturbs the live stream (no continuous encode).
- **Most-native output:** MP4 + H.264 (lossless remux) + AAC audio — plays in the Xbox's own
  media player, Windows/macOS, Discord, VLC.
- Lossless video (exact bytes the Xbox encoded); clean keyframe-aligned clips.
- Performance-first: continuous path is byte-buffering only; the only transcode is audio
  (Opus→AAC), which is cheap and runs **only on Clip**, never during streaming.
- Reuse v1's settings (SettingsModal CLIPPING section), save/reveal, opener, Toast.

### Non-goals (v1 of v2)
- HEVC/AV1 sources (we mux whatever the Xbox sends — currently H.264; HEVC support is a
  muxide capability we can enable later if needed).
- Editing/trimming UI; thumbnails; upload integration.
- Configurable container/codec (MP4/H.264/AAC is the fixed output).

## 3. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Capture | WebRTC **Insertable Streams** (`createEncodedStreams`, main-thread) | Taps encoded frames pre-decode; no re-encode. Legacy API is simpler than the worker-based `RTCRtpScriptTransform` and is available. |
| Ring buffer | **JS**, holds encoded frames for last N s | Trivial cost (byte copies); keeps the continuous hot-path off the JS↔Rust boundary. Per-frame IPC would re-introduce the load we're avoiding. |
| Video | **Lossless remux** of source H.264 | Best quality, zero encode. |
| Audio | **Opus→AAC via WebCodecs on Clip** | AAC = native everywhere; WebCodecs uses the OS encoder (no `fdk-aac` dependency / licensing). On-clip only → no stream impact. |
| Mux | **Rust `muxide`** (`MuxerBuilder` → fMP4) | Pure-Rust, zero-dep, accepts encoded H.264 + AAC/Opus; honors the Rust-lean preference; the heavy lifting lands in Rust. |
| Container | **fragmented MP4** (`.mp4`) | Native + seekable. |
| Fallback | Keep **HW-H.264 `MediaRecorder`** path | Runtime fallback if Insertable Streams unavailable (other machines). |

## 4. Architecture

```
ConnectionManager
  new RTCPeerConnection({ encodedInsertableStreams: true, ...existing })
  ontrack(video) → receiver.createEncodedStreams() → readable.pipeThrough(tap).pipeTo(writable)
  ontrack(audio) → receiver.createEncodedStreams() → readable.pipeThrough(tap).pipeTo(writable)
        tap = TransformStream: copy frame → ring buffer (when clipping on); ALWAYS enqueue() (playback)

EncodedTap (JS)  ── owns the two ring buffers (video H.264 frames, audio Opus frames)
clipStore.saveClip():
  1. videoSlice = frames from last keyframe with pts ≤ now-N  (warm-up: earliest keyframe)
  2. audioSlice = audio frames in [videoSlice.start .. now]
  3. aac = await transcodeOpusToAac(audioSlice)   // WebCodecs AudioDecoder→AudioEncoder
  4. payload = pack({ sps, pps, width, height, fps, video: [{nal,pts,key}], aacConfig, audio: [{aac,pts}] })
  5. path = await saveClip(payload)               // raw IPC body
  6. toast "Clip saved · Reveal" → revealItemInDir(path)

Rust save_clip(request: raw body):
  parse payload → muxide MuxerBuilder.video(H264,w,h,fps).audio(AAC,48000,ch).with_sps/.with_pps
  → write_video(pts,nal,key) / write_audio(pts,aac) in pts order → finalize
  → write <Videos>/Xbox Remote Clips/xbox-clip-*.mp4 → return absolute path
```

## 5. Components

### 5.1 `ui/src/lib/clip/EncodedTap.ts` (new) — replaces `ClipBuffer.ts`
- `attach(pc, video)` is replaced by wiring done in ConnectionManager (the tap must be set up at
  `ontrack` time, before frames flow). `EncodedTap` exposes the ring buffers + `assemble()`.
- **Ring buffer model:** `BufferedFrame { bytes: Uint8Array; ptsSec: number; isKeyframe: boolean }`
  per stream (video, audio). Bytes are **copied** on capture (the source `ArrayBuffer` is reused
  after `enqueue`). Eviction: drop frames older than `now - (N + headroom)`, but never drop past
  the keyframe that precedes the retained window.
- `assemble()` returns `{ video: BufferedFrame[], audio: BufferedFrame[] }` sliced from the last
  video keyframe with `ptsSec ≤ now - N` (warm-up: earliest keyframe), audio aligned to that start.
- Pure slicing/eviction logic factored into `encodedTapLogic.ts` for unit testing (no DOM).

### 5.2 `ConnectionManager.ts` (edit — the sensitive change)
- Add `encodedInsertableStreams: true` to the `RTCPeerConnection` options.
- In the `ontrack` handler, for the video and audio receivers, call `createEncodedStreams()` and
  pipe through a `TransformStream` that copies into the active `EncodedTap` (if any) and always
  `enqueue`s the frame unchanged. Wiring is unconditional (so clipping can turn on mid-session);
  the *buffering* is gated on an attached tap. **Invariant to verify:** with no tap attached, the
  passthrough is byte-identical to today's stream (no regression).
- Expose a hook so `clipStore` can attach/detach an `EncodedTap` (the tap reads from the already-
  wired transform). Connection lifecycle (reconnect cleanup) tears down taps.

### 5.3 WebCodecs audio transcode — `ui/src/lib/clip/audioTranscode.ts` (new)
- `transcodeOpusToAac(frames, sampleRate=48000, channels): Promise<{ config: Uint8Array; chunks: {bytes,ptsSec}[] }>`
- `AudioDecoder({codec:'opus', …})` → `AudioData` (PCM) → `AudioEncoder({codec:'mp4a.40.2', …})`
  → `EncodedAudioChunk` (AAC); capture the `AudioSpecificConfig` from the encoder's
  `output(chunk, metadata)` `metadata.decoderConfig.description`. Preserve timestamps end-to-end.
- Runs once per clip (bounded, async). On failure → fall back to muxing **Opus** (still valid
  MP4, just less native) rather than failing the clip.

### 5.4 Rust `save_clip` (rework in `src/main.rs` or new `src/clip.rs`)
- Accept the packed payload (raw IPC body). Define a compact binary layout: a small header
  (counts, w/h/fps, sps/pps lengths, aac config length) + per-frame index (kind, pts, length,
  keyframe) + concatenated frame bytes. Documented + unit-tested parser.
- `muxide`: `MuxerBuilder::new(path).video(VideoCodec::H264,w,h,fps).audio(AudioCodec::Aac,48000,ch)
  .with_sps(sps).with_pps(pps).new_with_fragment()?`; then `write_video(pts,&nal,key)` /
  `write_audio(pts,&aac)` in pts order; finalize. Write under `dirs::video_dir()/Xbox Remote Clips/`.
- Add `muxide` to `Cargo.toml`.

### 5.5 `clip.svelte.ts` (edit)
- `attach()` chooses the strategy: **EncodedTap** when `createEncodedStreams` is available,
  else the legacy **MediaRecorder** ClipBuffer (fallback). `saveClip()` runs the slice →
  transcode → pack → `save_clip` → toast flow.

### 5.6 Reused unchanged from v1
- SettingsModal CLIPPING section, `settings.clip`, the Clip button in StreamControls, the Toast,
  `revealClip` / `tauri-plugin-opener`, the `clipSettings` model. (The `.webm` filename becomes
  `.mp4`; `clipFileName` extension parameterized.)

## 6. Key technical details / risks

1. **NAL format.** Insertable-streams H.264 frame `.data` may be AVCC (length-prefixed) or
   Annex-B; muxide wants **Annex-B** (start codes) with SPS/PPS in the first keyframe. Detect and
   convert in JS (cheap) if needed. **Must verify empirically early** — this is the #1 unknown.
2. **SPS/PPS extraction.** Pull SPS/PPS NALs from the first buffered keyframe (or the codec
   metadata) for `.with_sps`/`.with_pps`. Parse width/height/fps from SPS, or pass from the video
   track's `getSettings()`.
3. **Timestamps.** RTP timestamps: video 90 kHz, audio 48 kHz, uint32 (wraps). Convert to a
   monotonic seconds base per stream; muxide requires monotonic. A/V sync depends on a shared
   time origin — derive both from the same wall-clock capture instant + RTP deltas.
4. **`encodedInsertableStreams` flag** is the one change to the working connection path. Guard:
   passthrough must be transparent when no tap is attached; regression-test a normal stream.
5. **muxide maturity** (young crate). The MediaRecorder fallback hedges this; Rust unit tests with
   synthetic frames assert a valid MP4 before we trust it on hardware.
6. **AAC `AudioSpecificConfig`** must reach muxide's `esds` box — plumb the WebCodecs
   `decoderConfig.description` through the payload.
7. **Memory.** N seconds of encoded video (~tens of MB) held in JS + one ~tens-of-MB IPC burst on
   clip. Bounded and fine.

## 7. Error handling
- Insertable streams unavailable → MediaRecorder fallback (logged).
- WebCodecs AAC encode fails → mux Opus instead (valid MP4, less native) — never fail the clip.
- muxide error → toast "Clip failed: <reason>", keep streaming.
- Tap teardown on disconnect/reconnect; never leak transforms or leave the stream un-enqueued.

## 8. Testing
- **Unit (Vitest):** `encodedTapLogic` ring-buffer eviction + keyframe-aligned slicing; NAL
  AVCC↔Annex-B conversion; RTP→seconds conversion incl. wraparound; payload pack/unpack round-trip.
- **Unit (Rust):** payload parse; muxide with synthetic H.264+AAC frames → assert a structurally
  valid, non-empty MP4 (and ideally that `ffprobe`/a parser reads it, if available).
- **Manual/hardware (gates done):** clipping ON → stream stays up; saved `.mp4` plays in the
  **Xbox media player**, Discord, and VLC, with correct A/V sync and ~N-second length; clipping
  OFF → stream byte-identical to baseline.

## 9. Open questions (resolve during implementation, non-blocking)
- Exact insertable-streams NAL format in WebView2 (→ §6.1, verify first).
- Whether muxide wants SPS/PPS via `.with_sps`/`.with_pps` or embedded in the first keyframe for
  fMP4 (API supports both; pick what works).
- AAC bitrate default (e.g., 128 kbps stereo).
