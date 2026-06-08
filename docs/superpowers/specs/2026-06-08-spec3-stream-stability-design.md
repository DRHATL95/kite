# Spec 3 — Stream Stability & Quality (Audio-First) — Design Spec

- **Date:** 2026-06-08
- **Status:** Draft (awaiting user review). **Implementation deferred** until Spec 2's HUD
  produces real telemetry from the owner's Xbox.
- **Spec:** 3 of 4 in the "Greatly Improve Xbox Remote" program
- **Depends on:** Spec 2 (the diagnostics HUD + the Svelte connection core)

---

## 1. Program context & the honesty principle

This spec attacks the north-star pain: **"connects, then stutters/freezes/drops."** The
owner's use is **audio-first** (occasional video shared to Discord), so the audio path's
continuity matters most.

**Critical constraint:** there is no Xbox in the development environment. The root cause of
the stutter/drop is **not knowable from code reading** — it requires real candidate-pair,
packet-loss, jitter, NACK/PLI, and freeze telemetry from a live session on the owner's
network. Therefore this spec is deliberately partitioned into three honesty tiers, and its
implementation is **gated on data from Spec 2's HUD**:

- **Tier A — Confident fixes:** provably-correct, data-independent improvements. Safe to
  implement and verify without an Xbox (the logic is client-side and self-checking).
- **Tier B — API-gated:** changes we can *build* now, but whose *efficacy* depends on what
  Microsoft's xHome API accepts/returns. Build behind a flag; validate against the console.
- **Tier C — Needs-Xbox-data:** decisions that cannot be made until telemetry exists. The
  HUD + a one-shot "capture bundle" turn these into answerable questions.

**We will not claim the stutter is "fixed" until the HUD confirms a cause and a measured
improvement against the owner's Xbox.** Plausible ≠ proven.

---

## 2. Step 0 — the diagnostics capture bundle (do this first, on real hardware)

Before tuning anything, add a one-shot **"Capture diagnostics bundle"** action that dumps,
from a single real session:
- the resolved `iceServers` list (scheme breakdown: stun vs turn count, source),
- the raw xHome `/configuration` response (what `serverDetails` actually contains),
- the negotiated candidate-pair `localCandidateType`/`remoteCandidateType` (host/srflx/relay),
- a full `getStats()` snapshot series, and
- the state/event timeline (transitions, trigger reasons, handshake timing, channel opens).

**One capture against the owner's Xbox resolves most Tier-B and Tier-C unknowns at once**
(TURN availability, audio-only acceptance, version semantics, the real drop cause). This is
the cheapest path from "guessing" to "knowing."

---

## 3. Tier A — Confident fixes (data-independent)

Each is client-side, self-verifying, and carries no protocol risk.

1. **Stats-driven frozen-video auto-recovery.** Detect a stall (`framesDecoded` not advancing
   or `framesPerSecond == 0` for N consecutive 2s samples while `connected`) and auto-fire the
   existing `{message:'videoKeyframeRequested', ifrRequested:true}` on the control channel.
   Uses the existing keyframe path; no Xbox-side change.
2. **Reconnect hardening.** Add jitter to the 3/6/9s backoff (avoid thundering-herd on Xbox
   session cleanup); attribute the trigger (ice-failed / conn-failed / control-close /
   server-disconnect / idle-kick) and record which attempt succeeded; reset `reconnectAttempts`
   only after `_waitForDataChannels` succeeds AND first track arrives (so a half-open reconnect
   isn't miscounted).
3. **ICE-server provenance surfaced.** Stop silently swallowing the `get_ice_servers` failure;
   show source = `xbox-provided | fallback-only` and stun/turn counts in the HUD.
4. **Optional `iceTransportPolicy:'relay'` toggle.** Let a user on a hostile NAT force relay
   when TURN creds exist. Wiring the toggle is data-independent (its *value* is Tier B).
5. **Proactive idle keepalive.** Start the idle micro-pulse once `streaming` and ~30s without
   input, *before* the first `WarningForBeingIdle` — avoiding the race that can cause
   `KickForBeingIdle`. Uses the existing `sendIdleKeepalive()` path.
6. **ICE-gathering wait fix.** Replace the blind 1000ms `setTimeout` before `exchange_sdp`
   with a wait on `icegatheringstate === 'complete'` OR a timeout — fast networks proceed
   immediately, slow ones still gather adequately.
7. **Connection event/timeline log** (persisted): state transitions + timestamps, trigger
   reasons, per-attempt outcomes, handshake timing, channel-open times — the substrate for
   debugging against a real Xbox and for the capture bundle (§2).
8. **Expanded read-only stats** (already enumerated in the Spec 2 HUD) — the foundation for
   freeze detection and for attributing the drop cause.

---

## 4. Tier B — API-gated (build behind a flag; validate on hardware)

Implementable now, but **efficacy unknown until tested against the real xHome API**:

1. **Audio-first / audio-only offer.** Skip `addTransceiver('video')` or set it `inactive`
   before `createOffer` to produce an audio+data-only SDP. *Gated:* the `/sdp` endpoint may
   require a video m-line and reject the offer. Ship behind a toggle with **automatic fallback
   to full A/V** if the offer is rejected.
2. **`audioConfiguration` values.** Try `Mono` (low bandwidth) / `None`. *Gated:* the field is
   a hardcoded `"Stereo"` string (`xhome.rs:394`); unknown if other values are honored or error.
3. **`videoConfiguration.preferred_version` lowering (3→1).** One-line change to request lower
   quality. *Gated:* the version→resolution/bitrate mapping is opaque/server-interpreted.
4. **SDP bandwidth cap (`b=AS`).** Inject a bitrate ceiling into the offer. *Gated:* unknown if
   the server respects it.
5. **TURN relay efficacy.** Even with `relay` forced, it only helps if MS returns usable
   `turn:` URLs + valid creds AND the relay reaches the Xbox. Buildable now; efficacy is Tier C.
6. **Honor `keepAlivePulseSeconds`** from the API instead of the hardcoded 30s (currently read
   but unused). *Gated:* depends on whether the real API returns it.
7. **Mid-session A/V reconfiguration** (drop video after streaming) — may need SDP renegotiation
   or a fresh session. Determines whether audio-first is a runtime toggle vs a connect-time choice.

Each Tier-B item ships with: a flag (default off), a clear fallback, and a HUD readout of
whether the Xbox accepted it.

---

## 5. Tier C — Needs Xbox data (answer via §2 capture, then decide)

- The **actual root cause** of stutter/drop (direct-path failing / STUN overloaded / weak
  direct path from no relay) — indistinguishable without candidate-pair + loss + freeze data.
- What `serverDetails` the real `/configuration` returns (stun vs turn; creds populated?) —
  decides whether relay-only mode is even available.
- Whether NAT traversal is actually failing on the owner's network (inspect negotiated
  candidate types).
- Typical/peak bitrate, resolution, freeze frequency — sets sensible HUD thresholds and decides
  whether forced low-res / audio-only is genuinely needed vs a fallback.
- Validation of the magic-number timings (1s ICE wait, 2s pre-keyframe, 10s grace, 30s
  keepalive) against the real console.

---

## 6. Sequencing
1. **(Spec 2 done first.)** HUD shipping in the Svelte app.
2. **Capture bundle** (§2) — owner runs one real session; we get telemetry.
3. **Tier A** confident fixes — implement + verify (most are verifiable client-side; freeze
   detection and reconnect attribution confirmed against the capture).
4. **Read the telemetry** → answer Tier C questions → decide which Tier B levers matter.
5. **Tier B** — implement the levers the data justifies (e.g., force relay if no direct path;
   audio-only if `/sdp` accepts it), each validated against the console.
6. **Tune** the magic numbers to the measured reality.

---

## 7. Out of scope
- Moving WebRTC into Rust (`str0m`/gstreamer webrtcbin) — still deferred. Only revisit if the
  telemetry shows a problem the browser stack genuinely can't address.
- Visual polish of the HUD / stage view → Spec 4.

---

## 8. Acceptance criteria
- **§2 capture bundle** produces a complete, shareable diagnostic from one real session.
- **Tier A** items implemented and verified (freeze→auto-keyframe fires on a simulated stall;
  reconnect attribution shows correct trigger; proactive keepalive starts pre-warning; ICE-gather
  wait short-circuits on `complete`; provenance + relay toggle wired). These are verifiable
  without a console except where they need a live session, which the capture supplies.
- **Tier B** items implemented behind flags with working fallbacks; each annotated with the
  observed real-Xbox acceptance result once tested.
- **Measured improvement:** after Tier A (+ any justified Tier B), a real session on the owner's
  Xbox shows a documented reduction in freeze count / drop frequency vs a baseline capture.
  **This criterion can only be met on the owner's hardware** and is the true definition of done.

---

## 9. Why this spec is written now but implemented later
Writing it now captures the full plan while the protocol grounding is fresh and locks the
honest tiers. Implementation waits for Spec 2's HUD because Spec 3 without telemetry is
exactly the "plausible-but-unproven" trap the whole program is designed to avoid.
