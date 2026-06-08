# Spec 2 — Frontend Re-platform + Diagnostics HUD — Design Spec

- **Date:** 2026-06-08
- **Status:** Draft (awaiting user review)
- **Spec:** 2 of 4 in the "Greatly Improve Xbox Remote" program
- **Depends on:** Spec 1 (Foundation) — merged to `master` (e88bad9)

---

## 1. Program context

| # | Spec | Status |
|---|------|--------|
| 1 | Foundation cleanup | ✅ Merged |
| **2** | **Frontend re-platform (Svelte 5 + TS) + diagnostics HUD + design-system foundation** (this doc) | Draft |
| 3 | Stream stability & quality (audio-first) | Spec drafted in parallel; implementation deferred until HUD data exists |
| 4 | Full visual UI overhaul | Not started |

**North star:** an audio-first cloud Remote Play app the owner uses daily. Spec 2 replaces
the brittle ~1,900-line vanilla-JS `ui/public/app.js` monolith with a typed Svelte 5
component architecture, and ships the **diagnostics HUD** — the instrument that makes
Spec 3's stability work evidence-driven rather than guesswork.

**This spec is a behavior-preserving re-platform.** It does NOT change streaming behavior,
add stability fixes (Spec 3), or do final visual polish (Spec 4). The protocol logic that
was hard-won against an undocumented Microsoft API is *ported faithfully*, then the HUD is
layered on top.

---

## 2. Locked decisions

1. **Svelte 5 (runes) + TypeScript + Vite.** Smallest runtime, compile-time reactivity
   (no VDOM diffing — ideal for a HUD updating ~2×/s), first-class Tauri integration.
   TypeScript specifically to make the Tauri `invoke` boundary type-safe (the recon's
   top fragility).
2. **Behavior-preserving port first, HUD second.** Lift `ConnectionManager` verbatim
   (state machine, keepalives, handshake, 38-byte packet, channel labels, reconnect) and
   get it green against the existing 11 Tauri commands BEFORE layering the HUD. No
   protocol refactor + UI re-architecture in the same pass.
3. **Design-system FOUNDATION only.** Tokens + base components + a clean dark theme — not
   the final aesthetic. Visual polish, the chrome-free Discord "stage" view, and flow
   redesign are Spec 4.
4. **Controller kept minimal & clean** — port the input path into a tidy module; not a focus.

---

## 3. The behavior-preservation contract (load-bearing — DO NOT "clean up")

The Svelte port MUST reproduce these exactly. Several are required for Xbox compatibility
per in-code comments; they go into a single `constants.ts` as named, commented constants.

1. **Connect ordering:** `create_xhome_session` → store `sessionId`/`sessionPath`/`gsToken`
   → **start the API keepalive IMMEDIATELY** (while session is `Provisioned`, *before* SDP
   exchange) → set up WebRTC. Delaying the keepalive past SDP causes a ~56s timeout.
2. **Two keepalives:** (a) API keepalive via `send_session_keepalive` every **30s**, which
   stops on `SessionInUnexpectedState`/`400`/when streaming; (b) idle **micro-pulse**:
   a 38-byte gamepad packet with `LeftThumbX = 4096` (~12.5% deflection, inside game
   deadzones), recentered after 32ms, every 30s.
3. **WebRTC setup order:** `RTCPeerConnection({iceServers, iceCandidatePoolSize:10})` →
   create the 4 data channels **before** `createOffer` (so SCTP is in the SDP) →
   `addTransceiver('audio','sendrecv')` + `addTransceiver('video','recvonly')` → handlers
   → `createOffer` → `setLocalDescription` → wait for ICE gathering → `exchange_sdp` →
   `setRemoteDescription(answer)` → poll ICE → start stats.
4. **Four data channels, exact label/protocol pairs:** `chat`/`chatV1`, `control`/`controlV1`,
   `message`/`messageV1`, `input`/`1.0`. `ordered: true`, DCEP-negotiated (NOT `negotiated`).
5. **Handshake:** message channel open → send `Handshake` → wait `HandshakeAck` → then
   control `authorizationRequest` (accessKey `4BDB3609-C1F1-4195-9B37-FEFF45DA8B8E`) →
   input start `gamepadChanged {wasAdded:true}` on CONTROL channel → config messages.
   Control + input stay gated until `HandshakeAck`.
6. **Keyframe:** auto-request 2s after `authorizationRequest`
   (`{message:'videoKeyframeRequested', ifrRequested:true}` on control), plus a manual button.
7. **State machine:** `idle | connecting | streaming | reconnecting | failed` with the
   existing duplicate-guards and an `onStateChange` callback per transition.
8. **Reconnect:** max 3 attempts, delay `3000ms × attempt` (3/6/9s), cleanup → recreate
   session → `_waitForDataChannels(15000)` before counting success.
9. **Reconnect/disconnect triggers:** `connectionState==='failed'` (immediate),
   `'disconnected'` (10s grace then reconnect if still down), control-channel close while
   streaming, `serverInitiatedDisconnect` with reason ≠ `WarningForBeingIdle`, ICE `failed`.
10. **Dual-track gate:** transition to `streaming` + start input ONLY when BOTH video AND
    audio tracks arrived; play after 250ms with autoplay-policy fallback (Unmute button).
11. **ICE polling:** `poll_ice_candidates` up to 20× @ 500ms; send local via `send_ice_candidate`.
12. **38-byte gamepad packet** (byte-exact): 14-byte header [reportType u16 LE (2=gamepad,
    8=clientMetadata), sequence u32 LE, timestamp f64 LE] + frameCount u8 (=1) + 23-byte
    frame [gamepadIndex u8, buttons u16 LE, 4× sticks i16 LE (Y negated, ±32767), 2× triggers
    u16 LE (0–65535), PhysicalPhysicality u32 LE=1, VirtualPhysicality u32 **BE**=1]. Deadzone
    0.1; ClientMetadata (reportType 8) once at start; idle frame every 62 frames.
13. **Keyboard→gamepad map** (WASD/IJKL sticks, Space/E/Q/Ctrl→A/X/Y/B, etc.).
14. **The 11 Tauri commands:** `create_xhome_session`, `get_ice_servers`, `exchange_sdp`,
    `send_session_keepalive`, `send_ice_candidate`, `poll_ice_candidates`, `set_stream_status`,
    `try_load_cached_auth`, `check_auth_status`, `start_xbox_auth`, `discover_xhome_consoles`.

> A Spec 2 implementation that changes any of these silently is a regression even if it
> "looks cleaner." The plan will include an explicit cross-check of `constants.ts` against
> the current `app.js` values.

---

## 4. Architecture

### 4.1 Build tooling (Vite + Tauri 2)
- Convert the frontend to a Vite + Svelte 5 + TS project rooted at `ui/`. Vite dev server
  on `http://localhost:1420`; build output to `ui/dist`.
- `tauri.conf.json`: set `build.devUrl = "http://localhost:1420"`,
  `build.frontendDist = "../ui/dist"`, `build.beforeDevCommand`/`beforeBuildCommand` to the
  npm scripts. (Current config points at static `ui/public`.)
- Add `ui/package.json`, `ui/vite.config.ts`, `ui/tsconfig.json`, `ui/svelte.config.js`.
- **Gotcha (from project memory):** run `cargo clean -p xbox-remote` before a Tauri rebuild
  when frontend assets change, or stale assets get bundled.

### 4.2 Typed Tauri command layer — `ui/src/lib/ipc/commands.ts`
The single place `invoke` is called. Each of the 11 commands gets a typed wrapper +
TS types for args/returns mirroring the Rust structs (`StreamConfig`, `IceServer`,
`IceCandidate`, the console JSON, `DeviceCodeInfo`). This is where TypeScript earns its
keep — a wrong command name or arg shape becomes a compile error.

### 4.3 Connection core (faithful port) — `ui/src/lib/connection/`
- `constants.ts` — every load-bearing constant from §3, named + commented.
- `ConnectionManager.ts` — the state machine, session lifecycle, keepalives, handshake,
  reconnect. Pure TS class; no Svelte imports. Emits state + diagnostics via callbacks.
- `dataChannels.ts` — the 4-channel setup + handshake + message routing.
- `input.ts` — the 38-byte packet encoder + gamepad polling + keyboard map (minimal/clean).
- `stats.ts` — `getStats()` sampler producing a typed `DiagnosticsSnapshot` (§5).
- A Svelte store (`connectionStore.ts`) wraps the manager so components react to state.

### 4.4 Components — `ui/src/`
- Screens: `Login.svelte`, `DeviceCode.svelte`, `ConsoleList.svelte`, `Stream.svelte`
  (preserve the existing multi-screen flow; redesign of the flow is Spec 4).
- `Stream.svelte`: the `<video>` (srcObject binding), control bar (focus/fullscreen/keyframe/
  volume — ported), stream-status overlay, and the HUD panel.
- `DiagnosticsHud.svelte` + sub-panels (§5).
- `App.svelte` routes between screens by auth/connection state (runes).

### 4.5 Design-system foundation — `ui/src/lib/design/`
- `tokens.css` — CSS custom properties: color palette (dark), spacing scale, type scale,
  radii, elevation. One source of truth for Spec 4 to evolve.
- Base components: `Button.svelte`, `Panel.svelte`, `Stat.svelte`, `Toggle.svelte`,
  `Badge.svelte`. Clean, minimal, accessible — not the final look.

---

## 5. The Diagnostics HUD (first-class deliverable)

A `DiagnosticsSnapshot` is sampled ~every 2s from `getStats()` + manager state, rendered in
collapsible panels. All read-only — no protocol risk. Metrics (grounded in what `getStats`
actually provides):

- **Video:** fps, resolution (w×h), framesDecoded rate, framesDropped, **freezeCount** +
  totalFreezesDuration.
- **Bitrate:** inbound video kbps (+ short sparkline), candidate-pair availableIncomingBitrate.
- **Packet health:** packetsLost + **loss %**, jitter, jitterBufferDelay.
- **Recovery:** nackCount, **pliCount**, client keyframe-request count, time-since-last-keyframe.
- **Network path:** RTT (ms), **local/remote candidate type** (host/srflx/**relay**) — reveals
  direct vs relayed, selected candidate-pair state.
- **ICE/connection lifecycle:** live iceConnectionState, iceGatheringState, connectionState,
  remote-candidates-added, ICE poll attempts used (of 20).
- **ICE server provenance:** stun vs turn count, source = **`xbox-provided` vs `fallback-only`**
  (this directly informs Spec 3's TURN question).
- **Session/keepalive:** state-machine state, active keepalive (API vs idle-pulse), time since
  last keepalive, last idle-warning `secondsUntilKick`.
- **Data channels:** open/closed + open-timestamp per channel; Handshake→Ack timing.
- **Reconnect:** current attempt (of 3), last trigger reason, backoff in effect, per-attempt history.
- **Track timing:** video vs audio arrival timestamps + skew.
- **Input:** outbound packet rate (Hz), last sequence number.

The HUD renders placeholders pre-connection and live data while streaming. It must be
toggleable and unobtrusive (it becomes part of the Spec 4 stage view later).

---

## 6. Out of scope (later specs)
- Any **stability fix** (frozen-video auto-keyframe, reconnect jitter, relay toggle,
  proactive keepalive, ICE-gather wait, audio-first toggle) → **Spec 3**.
- Final visual aesthetic, the Discord "stage" view, flow redesign → **Spec 4**.
- Moving WebRTC into Rust → still deferred (decide after instrument).

---

## 7. Handling the user's uncommitted `app.js`
The working tree has uncommitted edits to `ui/public/app.js` (the owner's in-progress work).
Spec 2 replaces this file. **Before implementation begins**, the plan's first task commits
the current `app.js` state to history (so nothing is lost and the port can diff against it),
and the port reads from that committed source. This is confirmed with the owner at execution
start.

---

## 8. Acceptance criteria
1. `npm run build` (Vite) + `cargo build` succeed; `npm run check` (svelte-check/tsc) reports
   **0 type errors**.
2. The Tauri app launches the Svelte frontend; the auth flow (device-code), console discovery,
   and session initiation all work (verifiable without a console up to the WebRTC offer).
3. `constants.ts` values are cross-checked, 1:1, against the current `app.js` (the §3 list) —
   documented in the plan.
4. The WebRTC connect path reaches the same state transitions as the original up to the point
   that requires a live Xbox (smoke-verified; full stream needs hardware — Spec 3 territory).
5. The diagnostics HUD renders all §5 panels: live data when connected, sensible placeholders
   otherwise. A mock `DiagnosticsSnapshot` is used to verify rendering without a console.
6. Controller input (gamepad + keyboard map) is ported and the 38-byte encoder is unit-tested
   against known-good byte output.
7. No regression in the 11 Tauri commands (backend untouched; the typed layer calls the same names/args).

---

## 9. Risks & mitigations
| Risk | Mitigation |
|---|---|
| Tauri+Vite integration friction (devUrl/dist, CSP) | Stand up a "hello Svelte" Tauri build first (plan task 1) before porting logic. |
| Silently dropping a load-bearing constant | `constants.ts` cross-check task (§8.3); unit-test the 38-byte encoder. |
| Stale frontend assets after rebuild | `cargo clean -p xbox-remote` before Tauri rebuilds (project memory). |
| Autoplay policy blocks audio | Port the existing 250ms-delay + Unmute-button fallback (§3.10). |
| Losing the owner's uncommitted `app.js` work | Commit it first (§7). |
| Over-building the design system | Foundation only — tokens + ~5 base components; defer polish to Spec 4. |

---

## 10. Verification reality
Everything except a live video+audio stream is verifiable here: build, typecheck, launch,
auth, discovery, UI/HUD rendering (with mock snapshots), and the encoder unit test. A real
rendered stream needs the owner's Xbox — that's the boundary where Spec 3's hardware-gated
work begins.
