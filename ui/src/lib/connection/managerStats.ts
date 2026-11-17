/**
 * managerStats.ts — pure diagnostics assembly for ConnectionManager.
 *
 * Extracted verbatim from ConnectionManager._pushManagerStats() (skew calc,
 * per-channel ChannelStats assembly, activeKeepalive precedence, handshakeMs,
 * msSinceLastKeepalive). `now` is an injected parameter — no Date.now() call
 * inside — so the assembly is deterministically unit-testable, mirroring
 * MediaMonitor.tick(framesDecoded, nowMs).
 *
 * This module is STANDALONE — it does NOT import ConnectionManager. It has no
 * side effects and holds no state; ConnectionManager remains the single owner
 * of every timestamp/counter field consumed here.
 *
 * Source of truth for behaviour: ConnectionManager.ts _pushManagerStats
 * (originally app.js-derived; see ConnectionManager.ts module header).
 */

import { RECONNECT_MAX_ATTEMPTS } from "./constants.js";
import type { DataChannelSet } from "./dataChannels.js";
import type { ChannelStats, KeepaliveMode, ManagerStats, SessionState } from "./types.js";

/**
 * Flat snapshot of every field ConnectionManager's _pushManagerStats reads
 * from `this.*` in order to assemble a ManagerStats. Naming mirrors the
 * manager's private fields (minus the leading underscore) so the mapping at
 * each call site is a straight line-for-line read.
 */
export interface ManagerStatsInputs {
  state: SessionState;
  keyframeRequestsSent: number;
  remoteCandidatesAdded: number;
  icePollAttemptsUsed: number;
  iceSource: "xbox-provided" | "fallback-only" | "unknown";
  stunCount: number | null;
  turnCount: number | null;
  /** Whether the API keepalive interval is currently armed (`_apiKeepAliveInterval !== null`). */
  apiKeepAliveActive: boolean;
  /** Whether the idle keepalive interval is currently armed (`_idleKeepaliveInterval !== null`). */
  idleKeepaliveActive: boolean;
  lastKeepaliveAt: number | null;
  lastIdleWarningSecondsUntilKick: number | null;
  channels: DataChannelSet | null;
  channelOpenedAt: Record<string, number | null>;
  firstChannelOpenAt: number | null;
  handshakeAckAt: number | null;
  currentAttempt: number;
  lastTriggerReason: string | null;
  backoffMs: number | null;
  videoArrivedAt: number | null;
  audioArrivedAt: number | null;
  consoleName: string | null;
  consoleType: string | null;
}

/**
 * Assemble the manager-owned ManagerStats fields from a flat input snapshot.
 * Pure function: same inputs + now always produce the same output.
 */
export function buildManagerStats(i: ManagerStatsInputs, now: number): ManagerStats {
  const videoAt = i.videoArrivedAt;
  const audioAt = i.audioArrivedAt;
  const skewMs =
    videoAt !== null && audioAt !== null ? Math.abs(videoAt - audioAt) : null;

  // Per-channel diagnostics
  const channels: ChannelStats[] = [
    "chat",
    "control",
    "message",
    "input",
  ].map((label) => {
    const ch = i.channels?.[label as keyof DataChannelSet];
    return {
      label,
      state: (ch?.readyState ?? "closed") as RTCDataChannelState,
      openedAt: i.channelOpenedAt[label] ?? null,
    };
  });

  const handshakeMs =
    i.firstChannelOpenAt !== null && i.handshakeAckAt !== null
      ? i.handshakeAckAt - i.firstChannelOpenAt
      : null;

  const msSinceLastKeepalive =
    i.lastKeepaliveAt !== null ? now - i.lastKeepaliveAt : null;

  // Active keepalive mode
  let activeKeepalive: KeepaliveMode = "none";
  if (i.apiKeepAliveActive) {
    activeKeepalive = "api";
  } else if (i.idleKeepaliveActive) {
    activeKeepalive = "idle";
  }

  return {
    state: i.state,
    keyframeRequestsSent: i.keyframeRequestsSent,
    remoteCandidatesAdded: i.remoteCandidatesAdded,
    icePollAttemptsUsed: i.icePollAttemptsUsed,
    source: i.iceSource,
    stunCount: i.stunCount,
    turnCount: i.turnCount,
    activeKeepalive,
    msSinceLastKeepalive,
    lastIdleWarningSecondsUntilKick: i.lastIdleWarningSecondsUntilKick,
    channels,
    handshakeMs,
    currentAttempt: i.currentAttempt,
    maxAttempts: RECONNECT_MAX_ATTEMPTS,
    lastTriggerReason: i.lastTriggerReason,
    backoffMs: i.backoffMs,
    videoArrivedAt: videoAt,
    audioArrivedAt: audioAt,
    skewMs,
    // GamepadPoller exposes no public seq/Hz — provide null for now
    outboundPacketHz: null,
    lastSequence: null,
    consoleName: i.consoleName,
    consoleType: i.consoleType,
  };
}
