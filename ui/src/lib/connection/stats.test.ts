/**
 * stats.test.ts — Unit tests for the getStats() diagnostics sampler.
 *
 * Tests focus on mapStatsReport() since it is the pure, unit-testable core.
 * A fake RTCStatsReport (a Map of stat objects) is built for each test scenario.
 *
 * Bitrate delta math verified against ui/public/app.js lines 1502-1504:
 *   bytesDelta = bytesReceived - prevBytesReceived
 *   timeDelta  = (timestamp - prevTimestamp) / 1000   [seconds]
 *   kbps       = Math.round((bytesDelta * 8) / timeDelta / 1000)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mapStatsReport, StatsSampler } from "./stats.js";
import type { StatsPrevState } from "./stats.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fake RTCStatsReport helpers
// ─────────────────────────────────────────────────────────────────────────────

type FakeStat = Record<string, unknown>;

/** Build a Map that satisfies the RTCStatsReport interface (iterable). */
function makeReport(entries: FakeStat[]): RTCStatsReport {
  const map = new Map<string, FakeStat>();
  for (const e of entries) {
    map.set(e["id"] as string, e);
  }
  // RTCStatsReport.forEach iterates values
  const report = {
    forEach: (cb: (value: FakeStat) => void) => map.forEach(cb),
    // Satisfy any Map-like usage in the code under test
    get: (id: string) => map.get(id),
    has: (id: string) => map.has(id),
    size: map.size,
    [Symbol.iterator]: map[Symbol.iterator].bind(map),
  } as unknown as RTCStatsReport;
  return report;
}

/** A fake RTCPeerConnection with controllable state. */
function makeFakePc(
  opts: Partial<{
    connectionState: RTCPeerConnectionState;
    iceConnectionState: RTCIceConnectionState;
    iceGatheringState: RTCIceGatheringState;
  }> = {},
): Pick<RTCPeerConnection, "connectionState" | "iceConnectionState" | "iceGatheringState"> {
  return {
    connectionState: opts.connectionState ?? "connected",
    iceConnectionState: opts.iceConnectionState ?? "connected",
    iceGatheringState: opts.iceGatheringState ?? "complete",
  };
}

/** Minimal inbound-rtp video stat entry. */
function makeVideoStat(overrides: Partial<FakeStat> = {}): FakeStat {
  return {
    id: "inbound-video-1",
    type: "inbound-rtp",
    kind: "video",
    framesPerSecond: 60,
    frameWidth: 1920,
    frameHeight: 1080,
    framesDecoded: 1000,
    framesDropped: 5,
    freezeCount: 0,
    totalFreezesDuration: 0,
    bytesReceived: 500_000,
    timestamp: 10_000,
    packetsLost: 2,
    packetsReceived: 998,
    jitter: 0.005,
    jitterBufferDelay: 0.02,
    nackCount: 1,
    pliCount: 0,
    keyFramesDecoded: 10,
    ...overrides,
  };
}

/** Minimal candidate-pair stat entry. */
function makeCandidatePairStat(overrides: Partial<FakeStat> = {}): FakeStat {
  return {
    id: "pair-1",
    type: "candidate-pair",
    state: "succeeded",
    nominated: true,
    currentRoundTripTime: 0.025, // 25 ms
    availableIncomingBitrate: 5_000_000,
    localCandidateId: "local-1",
    remoteCandidateId: "remote-1",
    ...overrides,
  };
}

/** Local candidate stat entry. */
function makeLocalCandidate(overrides: Partial<FakeStat> = {}): FakeStat {
  return {
    id: "local-1",
    type: "local-candidate",
    candidateType: "host",
    ...overrides,
  };
}

/** Remote candidate stat entry. */
function makeRemoteCandidate(overrides: Partial<FakeStat> = {}): FakeStat {
  return {
    id: "remote-1",
    type: "remote-candidate",
    candidateType: "srflx",
    ...overrides,
  };
}

/** Full fake report with video + candidate-pair + local + remote candidates. */
function makeFullReport(
  videoOverrides: Partial<FakeStat> = {},
  pairOverrides: Partial<FakeStat> = {},
  localOverrides: Partial<FakeStat> = {},
  remoteOverrides: Partial<FakeStat> = {},
): RTCStatsReport {
  return makeReport([
    makeVideoStat(videoOverrides),
    makeCandidatePairStat(pairOverrides),
    makeLocalCandidate(localOverrides),
    makeRemoteCandidate(remoteOverrides),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// mapStatsReport — video fields
// ─────────────────────────────────────────────────────────────────────────────

describe("mapStatsReport — video fields", () => {
  const report = makeFullReport();
  const pc = makeFakePc();
  const { snapshot } = mapStatsReport(report, null, pc);

  it("fps from framesPerSecond", () => {
    expect(snapshot.fps).toBe(60);
  });

  it("width from frameWidth", () => {
    expect(snapshot.width).toBe(1920);
  });

  it("height from frameHeight", () => {
    expect(snapshot.height).toBe(1080);
  });

  it("framesDecoded", () => {
    expect(snapshot.framesDecoded).toBe(1000);
  });

  it("framesDropped", () => {
    expect(snapshot.framesDropped).toBe(5);
  });

  it("freezeCount", () => {
    expect(snapshot.freezeCount).toBe(0);
  });

  it("totalFreezesDuration", () => {
    expect(snapshot.totalFreezesDuration).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mapStatsReport — bitrate delta (core math matches app.js lines 1502-1504)
// ─────────────────────────────────────────────────────────────────────────────

describe("mapStatsReport — bitrate delta math (mirrors app.js lines 1502-1504)", () => {
  it("returns null on the first tick (no prev state)", () => {
    const report = makeFullReport({ bytesReceived: 500_000, timestamp: 10_000 });
    const pc = makeFakePc();
    const { snapshot } = mapStatsReport(report, null, pc);
    expect(snapshot.inboundVideoKbps).toBeNull();
  });

  it("computes correct kbps on the second tick", () => {
    // Tick 1 — establishes prev state
    const pc = makeFakePc();
    const report1 = makeFullReport({ bytesReceived: 500_000, timestamp: 10_000 });
    const { next: prev1 } = mapStatsReport(report1, null, pc);

    // Tick 2 — 200 000 bytes over 2 seconds = 800 kbps
    //   bytesDelta = 700_000 - 500_000 = 200_000
    //   timeDelta  = (12_000 - 10_000) / 1000 = 2 s
    //   kbps       = Math.round((200_000 * 8) / 2 / 1000) = 800
    const report2 = makeFullReport({ bytesReceived: 700_000, timestamp: 12_000 });
    const { snapshot } = mapStatsReport(report2, prev1, pc);
    expect(snapshot.inboundVideoKbps).toBe(800);
  });

  it("returns null when timeDelta is 0 (same timestamp)", () => {
    const pc = makeFakePc();
    const prev: StatsPrevState = {
      bytesReceived: 500_000,
      timestamp: 10_000,
      packetsLost: 0,
      packetsReceived: 0,
      lastKeyframeSampledAt: null,
      lastKeyframesDecoded: null,
    };
    const report = makeFullReport({ bytesReceived: 600_000, timestamp: 10_000 }); // same timestamp
    const { snapshot } = mapStatsReport(report, prev, pc);
    expect(snapshot.inboundVideoKbps).toBeNull();
  });

  it("advances prev.bytesReceived and prev.timestamp for next tick", () => {
    const pc = makeFakePc();
    const report = makeFullReport({ bytesReceived: 999_000, timestamp: 30_000 });
    const { next } = mapStatsReport(report, null, pc);
    expect(next.bytesReceived).toBe(999_000);
    expect(next.timestamp).toBe(30_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mapStatsReport — packet loss percentage
// ─────────────────────────────────────────────────────────────────────────────

describe("mapStatsReport — lossPct", () => {
  const pc = makeFakePc();

  it("lossPct = 0 when no packets are lost", () => {
    const report = makeFullReport({ packetsLost: 0, packetsReceived: 1000 });
    const { snapshot } = mapStatsReport(report, null, pc);
    expect(snapshot.lossPct).toBe(0);
  });

  it("computes loss percentage correctly", () => {
    // 10 lost / 1010 total = ~0.99%
    const report = makeFullReport({ packetsLost: 10, packetsReceived: 1000 });
    const { snapshot } = mapStatsReport(report, null, pc);
    // Math.round((10 / 1010) * 100 * 10) / 10 ≈ 1.0
    expect(snapshot.lossPct).toBeCloseTo(1.0, 0);
  });

  it("100% loss when all packets are lost", () => {
    const report = makeFullReport({ packetsLost: 100, packetsReceived: 0 });
    const { snapshot } = mapStatsReport(report, null, pc);
    expect(snapshot.lossPct).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mapStatsReport — rttMs
// ─────────────────────────────────────────────────────────────────────────────

describe("mapStatsReport — rttMs", () => {
  const pc = makeFakePc();

  it("rttMs = 25 when currentRoundTripTime = 0.025", () => {
    const report = makeFullReport({}, { currentRoundTripTime: 0.025 });
    const { snapshot } = mapStatsReport(report, null, pc);
    expect(snapshot.rttMs).toBe(25);
  });

  it("rttMs = null when no candidate-pair", () => {
    const report = makeReport([makeVideoStat()]);
    const { snapshot } = mapStatsReport(report, null, pc);
    expect(snapshot.rttMs).toBeNull();
  });

  it("rttMs rounds to nearest ms", () => {
    const report = makeFullReport({}, { currentRoundTripTime: 0.0125 }); // 12.5 ms → 13
    const { snapshot } = mapStatsReport(report, null, pc);
    expect(snapshot.rttMs).toBe(13);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mapStatsReport — candidate types
// ─────────────────────────────────────────────────────────────────────────────

describe("mapStatsReport — candidate types", () => {
  const pc = makeFakePc();

  it("localCandidateType from local-candidate entry", () => {
    const report = makeFullReport({}, {}, { candidateType: "host" }, { candidateType: "srflx" });
    const { snapshot } = mapStatsReport(report, null, pc);
    expect(snapshot.localCandidateType).toBe("host");
  });

  it("remoteCandidateType from remote-candidate entry", () => {
    const report = makeFullReport({}, {}, { candidateType: "host" }, { candidateType: "relay" });
    const { snapshot } = mapStatsReport(report, null, pc);
    expect(snapshot.remoteCandidateType).toBe("relay");
  });

  it("srflx is preserved as-is", () => {
    const report = makeFullReport({}, {}, { candidateType: "srflx" }, { candidateType: "host" });
    const { snapshot } = mapStatsReport(report, null, pc);
    expect(snapshot.localCandidateType).toBe("srflx");
  });

  it("unknown string maps to 'unknown'", () => {
    const report = makeFullReport({}, {}, { candidateType: "bogus" }, { candidateType: "host" });
    const { snapshot } = mapStatsReport(report, null, pc);
    expect(snapshot.localCandidateType).toBe("unknown");
  });

  it("both null when no candidate-pair", () => {
    const report = makeReport([makeVideoStat()]);
    const { snapshot } = mapStatsReport(report, null, pc);
    expect(snapshot.localCandidateType).toBeNull();
    expect(snapshot.remoteCandidateType).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mapStatsReport — ICE / connection states from the PC
// ─────────────────────────────────────────────────────────────────────────────

describe("mapStatsReport — connection states", () => {
  it("iceConnectionState reflects pc.iceConnectionState", () => {
    const report = makeReport([]);
    const pc = makeFakePc({ iceConnectionState: "checking" });
    const { snapshot } = mapStatsReport(report, null, pc);
    expect(snapshot.iceConnectionState).toBe("checking");
  });

  it("iceGatheringState reflects pc.iceGatheringState", () => {
    const report = makeReport([]);
    const pc = makeFakePc({ iceGatheringState: "gathering" });
    const { snapshot } = mapStatsReport(report, null, pc);
    expect(snapshot.iceGatheringState).toBe("gathering");
  });

  it("connectionState reflects pc.connectionState", () => {
    const report = makeReport([]);
    const pc = makeFakePc({ connectionState: "disconnected" });
    const { snapshot } = mapStatsReport(report, null, pc);
    expect(snapshot.connectionState).toBe("disconnected");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mapStatsReport — empty report
// ─────────────────────────────────────────────────────────────────────────────

describe("mapStatsReport — empty report", () => {
  const report = makeReport([]);
  const pc = makeFakePc();
  const { snapshot } = mapStatsReport(report, null, pc);

  it("fps is null", () => expect(snapshot.fps).toBeNull());
  it("rttMs is null", () => expect(snapshot.rttMs).toBeNull());
  it("inboundVideoKbps is null", () => expect(snapshot.inboundVideoKbps).toBeNull());
  it("lossPct is null", () => expect(snapshot.lossPct).toBeNull());
  it("connectionState is still filled from pc", () => {
    expect(snapshot.connectionState).toBe("connected");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mapStatsReport — availableIncomingBitrate
// ─────────────────────────────────────────────────────────────────────────────

describe("mapStatsReport — availableIncomingBitrate", () => {
  it("reads from candidate-pair", () => {
    const pc = makeFakePc();
    const report = makeFullReport({}, { availableIncomingBitrate: 8_000_000 });
    const { snapshot } = mapStatsReport(report, null, pc);
    expect(snapshot.availableIncomingBitrate).toBe(8_000_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mapStatsReport — jitter + jitterBufferDelay
// ─────────────────────────────────────────────────────────────────────────────

describe("mapStatsReport — jitter fields", () => {
  const pc = makeFakePc();
  const report = makeFullReport({ jitter: 0.012, jitterBufferDelay: 0.050 });
  const { snapshot } = mapStatsReport(report, null, pc);

  it("jitter is read from inbound-rtp", () => {
    expect(snapshot.jitter).toBeCloseTo(0.012, 5);
  });

  it("jitterBufferDelay is read from inbound-rtp", () => {
    expect(snapshot.jitterBufferDelay).toBeCloseTo(0.050, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mapStatsReport — nackCount / pliCount
// ─────────────────────────────────────────────────────────────────────────────

describe("mapStatsReport — recovery counts", () => {
  const pc = makeFakePc();
  const report = makeFullReport({ nackCount: 3, pliCount: 1 });
  const { snapshot } = mapStatsReport(report, null, pc);

  it("nackCount is read from inbound-rtp", () => {
    expect(snapshot.nackCount).toBe(3);
  });

  it("pliCount is read from inbound-rtp", () => {
    expect(snapshot.pliCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// StatsSampler — class lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe("StatsSampler — lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not call onSnapshot before start()", () => {
    vi.useFakeTimers();
    const snapshots: unknown[] = [];
    const fakeReport = makeReport([]);
    const fakePc = {
      ...makeFakePc(),
      getStats: vi.fn().mockResolvedValue(fakeReport),
    } as unknown as RTCPeerConnection;

    new StatsSampler(fakePc, (s) => snapshots.push(s), 100);
    vi.advanceTimersByTime(500);
    expect(snapshots).toHaveLength(0);
  });

  it("calls onSnapshot after start() + interval elapses", async () => {
    vi.useFakeTimers();
    const snapshots: unknown[] = [];
    const fakeReport = makeReport([]);
    const fakePc = {
      ...makeFakePc(),
      getStats: vi.fn().mockResolvedValue(fakeReport),
    } as unknown as RTCPeerConnection;

    const sampler = new StatsSampler(fakePc, (s) => snapshots.push(s), 100);
    sampler.start();
    // Advance time 3 intervals; each tick is async so flush microtasks too
    await vi.advanceTimersByTimeAsync(350);
    sampler.stop();
    expect(snapshots.length).toBeGreaterThan(0);
  });

  it("stop() prevents further snapshots", async () => {
    vi.useFakeTimers();
    const snapshots: unknown[] = [];
    const fakeReport = makeReport([]);
    const fakePc = {
      ...makeFakePc(),
      getStats: vi.fn().mockResolvedValue(fakeReport),
    } as unknown as RTCPeerConnection;

    const sampler = new StatsSampler(fakePc, (s) => snapshots.push(s), 100);
    sampler.start();
    await vi.advanceTimersByTimeAsync(250);
    const countAfterStart = snapshots.length;
    sampler.stop();
    // Advance again — no new snapshots expected
    await vi.advanceTimersByTimeAsync(250);
    expect(snapshots.length).toBe(countAfterStart);
  });

  it("setManagerStats() merges into subsequent snapshots", async () => {
    vi.useFakeTimers();
    const snapshots: ReturnType<typeof Object.assign>[] = [];
    const fakeReport = makeReport([]);
    const fakePc = {
      ...makeFakePc(),
      getStats: vi.fn().mockResolvedValue(fakeReport),
    } as unknown as RTCPeerConnection;

    const sampler = new StatsSampler(fakePc, (s) => snapshots.push(s), 100);
    sampler.setManagerStats({ state: "streaming", currentAttempt: 1 });
    sampler.start();
    await vi.advanceTimersByTimeAsync(250);
    sampler.stop();

    expect(snapshots.length).toBeGreaterThan(0);
    const last = snapshots[snapshots.length - 1];
    expect(last.state).toBe("streaming");
    expect(last.currentAttempt).toBe(1);
  });
});
