/**
 * mockSnapshot.ts — A fully-populated DiagnosticsSnapshot for dev/test use.
 *
 * Inject this via the `snapshot` prop on <DiagnosticsHud snapshot={mockSnapshot} />
 * to verify the HUD renders with real-looking data without a live Xbox session.
 */

import type { DiagnosticsSnapshot } from "$lib/connection/types.js";

export const mockSnapshot: DiagnosticsSnapshot = {
  capturedAt: Date.now(),

  // Video
  fps: 60,
  width: 1920,
  height: 1080,
  framesDecoded: 18432,
  framesDropped: 7,
  freezeCount: 2,
  totalFreezesDuration: 0.34,

  // Bitrate
  inboundVideoKbps: 12480,
  availableIncomingBitrate: 18_500_000,

  // Packets
  packetsLost: 3,
  packetsReceived: 14_872,
  lossPct: 0.2,
  jitter: 0.004,
  jitterBufferDelay: 0.018,

  // Recovery
  nackCount: 1,
  pliCount: 0,
  keyframeRequestsSent: 1,
  msSinceLastKeyframe: 3200,

  // Network
  rttMs: 42,
  localCandidateType: "srflx",
  remoteCandidateType: "relay",
  candidatePairState: "succeeded",

  // ICE
  iceConnectionState: "connected",
  iceGatheringState: "complete",
  connectionState: "connected",
  remoteCandidatesAdded: 4,
  icePollAttemptsUsed: 2,

  // ICE provenance
  stunCount: 2,
  turnCount: 4,
  source: "xbox-provided",

  // Session
  state: "streaming",
  activeKeepalive: "api",
  msSinceLastKeepalive: 8200,
  lastIdleWarningSecondsUntilKick: null,

  // Channels
  channels: [
    { label: "chat",    state: "open",   openedAt: Date.now() - 45_000 },
    { label: "control", state: "open",   openedAt: Date.now() - 44_900 },
    { label: "message", state: "open",   openedAt: Date.now() - 44_850 },
    { label: "input",   state: "open",   openedAt: Date.now() - 44_800 },
  ],
  handshakeMs: 312,

  // Reconnect
  currentAttempt: 0,
  maxAttempts: 5,
  lastTriggerReason: null,
  backoffMs: null,

  // Tracks
  videoArrivedAt: Date.now() - 44_500,
  audioArrivedAt: Date.now() - 44_480,
  skewMs: 20,

  // Input
  outboundPacketHz: 59.8,
  lastSequence: 2641,
};
