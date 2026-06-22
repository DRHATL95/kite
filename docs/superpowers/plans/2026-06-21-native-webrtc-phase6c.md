# Native WebRTC Phase 6c — IPC + frontend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Wire the native engine into the Tauri app's control plane + frontend so the Svelte UI drives the engine (instead of the browser `ConnectionManager`) — typed `rtc_*` IPC, an `rtc_event` channel, a `NativeConnection` adapter behind the existing store contract, native clip + splash + input.

**Architecture:** Continues Phase 6 on `feat/native-webrtc-phase6` (6a engine foundation + 6b render spike already landed). Frontend selects native-vs-browser deterministically from `rtc_native_available()`; a `NativeConnection` implements the same `ConnectionBackend` interface the store consumes; events flow Rust→JS via `listen("rtc_event")`; input flows JS→Rust via `rtc_send_input`; the render surface (6b) shows the engine's decoded frames.

**Tech Stack:** Rust (Tauri 2 commands, tokio), Svelte 5 + TS, Vitest. Verify: Rust gated → WSL `cargo build --features native-webrtc` + default `cargo build`; frontend → `pnpm --dir ui run check` + `build` + `test` (on Windows).

**Spec:** `docs/superpowers/specs/2026-06-21-native-webrtc-phase6-design.md` §6c (units C1–C10) + decisions 1, 5.

## Global Constraints
- Same `native-webrtc` feature gating; default Win/macOS build stays lean. The browser `ConnectionManager` path must remain byte-identical (only additive store selection + a behavior-preserving `GamepadPoller` callback refactor).
- `Disconnected` is terminal-only (6a.5): map Reconnecting→`reconnecting`, Disconnected→`failed`, channel-close→`idle`. `rtc_connect` returns Ok on spawn; failures arrive async as `Disconnected`.
- Engine sends client-metadata itself (6a.3) → native `GamepadPoller` does NOT forward a metadata packet. Engine owns idle pulses (Phase 5) → native poller forwards only real gamepad state.
- One `generate_handler!`; each `rtc_*` command defined once with the cfg INSIDE the body. Feature-gated AppState fields (`rtc`, `frame_sink` from 6b).
- Frontend: `rtc_native_available()` resolved before the first `connect()`; complete `DiagnosticsSnapshot` (never `Partial`); `rtc_event` subscription guarded by a session generation.
- TDD for pure TS (Vitest) + the mapping logic; Rust IPC gated → WSL compile gate. Frequent commits; `feat(rtc)` scope; Co-Authored-By trailer.

## File Structure
```
src/lib.rs                                 MODIFY  — AppState rtc field; rtc_* commands; forwarding task; window-close teardown
ui/src/lib/connection/types.ts             MODIFY  — ConnectionBackend interface; RtcEvent DTO type
ui/src/lib/connection/ConnectionManager.ts MODIFY  — implement ConnectionBackend (it already matches; just `implements`)
ui/src/lib/connection/NativeConnection.ts  CREATE  — the native adapter
ui/src/lib/connection/nativeStats.ts       CREATE  — mapStats + completeSnapshot (pure, tested)
ui/src/lib/connection/input.ts             MODIFY  — GamepadPoller tagged callback
ui/src/lib/ipc/commands.ts                 MODIFY  — rtc_* wrappers + subscribeRtcEvents
ui/src/lib/stores/connection.svelte.ts     MODIFY  — backend selection
ui/src/lib/stores/clip.svelte.ts           MODIFY  — native saveClip path
ui/src/screens/Stream.svelte               MODIFY  — native branch (no <video>, splash, volume)
ui/src/App.svelte                          MODIFY  — gate connect on backend-ready; clip-attach browser-only
```

---

## Task 6c.1: `rtc_*` Tauri commands + AppState (Rust, gated)

**Files:** Modify `src/lib.rs`.
**Interfaces:** Produces commands `rtc_native_available()->bool`, `rtc_connect(server_id, play_path?)`, `rtc_disconnect()`, `rtc_send_input(state)`, `rtc_request_keyframe()`, `rtc_save_clip()->String`; `AppState{ #[cfg] rtc: tokio::sync::Mutex<Option<RtcHandle>>, #[cfg] frame_sink (6b) }`. Consumed by 6c.9 (lifecycle) and the frontend wrappers (6c.2).

- [ ] **Step 1:** Add a `#[cfg(feature="native-webrtc")] rtc: tokio::sync::Mutex<Option<crate::rtc::engine::RtcHandle>>` field to `AppState` (default `None`); confirm `frame_sink` (6b) is present. READ lib.rs for AppState shape + `.manage()`.
- [ ] **Step 2:** Define each command ONCE with `#[tauri::command]` and the cfg inside the body. `rtc_native_available`:
```rust
#[tauri::command]
fn rtc_native_available() -> bool {
    #[cfg(feature = "native-webrtc")]
    { std::env::var_os("XBOX_FORCE_BROWSER_WEBRTC").is_none() }
    #[cfg(not(feature = "native-webrtc"))]
    { false }
}
```
For `rtc_disconnect`/`rtc_send_input`/`rtc_request_keyframe`/`rtc_save_clip`: the non-feature body returns `Err("native unavailable".into())`; the feature body is filled in 6c.9 (for now `rtc_connect`/`disconnect` can be stubs returning Ok/Err so the handler list compiles — 6c.9 fleshes them out). Keep signatures stable.
- [ ] **Step 3:** Register all six in the single `generate_handler!` list.
- [ ] **Step 4: Verify (WSL + default):** `cargo build --features native-webrtc` Finished; `cargo build` (default) Finished (commands compile in both; non-feature returns the stub). 
- [ ] **Step 5: Commit.** `feat(rtc): rtc_* command surface + AppState handle field (6c.1)`

---

## Task 6c.2: typed ipc wrappers + `subscribeRtcEvents` (TS)

**Files:** Modify `ui/src/lib/ipc/commands.ts`; add the `RtcEvent` DTO type to `ui/src/lib/connection/types.ts`.
**Interfaces:** Produces `rtcNativeAvailable()`, `rtcConnect(serverId, playPath?)`, `rtcDisconnect()`, `rtcSendInput(state)`, `rtcRequestKeyframe()`, `rtcSaveClip()`, `subscribeRtcEvents(cb): Promise<UnlistenFn>`; `RtcEvent` discriminated union type.

- [ ] **Step 1:** Add the `RtcEvent` type (mirrors the Rust DTO):
```ts
export type RtcEvent =
  | { kind: "connecting" } | { kind: "connected" } | { kind: "firstFrame" }
  | { kind: "reconnecting"; attempt: number }
  | { kind: "stats"; bitrateKbps: number; fps: number; framesDecoded: number; freezeCount: number }
  | { kind: "disconnected"; reason: string } | { kind: "ended" };
```
(Match the serde tag/case the Rust DTO emits — 6c.9 defines it; agree on `kind` + camelCase fields.)
- [ ] **Step 2:** Add wrappers following the existing `invoke` pattern, e.g.:
```ts
export const rtcNativeAvailable = () => invoke<boolean>("rtc_native_available");
export const rtcConnect = (serverId: string, playPath?: string) =>
  invoke<void>("rtc_connect", { serverId, playPath: playPath ?? null });
export const rtcSendInput = (state: GamepadState) => invoke<void>("rtc_send_input", { state });
// ...disconnect, requestKeyframe; rtcSaveClip -> invoke<string>("rtc_save_clip")
export async function subscribeRtcEvents(cb: (e: RtcEvent) => void): Promise<UnlistenFn> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<RtcEvent>("rtc_event", (e) => cb(e.payload));
}
```
- [ ] **Step 3: Verify:** `pnpm --dir ui run check` (types compile).
- [ ] **Step 4: Commit.** `feat(rtc): typed rtc_* ipc wrappers + rtc_event subscription (6c.2)`

---

## Task 6c.3: `ConnectionBackend` interface (TS)

**Files:** Modify `ui/src/lib/connection/types.ts`, `ui/src/lib/connection/ConnectionManager.ts`.
**Interfaces:** Produces `interface ConnectionBackend` covering EXACTLY what `connection.svelte.ts` consumes: `connect(c: XHomeConsole): Promise<void>`, `disconnect(): Promise<void>`, `requestKeyframe(): void`, `setEncodedTap(tap): void`, `get encodedStreamsAvailable(): boolean`, `get lastSnapshot(): DiagnosticsSnapshot | null`, `get lastTriggerReason(): string | null`, `get state(): SessionState`, and the constructor takes `ConnectionManagerCallbacks`. Consumed by 6c.6 (NativeConnection) + 6c.7 (store).

- [ ] **Step 1:** Grep `connection.svelte.ts` for every `this._manager.` access; enumerate the surface. Define `ConnectionBackend` from it.
- [ ] **Step 2:** Make `ConnectionManager implements ConnectionBackend` (it already has all members — this just adds the `implements` clause + any missing getter like `lastTriggerReason` if it's currently a public field).
- [ ] **Step 3: Verify:** `pnpm --dir ui run check`.
- [ ] **Step 4: Commit.** `refactor(rtc): extract ConnectionBackend interface (6c.3)`

---

## Task 6c.4: native stats mapping (TS, pure, TDD)

**Files:** Create `ui/src/lib/connection/nativeStats.ts`; test `ui/src/lib/connection/nativeStats.test.ts`.
**Interfaces:** Produces `completeSnapshot(partial): DiagnosticsSnapshot` (baseline all-required-fields + overlay) and `mapStats(s: {bitrateKbps,fps,framesDecoded,freezeCount}): Partial<DiagnosticsSnapshot>`. Consumed by 6c.6.

- [ ] **Step 1: Failing Vitest** — assert `mapStats({bitrateKbps:1000,fps:60,framesDecoded:120,freezeCount:1})` maps to `{inboundVideoKbps:1000, fps:60, framesDecoded:120, freezeCount:1}`; assert `completeSnapshot({fps:60})` has ALL required `DiagnosticsSnapshot` fields set (capturedAt, connectionState, source, channels:[], currentAttempt, maxAttempts, etc.) with `fps:60` overlaid.
- [ ] **Step 2: Run → FAIL.** `pnpm --dir ui run test nativeStats`
- [ ] **Step 3: Implement** both (read `types.ts` `DiagnosticsSnapshot` for the exact required fields; baseline nullable RTCStats fields to null, `source:"unknown"`, `connectionState:"connected"`, `channels:[]`, attempts 0/3, `capturedAt: Date.now()`).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `feat(rtc): native stats mapping (mapStats + completeSnapshot) — TDD (6c.4)`

---

## Task 6c.5: `GamepadPoller` tagged callback (TS, TDD)

**Files:** Modify `ui/src/lib/connection/input.ts`, `ui/src/lib/connection/ConnectionManager.ts`; test `ui/src/lib/connection/input.test.ts`.
**Interfaces:** Produces the poller callback as a tagged union `{kind:"metadata"} | {kind:"gamepad", state: GamepadState}` (the poller still decides cadence/idle/metadata-timing; it just emits intent instead of bytes). Browser path re-encodes via existing `encodeClientMetadata`/`encodeGamepadFrame` (byte-identical). Native path (6c.6) ships only `gamepad` state via `rtcSendInput`.

- [ ] **Step 1: Failing test** — assert the browser send callback still produces byte-identical 15-byte metadata + 38-byte gamepad packets (drive the poller's emit, re-encode in the callback, compare to `encodeClientMetadata`/`encodeGamepadFrame` output).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — change `GamepadPoller`'s `send` callback type to the tagged union; emit `{kind:"metadata"}` on first tick + `{kind:"gamepad", state}` on input/idle ticks. Update `ConnectionManager._startGamepadPoller`'s callback to re-encode (`metadata`→`encodeClientMetadata`, `gamepad`→`encodeGamepadFrame`) and send on the data channel — preserving current behavior exactly.
- [ ] **Step 4: Run → PASS** (existing input.test.ts encode tests + the new poller test).
- [ ] **Step 5: Commit.** `refactor(rtc): GamepadPoller emits tagged input intent (browser byte-identical) — TDD (6c.5)`

---

## Task 6c.6: `NativeConnection` adapter (TS, TDD)

**Files:** Create `ui/src/lib/connection/NativeConnection.ts`; test `ui/src/lib/connection/NativeConnection.test.ts`.
**Interfaces:** Consumes `ConnectionBackend` (6c.3), the ipc wrappers (6c.2), `nativeStats` (6c.4), the tagged `GamepadPoller` (6c.5). Produces `class NativeConnection implements ConnectionBackend`.

- [ ] **Step 1: Failing Vitest** for the event→callback mapping (inject a fake `subscribeRtcEvents` + spy callbacks):
  - `connecting`→`onStateChange("connecting")`; `firstFrame`→`onStateChange("streaming")` + a `videoArrivedAt`/`videoPlaying` surrogate in the next snapshot; `reconnecting{attempt:2}`→`onReconnectAttempt(2,_)`+`onStateChange("reconnecting")`; `stats`→`onDiagnostics(completeSnapshot(mapStats(...)))`; `disconnected{reason}`→`onStateChange("failed")` + `lastTriggerReason===reason`; `ended`→`onStateChange("idle")`.
  - `encodedStreamsAvailable===false`; `setEncodedTap` is a no-op; `onMediaStream` never called.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — `connect(console)` → `rtcConnect(console.serverId)` + `subscribeRtcEvents` (store the `UnlistenFn` + a session generation; ignore events from a stale generation); map events as above; start a `GamepadPoller` whose callback ships `gamepad` state via `rtcSendInput` and ignores `metadata`. `disconnect()` → `rtcDisconnect()` + unlisten + stop poller. `requestKeyframe()`→`rtcRequestKeyframe()`. Maintain `state`/`lastSnapshot`/`lastTriggerReason` getters. Synthesize `handshakeMs` on `connected`, `videoArrivedAt` on `firstFrame` so the splash advances/dismisses.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Verify** `pnpm --dir ui run check`.
- [ ] **Step 6: Commit.** `feat(rtc): NativeConnection adapter (event mapping + input + clip) — TDD (6c.6)`

---

## Task 6c.7: deterministic backend selection (TS)

**Files:** Modify `ui/src/lib/stores/connection.svelte.ts`, `ui/src/App.svelte`.
**Interfaces:** Consumes `rtcNativeAvailable()` (6c.2), `ConnectionBackend` (6c.3), `NativeConnection` (6c.6). Produces a store that holds `_impl: ConnectionBackend` chosen deterministically + a `backendReady` flag.

- [ ] **Step 1:** Refactor `ConnectionStore` to construct its backend from an async `init()` that awaits `rtcNativeAvailable()` (default browser until resolved) and sets `_impl` + `backendReady=true`. Keep the same callbacks wiring against `_impl`.
- [ ] **Step 2:** In `App.svelte`, call `connectionStore.init()` on mount and **gate the ConsoleList Connect action** (disable/withhold) until `backendReady` (so no connect runs on the wrong backend on a native build).
- [ ] **Step 3: Verify:** `pnpm --dir ui run check` + `build`.
- [ ] **Step 4: Commit.** `feat(rtc): deterministic native/browser backend selection (6c.7)`

---

## Task 6c.8: native clip path (TS)

**Files:** Modify `ui/src/lib/stores/clip.svelte.ts`, `ui/src/lib/stores/connection.svelte.ts`, `ui/src/App.svelte`, `ui/src/components/StreamControls.svelte`.
**Interfaces:** Produces `connectionStore.saveClip()` dispatching to `rtcSaveClip()` in native mode; the App.svelte clip-attach `$effect` becomes browser-only.

- [ ] **Step 1:** Add `connectionStore.saveClip()` → native: `rtcSaveClip()`; browser: existing `clipStore.saveClip()`. Gate the App.svelte clip-attach `$effect` (EncodedTap) on `!nativeMode`. `StreamControls` "Clip" → `connectionStore.saveClip()`.
- [ ] **Step 2: Verify:** `pnpm --dir ui run check` + `build`.
- [ ] **Step 3: Commit.** `feat(rtc): native clip path via rtc_save_clip (6c.8)`

---

## Task 6c.9: `rtc_connect` lifecycle + `RtcEventDto` forwarding (Rust, gated)

**Files:** Modify `src/lib.rs`.
**Interfaces:** Consumes 6a `engine::spawn`/`take_events`/`RtcHandle`, 6b `frame_sink`. Produces the real bodies of `rtc_connect`/`rtc_disconnect`/`rtc_send_input`/`rtc_request_keyframe`/`rtc_save_clip` + the `RtcEventDto` emitted on `rtc_event`.

- [ ] **Step 1:** Define `RtcEventDto` (serde, `#[serde(tag="kind")]`, camelCase) mirroring `RtcEvent` + an `Ended` case.
- [ ] **Step 2:** `rtc_connect`: clone `state.auth` under lock, drop the lock; refuse if `state.rtc` is Some; `engine::spawn(auth, server_id, play_path, Some(state.frame_sink.clone()))`; store the handle; `take_events()`; spawn a task forwarding each event → `app.emit("rtc_event", dto)` and emitting `Ended` when the stream closes.
- [ ] **Step 3:** `rtc_disconnect` (take + `disconnect()`), `rtc_send_input` (map the DTO state → `GamepadFrame` → `handle.send_input`), `rtc_request_keyframe` (`handle.request_keyframe`), `rtc_save_clip` (`handle.clip().await` → `clip::save_assembled_clip(&clip, &clips_dir()?)` → path).
- [ ] **Step 4: Verify (WSL + default):** `cargo build --features native-webrtc` + `cargo build` both Finished.
- [ ] **Step 5: Commit.** `feat(rtc): rtc_connect lifecycle + RtcEvent forwarding to the webview (6c.9)`

---

## Task 6c.10: `Stream.svelte` native branch + window-close teardown

**Files:** Modify `ui/src/screens/Stream.svelte`; `src/lib.rs`.
**Interfaces:** Native UI (no `<video>`, splash off state, volume hidden) + Rust `on_window_event` teardown.

- [ ] **Step 1 (TS):** In `Stream.svelte`, gate the `<video>` element + its `srcObject`/autoplay/`needsUnmute`/`playTimer` `$effect` on `!nativeMode` (inert when native; keep `videoEl`-null guards); drive splash dismissal off store state / the FirstFrame surrogate (6c.6); hide the volume control when `nativeMode`.
- [ ] **Step 2 (Rust):** `tauri::Builder…on_window_event` — on `CloseRequested`, `#[cfg(feature="native-webrtc")]` take `state.rtc` and `disconnect()` (joins the engine thread; stops the session). 
- [ ] **Step 3: Verify:** `pnpm --dir ui run check` + `build`; `cargo build --features native-webrtc` + default both Finished.
- [ ] **Step 4: Commit.** `feat(rtc): Stream.svelte native branch + window-close engine teardown (6c.10)`

---

## Self-Review
**Spec coverage:** C1→6c.1; C2/C3→6c.9; C4→6c.10; C5→6c.3; C6→6c.6; C7→6c.7; C8→6c.8; C9→6c.10; C10→6c.2+6c.4; input bridge (E)→6c.5. ✅
**Placeholder scan:** pure/TDD tasks carry test+impl; Rust gated tasks name the WSL+default verify; "READ X / grep Y" notes name the exact symbol (integration reality). ✅
**Type consistency:** `ConnectionBackend` surface (6c.3) is the contract 6c.6/6c.7 implement/consume; `RtcEvent` DTO shape agreed between 6c.2 (TS) and 6c.9 (Rust) via `kind`+camelCase; `mapStats`/`completeSnapshot` (6c.4) consumed by 6c.6. ✅
**Note:** 6c.9/6c.10's live behavior + 6c.6's render-coupling (splash) are validated together with the 6b spike on CachyOS; the build-here gate is WSL/pnpm compile + the Vitest unit tests.
