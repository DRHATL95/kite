/**
 * stats.ts — RTCPeerConnection.getStats() sampler + DiagnosticsSnapshot emitter
 *
 * This module is standalone — it takes only a RTCPeerConnection and a callback.
 * It does NOT import ConnectionManager or any UI code.
 *
 * Design notes
 * ─────────────
 * getStats()-derived fields are computed here; manager-owned fields are
 * modeled as ManagerStats (see types.ts) and merged in by ConnectionManager
 * before the HUD receives the snapshot.
 *
 * Bitrate delta math replicates ui/public/app.js lines 1502-1504:
 *
 *   const bytesDelta = (videoStats.bytesReceived || 0) - lastBytesReceived;
 *   const timeDelta  = (videoStats.timestamp - lastTimestamp) / 1000;  // → seconds
 *   if (timeDelta > 0) kbps = Math.round((bytesDelta * 8) / timeDelta / 1000);
 *
 * The same formula is preserved verbatim in mapStatsReport().
 */

import type {
  DiagnosticsSnapshot,
  ManagerStats,
  CandidateType,
  ConnectionState,
  IceConnectionState,
  IceGatheringState,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Internal state carried between ticks for delta computation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * State persisted between successive getStats() calls so delta values
 * (bitrate, loss %) can be computed.
 */
export interface StatsPrevState {
  /** bytesReceived from the previous inbound-rtp video report. */
  bytesReceived: number;
  /** timestamp from the previous inbound-rtp video report (DOMHighResTimeStamp in ms). */
  timestamp: number;
  /** packetsLost from the previous inbound-rtp video report. */
  packetsLost: number;
  /** packetsReceived from the previous inbound-rtp video report. */
  packetsReceived: number;
  /**
   * Timestamp (performance.now()) when we last saw a new keyframe decoded.
   * Used to compute msSinceLastKeyframe.
   */
  lastKeyframeSampledAt: number | null;
  /** keyFramesDecoded at the time of the last keyframe sample. */
  lastKeyframesDecoded: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default manager stats (all nulls/defaults) — used when manager hasn't merged yet
// ─────────────────────────────────────────────────────────────────────────────

function defaultManagerStats(): ManagerStats {
  return {
    keyframeRequestsSent: null,
    remoteCandidatesAdded: null,
    icePollAttemptsUsed: null,
    source: "unknown",
    stunCount: null,
    turnCount: null,
    state: "idle",
    activeKeepalive: "none",
    msSinceLastKeepalive: null,
    lastIdleWarningSecondsUntilKick: null,
    channels: [],
    handshakeMs: null,
    currentAttempt: 0,
    maxAttempts: 3,
    lastTriggerReason: null,
    backoffMs: null,
    videoArrivedAt: null,
    audioArrivedAt: null,
    skewMs: null,
    outboundPacketHz: null,
    lastSequence: null,
    consoleName: null,
    consoleType: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function toCandidateType(raw: string | undefined): CandidateType {
  if (raw === "host" || raw === "srflx" || raw === "relay" || raw === "prflx") {
    return raw;
  }
  return "unknown";
}

function toConnectionState(raw: string): ConnectionState {
  const allowed: ConnectionState[] = [
    "new", "connecting", "connected", "disconnected", "failed", "closed",
  ];
  return (allowed as string[]).includes(raw)
    ? (raw as ConnectionState)
    : "unknown";
}

function toIceConnectionState(raw: string): IceConnectionState {
  const allowed: IceConnectionState[] = [
    "new", "checking", "connected", "completed", "failed", "disconnected", "closed",
  ];
  return (allowed as string[]).includes(raw)
    ? (raw as IceConnectionState)
    : "unknown";
}

function toIceGatheringState(raw: string): IceGatheringState {
  const allowed: IceGatheringState[] = ["new", "gathering", "complete"];
  return (allowed as string[]).includes(raw)
    ? (raw as IceGatheringState)
    : "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// mapStatsReport — pure, unit-testable mapping function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk a single RTCStatsReport and compute the getStats-derived fields of a
 * DiagnosticsSnapshot.  Manager-owned fields are left at their defaults.
 *
 * @param report  - RTCStatsReport from pc.getStats()
 * @param prev    - State from the previous sample tick (null on the first tick)
 * @param pc      - RTCPeerConnection for reading live connection/ICE states
 * @returns A Partial<DiagnosticsSnapshot> containing only the getStats-derived
 *          fields.  The caller merges ManagerStats on top.
 */
export function mapStatsReport(
  report: RTCStatsReport,
  prev: StatsPrevState | null,
  pc: Pick<
    RTCPeerConnection,
    "connectionState" | "iceConnectionState" | "iceGatheringState"
  >,
): {
  snapshot: Partial<DiagnosticsSnapshot>;
  next: StatsPrevState;
} {
  // Typed buckets for the report entries we care about
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let videoInbound: Record<string, any> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let selectedPair: Record<string, any> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const localCandidates = new Map<string, Record<string, any>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const remoteCandidates = new Map<string, Record<string, any>>();

  report.forEach((stat) => {
    const s = stat as Record<string, unknown>;
    switch (s["type"] as string) {
      case "inbound-rtp":
        if (s["kind"] === "video") videoInbound = s as Record<string, unknown>;
        break;
      case "candidate-pair":
        // Prefer 'succeeded'; fall back to the first 'in-progress' if nothing
        // succeeded yet — mirrors app.js:1490 filtering on state === 'succeeded'
        if (s["state"] === "succeeded") {
          selectedPair = s as Record<string, unknown>;
        } else if (!selectedPair && s["nominated"] === true) {
          selectedPair = s as Record<string, unknown>;
        }
        break;
      case "local-candidate":
        localCandidates.set(s["id"] as string, s as Record<string, unknown>);
        break;
      case "remote-candidate":
        remoteCandidates.set(s["id"] as string, s as Record<string, unknown>);
        break;
    }
  });

  // ── video fields ────────────────────────────────────────────
  const fps: number | null =
    videoInbound != null
      ? ((videoInbound as Record<string, unknown>)["framesPerSecond"] as number) ?? null
      : null;
  const width: number | null =
    videoInbound != null
      ? ((videoInbound as Record<string, unknown>)["frameWidth"] as number) ?? null
      : null;
  const height: number | null =
    videoInbound != null
      ? ((videoInbound as Record<string, unknown>)["frameHeight"] as number) ?? null
      : null;
  const framesDecoded: number | null =
    videoInbound != null
      ? ((videoInbound as Record<string, unknown>)["framesDecoded"] as number) ?? null
      : null;
  const framesDropped: number | null =
    videoInbound != null
      ? ((videoInbound as Record<string, unknown>)["framesDropped"] as number) ?? null
      : null;
  const freezeCount: number | null =
    videoInbound != null
      ? ((videoInbound as Record<string, unknown>)["freezeCount"] as number) ?? null
      : null;
  const totalFreezesDuration: number | null =
    videoInbound != null
      ? ((videoInbound as Record<string, unknown>)["totalFreezesDuration"] as number) ?? null
      : null;

  // ── bitrate delta — replicates app.js lines 1502-1504 ──────
  // app.js:1502  const bytesDelta = (videoStats.bytesReceived || 0) - lastBytesReceived;
  // app.js:1503  const timeDelta  = (videoStats.timestamp - lastTimestamp) / 1000;
  // app.js:1504  if (timeDelta > 0) bitrateEl.textContent = Math.round((bytesDelta * 8) / timeDelta / 1000) + ' kbps';
  let inboundVideoKbps: number | null = null;
  const curBytes: number =
    videoInbound != null
      ? (((videoInbound as Record<string, unknown>)["bytesReceived"] as number) || 0)
      : 0;
  const curTimestamp: number =
    videoInbound != null
      ? ((videoInbound as Record<string, unknown>)["timestamp"] as number) || 0
      : 0;

  if (prev != null && prev.timestamp > 0 && curTimestamp > 0 && videoInbound != null) {
    const bytesDelta = curBytes - prev.bytesReceived;
    const timeDelta = (curTimestamp - prev.timestamp) / 1000; // seconds
    if (timeDelta > 0) {
      inboundVideoKbps = Math.round((bytesDelta * 8) / timeDelta / 1000);
    }
  }

  // ── packets / loss ──────────────────────────────────────────
  const packetsLost: number | null =
    videoInbound != null
      ? ((videoInbound as Record<string, unknown>)["packetsLost"] as number) ?? null
      : null;
  const packetsReceived: number | null =
    videoInbound != null
      ? ((videoInbound as Record<string, unknown>)["packetsReceived"] as number) ?? null
      : null;

  let lossPct: number | null = null;
  if (packetsLost != null && packetsReceived != null) {
    const total = packetsLost + packetsReceived;
    lossPct = total > 0 ? Math.round((packetsLost / total) * 100 * 10) / 10 : 0;
  }

  const jitter: number | null =
    videoInbound != null
      ? ((videoInbound as Record<string, unknown>)["jitter"] as number) ?? null
      : null;
  const jitterBufferDelay: number | null =
    videoInbound != null
      ? ((videoInbound as Record<string, unknown>)["jitterBufferDelay"] as number) ?? null
      : null;

  // ── recovery ────────────────────────────────────────────────
  const nackCount: number | null =
    videoInbound != null
      ? ((videoInbound as Record<string, unknown>)["nackCount"] as number) ?? null
      : null;
  const pliCount: number | null =
    videoInbound != null
      ? ((videoInbound as Record<string, unknown>)["pliCount"] as number) ?? null
      : null;

  // keyframe staleness — track when the keyFramesDecoded counter last advanced
  const curKeyframes: number | null =
    videoInbound != null
      ? ((videoInbound as Record<string, unknown>)["keyFramesDecoded"] as number) ?? null
      : null;

  let msSinceLastKeyframe: number | null = null;
  let lastKeyframeSampledAt: number | null = prev?.lastKeyframeSampledAt ?? null;
  let lastKeyframesDecoded: number | null = prev?.lastKeyframesDecoded ?? null;

  if (curKeyframes != null) {
    const now = Date.now();
    if (
      lastKeyframesDecoded === null ||
      curKeyframes > lastKeyframesDecoded
    ) {
      // A new keyframe arrived — reset the staleness clock
      lastKeyframeSampledAt = now;
      lastKeyframesDecoded = curKeyframes;
    }
    if (lastKeyframeSampledAt != null) {
      msSinceLastKeyframe = now - lastKeyframeSampledAt;
    }
  }

  // ── network / candidate-pair ────────────────────────────────
  const rttMs: number | null =
    selectedPair != null
      ? (selectedPair as Record<string, unknown>)["currentRoundTripTime"] != null
        ? Math.round(
            ((selectedPair as Record<string, unknown>)["currentRoundTripTime"] as number) * 1000,
          )
        : null
      : null;

  const availableIncomingBitrate: number | null =
    selectedPair != null
      ? ((selectedPair as Record<string, unknown>)["availableIncomingBitrate"] as number) ?? null
      : null;

  const candidatePairState: string | null =
    selectedPair != null
      ? ((selectedPair as Record<string, unknown>)["state"] as string) ?? null
      : null;

  let localCandidateType: CandidateType | null = null;
  let remoteCandidateType: CandidateType | null = null;

  if (selectedPair != null) {
    const localId = (selectedPair as Record<string, unknown>)["localCandidateId"] as
      | string
      | undefined;
    const remoteId = (selectedPair as Record<string, unknown>)["remoteCandidateId"] as
      | string
      | undefined;

    if (localId) {
      const lc = localCandidates.get(localId);
      if (lc) {
        localCandidateType = toCandidateType(
          (lc as Record<string, unknown>)["candidateType"] as string | undefined,
        );
      }
    }
    if (remoteId) {
      const rc = remoteCandidates.get(remoteId);
      if (rc) {
        remoteCandidateType = toCandidateType(
          (rc as Record<string, unknown>)["candidateType"] as string | undefined,
        );
      }
    }
  }

  // ── ICE / connection states from the live PC ─────────────────
  const iceConnectionState = toIceConnectionState(pc.iceConnectionState);
  const iceGatheringState = toIceGatheringState(pc.iceGatheringState);
  const connectionState = toConnectionState(pc.connectionState);

  // ── Build next prev-state ────────────────────────────────────
  const next: StatsPrevState = {
    bytesReceived: curBytes,
    timestamp: curTimestamp,
    packetsLost: packetsLost ?? (prev?.packetsLost ?? 0),
    packetsReceived: packetsReceived ?? (prev?.packetsReceived ?? 0),
    lastKeyframeSampledAt,
    lastKeyframesDecoded,
  };

  // ── Assemble partial snapshot ────────────────────────────────
  const snapshot: Partial<DiagnosticsSnapshot> = {
    capturedAt: Date.now(),

    // video
    fps,
    width,
    height,
    framesDecoded,
    framesDropped,
    freezeCount,
    totalFreezesDuration,

    // bitrate
    inboundVideoKbps,
    availableIncomingBitrate,

    // packets
    packetsLost,
    packetsReceived,
    lossPct,
    jitter,
    jitterBufferDelay,

    // recovery
    nackCount,
    pliCount,
    msSinceLastKeyframe,

    // network
    rttMs,
    localCandidateType,
    remoteCandidateType,
    candidatePairState,

    // ice
    iceConnectionState,
    iceGatheringState,
    connectionState,
  };

  return { snapshot, next };
}

// ─────────────────────────────────────────────────────────────────────────────
// StatsSampler class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * StatsSampler — polls RTCPeerConnection.getStats() on a fixed interval and
 * emits a DiagnosticsSnapshot via a callback on each tick.
 *
 * Manager-owned fields are supplied via setManagerStats() and merged into every
 * snapshot before the callback is invoked.
 *
 * @example
 * ```ts
 * const sampler = new StatsSampler(pc, (snap) => hud.update(snap));
 * sampler.start();
 * // Later, merge in manager-owned fields:
 * sampler.setManagerStats({ state: 'streaming', ... });
 * // On disconnect:
 * sampler.stop();
 * ```
 */
export class StatsSampler {
  private readonly pc: RTCPeerConnection;
  private readonly onSnapshot: (snap: DiagnosticsSnapshot) => void;
  private readonly intervalMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private prev: StatsPrevState | null = null;
  private managerStats: ManagerStats;

  constructor(
    pc: RTCPeerConnection,
    onSnapshot: (snap: DiagnosticsSnapshot) => void,
    intervalMs = 2000,
  ) {
    this.pc = pc;
    this.onSnapshot = onSnapshot;
    this.intervalMs = intervalMs;
    this.managerStats = defaultManagerStats();
  }

  /**
   * Start periodic sampling.  Idempotent — calling start() while already
   * running is a no-op.
   */
  start(): void {
    if (this.timer != null) return;
    this.timer = setInterval(() => void this._tick(), this.intervalMs);
  }

  /**
   * Stop periodic sampling and reset internal state.
   */
  stop(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.prev = null;
  }

  /**
   * Merge manager-owned fields into subsequent snapshots.
   * ConnectionManager calls this whenever its state changes.
   */
  setManagerStats(stats: Partial<ManagerStats>): void {
    this.managerStats = { ...this.managerStats, ...stats };
  }

  private async _tick(): Promise<void> {
    if (this.pc.connectionState === "closed") {
      this.stop();
      return;
    }

    let report: RTCStatsReport;
    try {
      report = await this.pc.getStats();
    } catch {
      // pc may have been closed between the check and the await
      return;
    }

    const { snapshot: partial, next } = mapStatsReport(report, this.prev, this.pc);
    this.prev = next;

    // Merge manager-owned fields on top of the getStats-derived partial.
    const full: DiagnosticsSnapshot = {
      // getStats-derived defaults (non-nullable fields need a value)
      capturedAt: Date.now(),
      fps: null,
      width: null,
      height: null,
      framesDecoded: null,
      framesDropped: null,
      freezeCount: null,
      totalFreezesDuration: null,
      inboundVideoKbps: null,
      availableIncomingBitrate: null,
      packetsLost: null,
      packetsReceived: null,
      lossPct: null,
      jitter: null,
      jitterBufferDelay: null,
      nackCount: null,
      pliCount: null,
      msSinceLastKeyframe: null,
      rttMs: null,
      localCandidateType: null,
      remoteCandidateType: null,
      candidatePairState: null,
      iceConnectionState: "unknown",
      iceGatheringState: "unknown",
      connectionState: "unknown",

      // spread getStats-derived values (overwrite defaults)
      ...partial,

      // manager-owned fields (always present)
      ...this.managerStats,
    };

    this.onSnapshot(full);
  }
}
