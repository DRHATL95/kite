/**
 * nativeStats.ts — map the native engine's small StatsSnapshot onto the rich
 * DiagnosticsSnapshot the HUD consumes (Phase 6 / native-webrtc).
 *
 * The native engine emits only bitrate/fps/framesDecoded/freezeCount (its
 * StatsSnapshot has no equivalent of the browser's RTCStats). So `mapStats`
 * fills the handful of fields it can, and `completeSnapshot` overlays that on a
 * baseline that sets EVERY required DiagnosticsSnapshot field (the rest null) so
 * `onDiagnostics` always receives a complete object — never a Partial, which the
 * HUD would crash on (it reads required fields like `channels`, `currentAttempt`).
 */

import { RECONNECT_MAX_ATTEMPTS } from "./constants.js";
import type { DiagnosticsSnapshot } from "./types.js";

/** The four counters the native engine's StatsSnapshot carries. */
export interface NativeStats {
  bitrateKbps: number;
  fps: number;
  framesDecoded: number;
  freezeCount: number;
}

/** Map the native counters onto the DiagnosticsSnapshot fields they correspond to. */
export function mapStats(s: NativeStats): Partial<DiagnosticsSnapshot> {
  return {
    inboundVideoKbps: s.bitrateKbps,
    fps: s.fps,
    framesDecoded: s.framesDecoded,
    freezeCount: s.freezeCount,
  };
}

/**
 * Build a COMPLETE DiagnosticsSnapshot: a baseline with every required field set
 * (nullable RTCStats fields explicitly null, since native mode has no getStats),
 * overlaid with `partial`.
 */
export function completeSnapshot(
  partial: Partial<DiagnosticsSnapshot>,
): DiagnosticsSnapshot {
  const baseline: DiagnosticsSnapshot = {
    capturedAt: Date.now(),

    // video
    fps: null,
    width: null,
    height: null,
    framesDecoded: null,
    framesDropped: null,
    freezeCount: null,
    totalFreezesDuration: null,

    // bitrate
    inboundVideoKbps: null,
    availableIncomingBitrate: null,

    // packets
    packetsLost: null,
    packetsReceived: null,
    lossPct: null,
    jitter: null,
    jitterBufferDelay: null,

    // recovery
    nackCount: null,
    pliCount: null,
    keyframeRequestsSent: null,
    msSinceLastKeyframe: null,

    // network
    rttMs: null,
    localCandidateType: null,
    remoteCandidateType: null,
    candidatePairState: null,

    // ice
    iceConnectionState: "connected",
    iceGatheringState: "complete",
    connectionState: "connected",
    remoteCandidatesAdded: null,
    icePollAttemptsUsed: null,

    // iceProvenance
    stunCount: null,
    turnCount: null,
    source: "unknown",

    // session
    state: "streaming",
    activeKeepalive: "none",
    msSinceLastKeepalive: null,
    lastIdleWarningSecondsUntilKick: null,

    // channels
    channels: [],
    handshakeMs: null,

    // reconnect
    currentAttempt: 0,
    maxAttempts: RECONNECT_MAX_ATTEMPTS,
    lastTriggerReason: null,
    backoffMs: null,

    // tracks
    videoArrivedAt: null,
    audioArrivedAt: null,
    skewMs: null,

    // input
    outboundPacketHz: null,
    lastSequence: null,

    // identity
    consoleName: null,
    consoleType: null,
  };
  return { ...baseline, ...partial };
}
