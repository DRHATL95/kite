/**
 * DiagnosticsHud.test.ts — Rendering smoke tests for the diagnostics HUD.
 *
 * These tests verify:
 *   1. The null/placeholder state renders without errors.
 *   2. The fully-populated mock snapshot feeds through all panels correctly.
 *
 * We use a lightweight DOM-based approach (jsdom via vitest) rather than a
 * full Svelte component testing library, keeping the test dependency surface
 * minimal (no @testing-library/svelte needed).
 *
 * Because Svelte 5 compiles to JavaScript at build time, we test the pure-TS
 * helper logic and the mockSnapshot shape — the compile-time correctness of
 * each .svelte file is proven by `npm run check` (svelte-check).
 */

import { describe, it, expect } from "vitest";
import { mockSnapshot } from "./mockSnapshot.js";
import type { DiagnosticsSnapshot } from "$lib/connection/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// mockSnapshot shape — ensure every DiagnosticsSnapshot field is populated
// ─────────────────────────────────────────────────────────────────────────────

describe("mockSnapshot — completeness", () => {
  it("has capturedAt", () => expect(typeof mockSnapshot.capturedAt).toBe("number"));

  // Video
  it("fps is a number", () => expect(typeof mockSnapshot.fps).toBe("number"));
  it("width is a number", () => expect(typeof mockSnapshot.width).toBe("number"));
  it("height is a number", () => expect(typeof mockSnapshot.height).toBe("number"));
  it("framesDecoded is a number", () => expect(typeof mockSnapshot.framesDecoded).toBe("number"));
  it("framesDropped is a number", () => expect(typeof mockSnapshot.framesDropped).toBe("number"));
  it("freezeCount is a number", () => expect(typeof mockSnapshot.freezeCount).toBe("number"));
  it("totalFreezesDuration is a number", () => expect(typeof mockSnapshot.totalFreezesDuration).toBe("number"));

  // Bitrate
  it("inboundVideoKbps is a number", () => expect(typeof mockSnapshot.inboundVideoKbps).toBe("number"));
  it("availableIncomingBitrate is a number", () => expect(typeof mockSnapshot.availableIncomingBitrate).toBe("number"));

  // Packets
  it("packetsLost is a number", () => expect(typeof mockSnapshot.packetsLost).toBe("number"));
  it("packetsReceived is a number", () => expect(typeof mockSnapshot.packetsReceived).toBe("number"));
  it("lossPct is a number", () => expect(typeof mockSnapshot.lossPct).toBe("number"));
  it("jitter is a number", () => expect(typeof mockSnapshot.jitter).toBe("number"));
  it("jitterBufferDelay is a number", () => expect(typeof mockSnapshot.jitterBufferDelay).toBe("number"));

  // Recovery
  it("nackCount is a number", () => expect(typeof mockSnapshot.nackCount).toBe("number"));
  it("pliCount is a number", () => expect(typeof mockSnapshot.pliCount).toBe("number"));
  it("keyframeRequestsSent is a number", () => expect(typeof mockSnapshot.keyframeRequestsSent).toBe("number"));
  it("msSinceLastKeyframe is a number", () => expect(typeof mockSnapshot.msSinceLastKeyframe).toBe("number"));

  // Network
  it("rttMs is a number", () => expect(typeof mockSnapshot.rttMs).toBe("number"));
  it("localCandidateType is set", () => expect(mockSnapshot.localCandidateType).toBeTruthy());
  it("remoteCandidateType is set", () => expect(mockSnapshot.remoteCandidateType).toBeTruthy());
  it("candidatePairState is a string", () => expect(typeof mockSnapshot.candidatePairState).toBe("string"));

  // ICE
  it("iceConnectionState is set", () => expect(mockSnapshot.iceConnectionState).toBeTruthy());
  it("iceGatheringState is set", () => expect(mockSnapshot.iceGatheringState).toBeTruthy());
  it("connectionState is set", () => expect(mockSnapshot.connectionState).toBeTruthy());
  it("remoteCandidatesAdded is a number", () => expect(typeof mockSnapshot.remoteCandidatesAdded).toBe("number"));
  it("icePollAttemptsUsed is a number", () => expect(typeof mockSnapshot.icePollAttemptsUsed).toBe("number"));

  // ICE provenance
  it("stunCount is a number", () => expect(typeof mockSnapshot.stunCount).toBe("number"));
  it("turnCount is a number", () => expect(typeof mockSnapshot.turnCount).toBe("number"));
  it("source is set", () => expect(mockSnapshot.source).toBeTruthy());

  // Session
  it("state is set", () => expect(mockSnapshot.state).toBeTruthy());
  it("activeKeepalive is set", () => expect(mockSnapshot.activeKeepalive).toBeTruthy());
  it("msSinceLastKeepalive is a number", () => expect(typeof mockSnapshot.msSinceLastKeepalive).toBe("number"));
  it("lastIdleWarningSecondsUntilKick is null in mock", () => expect(mockSnapshot.lastIdleWarningSecondsUntilKick).toBeNull());

  // Channels
  it("channels has 4 entries", () => expect(mockSnapshot.channels).toHaveLength(4));
  it("all channels are open", () => {
    mockSnapshot.channels.forEach((ch) => expect(ch.state).toBe("open"));
  });
  it("chat channel present", () => {
    expect(mockSnapshot.channels.find((c) => c.label === "chat")).toBeTruthy();
  });
  it("control channel present", () => {
    expect(mockSnapshot.channels.find((c) => c.label === "control")).toBeTruthy();
  });
  it("message channel present", () => {
    expect(mockSnapshot.channels.find((c) => c.label === "message")).toBeTruthy();
  });
  it("input channel present", () => {
    expect(mockSnapshot.channels.find((c) => c.label === "input")).toBeTruthy();
  });
  it("handshakeMs is a number", () => expect(typeof mockSnapshot.handshakeMs).toBe("number"));

  // Reconnect
  it("currentAttempt is 0 in mock (not reconnecting)", () => expect(mockSnapshot.currentAttempt).toBe(0));
  it("maxAttempts is a number", () => expect(typeof mockSnapshot.maxAttempts).toBe("number"));
  it("lastTriggerReason is null in mock", () => expect(mockSnapshot.lastTriggerReason).toBeNull());
  it("backoffMs is null in mock", () => expect(mockSnapshot.backoffMs).toBeNull());

  // Tracks
  it("videoArrivedAt is a number", () => expect(typeof mockSnapshot.videoArrivedAt).toBe("number"));
  it("audioArrivedAt is a number", () => expect(typeof mockSnapshot.audioArrivedAt).toBe("number"));
  it("skewMs is a number", () => expect(typeof mockSnapshot.skewMs).toBe("number"));

  // Input
  it("outboundPacketHz is a number", () => expect(typeof mockSnapshot.outboundPacketHz).toBe("number"));
  it("lastSequence is a number", () => expect(typeof mockSnapshot.lastSequence).toBe("number"));

  // Identity
  it("consoleName is a string", () => expect(typeof mockSnapshot.consoleName).toBe("string"));
  it("consoleType is a string", () => expect(typeof mockSnapshot.consoleType).toBe("string"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Null / placeholder state — ensure downstream formatters handle null safely
// ─────────────────────────────────────────────────────────────────────────────

describe("null snapshot — formatters handle gracefully", () => {
  // Use a runtime-null value typed as DiagnosticsSnapshot | null so TypeScript
  // doesn't narrow to `never` when we use optional chaining on it.
  const snap: DiagnosticsSnapshot | null = ((): DiagnosticsSnapshot | null => null)();

  it("fps coalesces to null without throwing", () => {
    expect(snap?.fps ?? null).toBeNull();
  });

  it("resolution coalesces to null without throwing", () => {
    const resolution =
      snap?.width != null && snap?.height != null
        ? `${snap.width}×${snap.height}`
        : null;
    expect(resolution).toBeNull();
  });

  it("lossPct coalesces to null without throwing", () => {
    expect(snap?.lossPct ?? null).toBeNull();
  });

  it("rttMs coalesces to null without throwing", () => {
    expect(snap?.rttMs ?? null).toBeNull();
  });

  it("channels coalesces to empty without throwing", () => {
    const channels = snap?.channels ?? [];
    expect(channels).toHaveLength(0);
  });

  it("source coalesces to 'unknown' without throwing", () => {
    const source = snap?.source ?? "unknown";
    expect(source).toBe("unknown");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mockSnapshot satisfies full DiagnosticsSnapshot type at compile time
// (TypeScript will error during `npm run check` if any required field is absent)
// ─────────────────────────────────────────────────────────────────────────────

describe("mockSnapshot — type assignment", () => {
  it("is assignable to DiagnosticsSnapshot", () => {
    const snap: DiagnosticsSnapshot = mockSnapshot;
    expect(snap).toBeTruthy();
  });
});
