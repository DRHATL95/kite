# Spec 2 — Frontend Re-platform + Diagnostics HUD — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the 1,900-line vanilla-JS `ui/public/app.js` with a typed Svelte 5 +
Vite component architecture that preserves all streaming behavior, and ship the diagnostics HUD.

**Architecture:** Svelte 5 (runes) + TypeScript + Vite, built into `ui/dist` and served by
Tauri 2. A pure-TS `ConnectionManager` (faithful port of the protocol logic) drives Svelte
stores; components render auth/discovery/stream screens + the HUD. The Rust backend and its
11 Tauri commands are UNCHANGED.

**Tech Stack:** Svelte 5, TypeScript, Vite, `@tauri-apps/api` v2, svelte-check, vitest.

**Reference:** Design spec `docs/superpowers/specs/2026-06-08-spec2-frontend-replatform-design.md`
(esp. §3, the 14-point behavior-preservation contract). The committed `ui/public/app.js` is the
source-of-truth reference for verbatim protocol code.

**Granularity note:** This plan pins COMPLETE code for protocol-critical pieces (constants,
the 38-byte encoder, the typed IPC signatures, shared interfaces) and gives task-level
guidance for Svelte component bodies (implementers write these against spec §3 + the reference
`app.js`). Every task ends in a green `npm run check` (svelte-check/tsc) + `npm run build`,
and commits.

**Branch:** `spec2-frontend-replatform` (already checked out; specs committed here).

**Git rule for all tasks:** explicit staging only (the repo has unrelated working-tree noise:
`gen/schemas/*.json`, untracked `.sh`/`.claude/`). Never `git add -A`.

---

## File map

```
ui/
  package.json, vite.config.ts, tsconfig.json, svelte.config.js, index.html
  src/
    main.ts                      # mounts App
    App.svelte                   # routes screens by auth/connection state
    lib/
      ipc/commands.ts, ipc/types.ts        # typed Tauri invoke layer
      connection/constants.ts              # load-bearing constants (spec §3)
      connection/ConnectionManager.ts      # state machine, lifecycle, keepalives, reconnect
      connection/dataChannels.ts           # 4 channels + handshake + message routing
      connection/input.ts                  # 38-byte encoder + gamepad/keyboard
      connection/stats.ts                  # getStats -> DiagnosticsSnapshot
      stores/connection.ts, stores/auth.ts # Svelte stores wrapping the manager
      design/tokens.css                    # design-system foundation
      design/{Button,Panel,Stat,Toggle,Badge}.svelte
    screens/{Login,DeviceCode,ConsoleList,Stream}.svelte
    components/{StreamControls,StreamStatus,DiagnosticsHud}.svelte
    components/hud/{VideoPanel,NetworkPanel,PacketPanel,SessionPanel,ChannelPanel}.svelte
```
Old `ui/public/*` is removed in the final task once parity is reached.

---

## Task 1: Scaffold Vite + Svelte 5 + TS in the Tauri project

**Goal:** prove the Tauri↔Vite integration with a hello-world Svelte app BEFORE porting logic.

**Files:** Create `ui/package.json`, `ui/vite.config.ts`, `ui/tsconfig.json`,
`ui/svelte.config.js`, `ui/index.html`, `ui/src/main.ts`, `ui/src/App.svelte`. Modify
`tauri.conf.json`.

- [ ] **Step 1:** `ui/package.json` with deps `svelte@^5`, `@sveltejs/vite-plugin-svelte`,
  `vite@^6`, `typescript`, `svelte-check`, `@tsconfig/svelte`, `@tauri-apps/api@^2`, `vitest`;
  scripts: `dev` (vite), `build` (`vite build`), `check` (`svelte-check --tsconfig ./tsconfig.json`),
  `test` (vitest run).
- [ ] **Step 2:** `vite.config.ts` (svelte plugin; `server.port = 1420`, `server.strictPort = true`;
  `build.outDir = "dist"`; `clearScreen: false`). `tsconfig.json` extends `@tsconfig/svelte`
  with `strict: true`, `moduleResolution: "bundler"`. `svelte.config.js` with `vitePreprocess`.
- [ ] **Step 3:** `index.html` (`<div id="app">` + `<script type="module" src="/src/main.ts">`);
  `main.ts` mounts `App` with Svelte 5 `mount()`; `App.svelte` renders a placeholder "Xbox
  Remote — Svelte" heading.
- [ ] **Step 4:** Update `tauri.conf.json` `build`: `devUrl: "http://localhost:1420"`,
  `frontendDist: "../ui/dist"`, `beforeDevCommand: "npm --prefix ui run dev"`,
  `beforeBuildCommand: "npm --prefix ui run build"`.
- [ ] **Step 5:** Run `npm --prefix ui install`, `npm --prefix ui run build`, then
  `cargo clean -p xbox-remote && cargo build`. Expected: both succeed; `ui/dist` produced.
- [ ] **Step 6:** Add `ui/node_modules`, `ui/dist` to `.gitignore`.
- [ ] **Step 7:** Commit: `git add ui/package.json ui/vite.config.ts ui/tsconfig.json ui/svelte.config.js ui/index.html ui/src tauri.conf.json .gitignore && git commit -m "feat(ui): scaffold Svelte 5 + Vite + TS frontend in Tauri"`
- [ ] **Step 8 (manual smoke):** `npm --prefix ui run dev` then open http://localhost:1420 — the placeholder renders. (Don't leave the dev server running.)

---

## Task 2: Typed Tauri IPC layer

**Files:** Create `ui/src/lib/ipc/types.ts`, `ui/src/lib/ipc/commands.ts`.

- [ ] **Step 1:** In `types.ts`, mirror the Rust structs as TS types: `StreamConfig`
  (`sessionId, sessionPath, exchangeResponse, gsToken, keepAlivePulseSeconds?`), `IceServer`
  (`urls: string|string[], username?, credential?`), `IceCandidate` (match `xhome.rs`),
  `XHomeConsoleJson` (the fields the list returns), `DeviceCodeInfo` (`userCode, verificationUri`).
  Verify field names against `src/xhome.rs` serde renames.
- [ ] **Step 2:** In `commands.ts`, one typed wrapper per command (import `invoke` from
  `@tauri-apps/api/core`), e.g.:
  ```ts
  import { invoke } from "@tauri-apps/api/core";
  export const createXhomeSession = (serverId: string, playPath?: string) =>
    invoke<string>("create_xhome_session", { serverId, playPath });
  export const getIceServers = (sessionPath: string) =>
    invoke<IceServer[]>("get_ice_servers", { sessionPath });
  // ...all 11: try_load_cached_auth, check_auth_status, start_xbox_auth,
  // discover_xhome_consoles, create_xhome_session, get_ice_servers, exchange_sdp,
  // send_ice_candidate, poll_ice_candidates, send_session_keepalive, set_stream_status
  ```
  Note arg casing: Tauri maps JS camelCase → Rust snake_case automatically; verify each
  command's parameter names against `src/main.rs`.
- [ ] **Step 3:** `npm --prefix ui run check` → 0 errors.
- [ ] **Step 4:** Commit (`feat(ui): typed Tauri IPC command layer`).

---

## Task 3: Load-bearing constants + behavior cross-check

**Files:** Create `ui/src/lib/connection/constants.ts`.

- [ ] **Step 1:** Port EVERY constant from spec §3 with a comment citing its origin, e.g.:
  ```ts
  // Data channel (label, protocol) pairs — REQUIRED by Xbox; do not change. (app.js handshake)
  export const CHANNELS = [
    { label: "chat", protocol: "chatV1" },
    { label: "control", protocol: "controlV1" },
    { label: "message", protocol: "messageV1" },
    { label: "input", protocol: "1.0" },
  ] as const;
  export const CONTROL_ACCESS_KEY = "4BDB3609-C1F1-4195-9B37-FEFF45DA8B8E";
  export const API_KEEPALIVE_MS = 30_000;
  export const IDLE_PULSE_MS = 30_000;
  export const IDLE_PULSE_DEFLECTION = 4096;      // ~12.5% LeftThumbX, inside deadzones
  export const RECONNECT_MAX = 3;
  export const RECONNECT_BASE_MS = 3_000;          // delay = base * attempt
  export const DATACHANNEL_WAIT_MS = 15_000;
  export const ICE_POLL_ATTEMPTS = 20;
  export const ICE_POLL_INTERVAL_MS = 500;
  export const DISCONNECT_GRACE_MS = 10_000;
  export const PRE_KEYFRAME_DELAY_MS = 2_000;
  export const INPUT_DEADZONE = 0.1;
  export const IDLE_FRAME_EVERY = 62;
  // ...etc (all §3 values)
  ```
- [ ] **Step 2 (cross-check, required):** Open the reference `ui/public/app.js` and confirm each
  constant matches its original literal 1:1. Record the cross-check as a comment block at the
  top of `constants.ts` (`// Verified against ui/public/app.js @ <sha> on 2026-06-08`).
- [ ] **Step 3:** `npm --prefix ui run check` → 0 errors. Commit (`feat(ui): load-bearing protocol constants`).

---

## Task 4: Input module + 38-byte encoder (TDD)

**Files:** Create `ui/src/lib/connection/input.ts`, `ui/src/lib/connection/input.test.ts`.

- [ ] **Step 1 (test first):** Write a vitest test asserting `encodeGamepadFrame()` produces the
  exact 38 bytes for a known input (neutral frame; a frame with `A` pressed; full-deflection
  stick with Y-negation). Compute expected bytes from spec §3.12. Include the BE quirk on
  VirtualPhysicality.
- [ ] **Step 2:** Run `npm --prefix ui run test` → FAIL (not implemented).
- [ ] **Step 3:** Implement `encodeGamepadFrame`/`encodeClientMetadata` with a `DataView`
  (LE except VirtualPhysicality u32 BE), the deadzone, Y-axis negation, trigger 0–65535 scaling.
  Plus `mapKeyboardToGamepad` (spec §3.13) and a `GamepadPoller` (60Hz, idle frame every 62).
- [ ] **Step 4:** Run tests → PASS. `npm --prefix ui run check` → 0 errors.
- [ ] **Step 5:** Commit (`feat(ui): gamepad input encoder + keyboard map (tested)`).

---

## Task 5: ConnectionManager core (state machine + session lifecycle)

**Files:** Create `ui/src/lib/connection/ConnectionManager.ts` (+ `connection/types.ts` for
`ConnectionState`, `DiagnosticsSnapshot` shape used later).

- [ ] **Step 1:** Define `type ConnectionState = "idle"|"connecting"|"streaming"|"reconnecting"|"failed"`
  and the manager class skeleton: constructor takes the typed `commands` + callbacks
  (`onStateChange`, `onDiagnostics`, `onLog`). Fields for `pc: RTCPeerConnection`, channels,
  session ids, timers.
- [ ] **Step 2:** Port `connect()`/`_createSessionAndStream()` honoring spec §3.1 ordering:
  `createXhomeSession` → store ids → **start API keepalive (§3.2a) immediately** → build
  `RTCPeerConnection({iceServers, iceCandidatePoolSize:10})` → channels (Task 6) → transceivers
  (audio sendrecv, video recvonly) → handlers → `createOffer` → `setLocalDescription` → ICE-gather
  wait (port the existing 1s wait verbatim for now; the smarter wait is Spec 3) → `exchangeSdp` →
  `setRemoteDescription` → ICE poll loop (§3.11) → stats start (Task 8).
- [ ] **Step 3:** Port the dual-track gate (§3.10), reconnect (§3.8) + triggers (§3.9), and the
  two keepalives (§3.2). Keep behavior identical to `app.js`; reference it line-by-line.
- [ ] **Step 4:** `npm --prefix ui run check` → 0 errors. (Runtime needs the backend + later tasks;
  full verification is Task 13.)
- [ ] **Step 5:** Commit (`feat(ui): ConnectionManager state machine + session lifecycle`).

---

## Task 6: Data channels + handshake

**Files:** Create `ui/src/lib/connection/dataChannels.ts`.

- [ ] **Step 1:** `createDataChannels(pc)` creating the 4 channels from `CHANNELS` with
  `{ordered:true, protocol}` (DCEP, not negotiated). Return typed handles.
- [ ] **Step 2:** Port the handshake (§3.5): message-channel `onopen` → send `Handshake` → on
  `HandshakeAck` → control `authorizationRequest` (CONTROL_ACCESS_KEY) → input start
  `gamepadChanged {wasAdded:true}` on control → config messages. Gate control+input until Ack.
- [ ] **Step 3:** Port `_handleJsonMessage` routing (idle-warning handling, serverInitiatedDisconnect
  reasons) and the auto-keyframe (§3.6) 2s after auth.
- [ ] **Step 4:** `npm --prefix ui run check` → 0 errors. Commit (`feat(ui): data channels + Xbox handshake`).

---

## Task 7: Stats sampler → DiagnosticsSnapshot

**Files:** Create `ui/src/lib/connection/stats.ts`; extend `connection/types.ts`.

- [ ] **Step 1:** Define `DiagnosticsSnapshot` covering all HUD metrics (spec §5): video
  (fps/res/decoded/dropped/freezeCount), bitrate + availableIncomingBitrate, packetsLost/loss%/
  jitter/jitterBufferDelay, nackCount/pliCount/keyframeRequests, RTT + candidate types, ICE
  lifecycle states, iceServer provenance, keepalive/session state, channel states + handshake
  timing, reconnect telemetry, track skew, input rate.
- [ ] **Step 2:** `StatsSampler` polling `pc.getStats()` every 2s, mapping report types
  (inbound-rtp video, candidate-pair, transport) into a `DiagnosticsSnapshot`, computing deltas
  (bitrate, loss%). Emit via `onDiagnostics`.
- [ ] **Step 3:** Unit-test the pure mapping with a hand-built `RTCStatsReport`-like fixture.
- [ ] **Step 4:** `check` + `test` pass. Commit (`feat(ui): getStats diagnostics sampler`).

---

## Task 8: Svelte stores + design-system foundation

**Files:** Create `ui/src/lib/stores/{connection,auth}.ts`,
`ui/src/lib/design/tokens.css`, `ui/src/lib/design/{Button,Panel,Stat,Toggle,Badge}.svelte`.

- [ ] **Step 1:** `connection.ts` store: instantiate `ConnectionManager`, expose `$state` for
  current `ConnectionState`, latest `DiagnosticsSnapshot`, and the event log; wire the manager
  callbacks to update the store. `auth.ts` store for auth state.
- [ ] **Step 2:** `tokens.css`: CSS custom properties — dark palette, spacing scale, type scale,
  radii, elevation. Import once in `main.ts`.
- [ ] **Step 3:** Base components (clean/minimal, accessible; not final polish): `Button`,
  `Panel`, `Stat` (label+value+unit), `Toggle`, `Badge` (status colors).
- [ ] **Step 4:** `check` passes. Commit (`feat(ui): stores + design-system foundation`).

---

## Task 9: Auth + discovery screens (verifiable end-to-end without an Xbox)

**Files:** Create `ui/src/screens/{Login,DeviceCode,ConsoleList}.svelte`.

- [ ] **Step 1:** `Login.svelte`: "Sign in" → `try_load_cached_auth` then `start_xbox_auth`;
  on device code, route to `DeviceCode`.
- [ ] **Step 2:** `DeviceCode.svelte`: show `userCode` + `verificationUri`, poll `check_auth_status`,
  advance to `ConsoleList` on success.
- [ ] **Step 3:** `ConsoleList.svelte`: `discover_xhome_consoles`, render the consoles (name,
  power state, type), select → start connection.
- [ ] **Step 4:** `check` passes; manual smoke against the real backend (device-code sign-in +
  console list both work — this is fully testable without a console).
- [ ] **Step 5:** Commit (`feat(ui): auth + console discovery screens`).

---

## Task 10: Stream screen + controls + status overlay

**Files:** Create `ui/src/screens/Stream.svelte`, `ui/src/components/{StreamControls,StreamStatus}.svelte`.

- [ ] **Step 1:** `Stream.svelte`: bind the connection store's media stream to `<video>.srcObject`;
  port the dual-track gate playback (250ms delay + Unmute fallback, §3.10).
- [ ] **Step 2:** `StreamControls`: focus mode, fullscreen, manual keyframe (calls the manager),
  volume (localStorage persistence) — port from `app.js`.
- [ ] **Step 3:** `StreamStatus`: color-coded connection/reconnect status overlay.
- [ ] **Step 4:** `check` passes; render with a mock stream. Commit (`feat(ui): stream screen + controls`).

---

## Task 11: Diagnostics HUD

**Files:** Create `ui/src/components/DiagnosticsHud.svelte` +
`ui/src/components/hud/{VideoPanel,NetworkPanel,PacketPanel,SessionPanel,ChannelPanel}.svelte`.

- [ ] **Step 1:** `DiagnosticsHud` subscribes to the connection store's `DiagnosticsSnapshot`;
  toggleable; renders the panels using `Stat`/`Badge`.
- [ ] **Step 2:** Panels map snapshot fields (spec §5): Video, Network/ICE (incl. candidate type +
  provenance), Packets, Session/keepalive, Channels/reconnect. Placeholders when no snapshot.
- [ ] **Step 3:** Verify rendering with a mock `DiagnosticsSnapshot` (full + empty). `check` passes.
- [ ] **Step 4:** Commit (`feat(ui): diagnostics HUD`).

---

## Task 12: App routing + full wiring

**Files:** Modify `ui/src/App.svelte`, `ui/src/main.ts`.

- [ ] **Step 1:** `App.svelte` routes Login→DeviceCode→ConsoleList→Stream by auth + connection
  state (runes/derived). Mount the HUD within Stream.
- [ ] **Step 2:** End-to-end manual smoke: sign in → list consoles → select → the WebRTC connect
  path runs to the SDP offer/exchange (full stream needs a console; verify it reaches the same
  states as the original via the event log/HUD).
- [ ] **Step 3:** `check` + `build` pass. Commit (`feat(ui): wire screens + connection end-to-end`).

---

## Task 13: Remove the old monolith + finalize

**Files:** Delete `ui/public/app.js`, `ui/public/index.html`, `ui/public/styles.css`,
`ui/public/test*.html`. Verify `tauri.conf.json` no longer references `ui/public`.

- [ ] **Step 1:** Confirm no code references `ui/public/*`. Delete the old monolith + test pages
  (`git rm`).
- [ ] **Step 2:** `npm --prefix ui run check` (0 errors) + `npm --prefix ui run test` (pass) +
  `cargo clean -p xbox-remote && cargo build` + a final launch smoke.
- [ ] **Step 3:** Update `CLAUDE.md` frontend section to describe the Svelte 5 + TS + Vite stack
  and the build commands (`npm --prefix ui run dev/build/check`).
- [ ] **Step 4:** Commit (`refactor(ui): remove legacy app.js monolith; Svelte port is now the frontend`).

---

## Final verification
- [ ] `npm --prefix ui run check` → 0 type errors.
- [ ] `npm --prefix ui run test` → encoder + stats-mapper tests pass.
- [ ] `cargo clean -p xbox-remote && cargo build` → `Finished`.
- [ ] App launches the Svelte frontend; device-code auth + console discovery work.
- [ ] WebRTC connect path reaches the original state transitions up to the live-Xbox boundary
  (event log / HUD confirm); HUD renders all panels.
- [ ] `constants.ts` cross-check comment present; behavior contract (spec §3) preserved.
- [ ] Old `ui/public/app.js` removed; `CLAUDE.md` updated.

Maps to spec §8 acceptance criteria.
