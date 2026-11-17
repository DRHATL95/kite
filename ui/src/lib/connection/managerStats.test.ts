/**
 * managerStats.test.ts — golden-output tests for buildManagerStats().
 *
 * These pin the exact assembly logic moved verbatim out of
 * ConnectionManager._pushManagerStats() (see managerStats.ts header for the
 * line-reference provenance). Every expected value below is derived by
 * reading that method, NOT by running the new code and copying its output —
 * this is the behavior contract, not a change-detector.
 */

import { describe, it, expect } from "vitest";
import { buildManagerStats, type ManagerStatsInputs } from "./managerStats.js";
import { RECONNECT_MAX_ATTEMPTS } from "./constants.js";
import type { DataChannelSet } from "./dataChannels.js";

const FIXED_NOW = 1_700_000_000_000;

/** A fully-populated baseline input; individual tests override fields. */
function baseInputs(overrides: Partial<ManagerStatsInputs> = {}): ManagerStatsInputs {
  return {
    state: "streaming",
    keyframeRequestsSent: 2,
    remoteCandidatesAdded: 5,
    icePollAttemptsUsed: 3,
    iceSource: "xbox-provided",
    stunCount: 2,
    turnCount: 1,
    apiKeepAliveActive: true,
    idleKeepaliveActive: false,
    lastKeepaliveAt: FIXED_NOW - 4_000,
    lastIdleWarningSecondsUntilKick: null,
    channels: null,
    channelOpenedAt: { chat: null, control: null, message: null, input: null },
    firstChannelOpenAt: null,
    handshakeAckAt: null,
    currentAttempt: 0,
    lastTriggerReason: null,
    backoffMs: null,
    videoArrivedAt: null,
    audioArrivedAt: null,
    consoleName: "Living Room Xbox",
    consoleType: "Scarlett",
    ...overrides,
  };
}

/** Minimal fake RTCDataChannel — only `readyState` is read by buildManagerStats. */
function fakeChannel(readyState: RTCDataChannelState): RTCDataChannel {
  return { readyState } as unknown as RTCDataChannel;
}

describe("buildManagerStats", () => {
  it("passes through the simple manager-owned scalar fields unchanged", () => {
    const inputs = baseInputs({
      state: "connecting",
      keyframeRequestsSent: 7,
      remoteCandidatesAdded: 11,
      icePollAttemptsUsed: 4,
      iceSource: "fallback-only",
      stunCount: 3,
      turnCount: 0,
      currentAttempt: 2,
      lastTriggerReason: "iceDisconnected",
      backoffMs: 6000,
      consoleName: "Bedroom Xbox",
      consoleType: "Lockhart",
    });

    const result = buildManagerStats(inputs, FIXED_NOW);

    expect(result.state).toBe("connecting");
    expect(result.keyframeRequestsSent).toBe(7);
    expect(result.remoteCandidatesAdded).toBe(11);
    expect(result.icePollAttemptsUsed).toBe(4);
    expect(result.source).toBe("fallback-only");
    expect(result.stunCount).toBe(3);
    expect(result.turnCount).toBe(0);
    expect(result.currentAttempt).toBe(2);
    expect(result.maxAttempts).toBe(RECONNECT_MAX_ATTEMPTS);
    expect(result.lastTriggerReason).toBe("iceDisconnected");
    expect(result.backoffMs).toBe(6000);
    expect(result.consoleName).toBe("Bedroom Xbox");
    expect(result.consoleType).toBe("Lockhart");
    // GamepadPoller exposes no public seq/Hz — always null (verbatim from source).
    expect(result.outboundPacketHz).toBeNull();
    expect(result.lastSequence).toBeNull();
  });

  describe("skewMs (video/audio arrival skew)", () => {
    it("is null when either arrival timestamp is missing", () => {
      expect(
        buildManagerStats(baseInputs({ videoArrivedAt: null, audioArrivedAt: null }), FIXED_NOW)
          .skewMs,
      ).toBeNull();
      expect(
        buildManagerStats(
          baseInputs({ videoArrivedAt: FIXED_NOW - 100, audioArrivedAt: null }),
          FIXED_NOW,
        ).skewMs,
      ).toBeNull();
      expect(
        buildManagerStats(
          baseInputs({ videoArrivedAt: null, audioArrivedAt: FIXED_NOW - 100 }),
          FIXED_NOW,
        ).skewMs,
      ).toBeNull();
    });

    it("is the absolute difference when both timestamps are present, video after audio", () => {
      const inputs = baseInputs({
        videoArrivedAt: FIXED_NOW - 100,
        audioArrivedAt: FIXED_NOW - 250,
      });
      const result = buildManagerStats(inputs, FIXED_NOW);
      expect(result.videoArrivedAt).toBe(FIXED_NOW - 100);
      expect(result.audioArrivedAt).toBe(FIXED_NOW - 250);
      expect(result.skewMs).toBe(150);
    });

    it("is the absolute difference when audio arrives after video (order-independent)", () => {
      const inputs = baseInputs({
        videoArrivedAt: FIXED_NOW - 250,
        audioArrivedAt: FIXED_NOW - 100,
      });
      expect(buildManagerStats(inputs, FIXED_NOW).skewMs).toBe(150);
    });

    it("is 0 when both tracks arrived at the exact same timestamp", () => {
      const inputs = baseInputs({
        videoArrivedAt: FIXED_NOW - 500,
        audioArrivedAt: FIXED_NOW - 500,
      });
      expect(buildManagerStats(inputs, FIXED_NOW).skewMs).toBe(0);
    });
  });

  describe("channels (per-channel ChannelStats assembly)", () => {
    it("always emits exactly 4 channels in order: chat, control, message, input", () => {
      const result = buildManagerStats(baseInputs(), FIXED_NOW);
      expect(result.channels.map((c) => c.label)).toEqual([
        "chat",
        "control",
        "message",
        "input",
      ]);
    });

    it("reports 'closed' state and null openedAt when channels is null", () => {
      const inputs = baseInputs({
        channels: null,
        channelOpenedAt: { chat: null, control: null, message: null, input: null },
      });
      const result = buildManagerStats(inputs, FIXED_NOW);
      for (const ch of result.channels) {
        expect(ch.state).toBe("closed");
        expect(ch.openedAt).toBeNull();
      }
    });

    it("reads each channel's live readyState and its recorded openedAt timestamp", () => {
      const channels: DataChannelSet = {
        chat: fakeChannel("open"),
        control: fakeChannel("connecting"),
        message: fakeChannel("open"),
        input: fakeChannel("closed"),
      };
      const inputs = baseInputs({
        channels,
        channelOpenedAt: {
          chat: FIXED_NOW - 5000,
          control: null,
          message: FIXED_NOW - 4800,
          input: null,
        },
      });
      const result = buildManagerStats(inputs, FIXED_NOW);
      const byLabel = Object.fromEntries(result.channels.map((c) => [c.label, c]));
      expect(byLabel.chat).toEqual({ label: "chat", state: "open", openedAt: FIXED_NOW - 5000 });
      expect(byLabel.control).toEqual({ label: "control", state: "connecting", openedAt: null });
      expect(byLabel.message).toEqual({
        label: "message",
        state: "open",
        openedAt: FIXED_NOW - 4800,
      });
      expect(byLabel.input).toEqual({ label: "input", state: "closed", openedAt: null });
    });

    it("falls back to 'closed' for a channel missing from channelOpenedAt (?? null)", () => {
      const channels: DataChannelSet = {
        chat: fakeChannel("open"),
        control: fakeChannel("open"),
        message: fakeChannel("open"),
        input: fakeChannel("open"),
      };
      // Deliberately incomplete record — exercises the `?? null` fallback.
      const inputs = baseInputs({
        channels,
        channelOpenedAt: {} as unknown as ManagerStatsInputs["channelOpenedAt"],
      });
      const result = buildManagerStats(inputs, FIXED_NOW);
      for (const ch of result.channels) {
        expect(ch.openedAt).toBeNull();
      }
    });
  });

  describe("handshakeMs", () => {
    it("is null when firstChannelOpenAt is missing", () => {
      const inputs = baseInputs({ firstChannelOpenAt: null, handshakeAckAt: FIXED_NOW - 100 });
      expect(buildManagerStats(inputs, FIXED_NOW).handshakeMs).toBeNull();
    });

    it("is null when handshakeAckAt is missing", () => {
      const inputs = baseInputs({ firstChannelOpenAt: FIXED_NOW - 500, handshakeAckAt: null });
      expect(buildManagerStats(inputs, FIXED_NOW).handshakeMs).toBeNull();
    });

    it("is handshakeAckAt - firstChannelOpenAt when both are present", () => {
      const inputs = baseInputs({
        firstChannelOpenAt: FIXED_NOW - 500,
        handshakeAckAt: FIXED_NOW - 120,
      });
      expect(buildManagerStats(inputs, FIXED_NOW).handshakeMs).toBe(380);
    });
  });

  describe("msSinceLastKeepalive", () => {
    it("is null when lastKeepaliveAt is null", () => {
      const inputs = baseInputs({ lastKeepaliveAt: null });
      expect(buildManagerStats(inputs, FIXED_NOW).msSinceLastKeepalive).toBeNull();
    });

    it("is now - lastKeepaliveAt when lastKeepaliveAt is present", () => {
      const inputs = baseInputs({ lastKeepaliveAt: FIXED_NOW - 12_345 });
      expect(buildManagerStats(inputs, FIXED_NOW).msSinceLastKeepalive).toBe(12_345);
    });
  });

  describe("activeKeepalive precedence (api beats idle)", () => {
    it("is 'none' when neither timer is active", () => {
      const inputs = baseInputs({ apiKeepAliveActive: false, idleKeepaliveActive: false });
      expect(buildManagerStats(inputs, FIXED_NOW).activeKeepalive).toBe("none");
    });

    it("is 'api' when only the API keepalive is active", () => {
      const inputs = baseInputs({ apiKeepAliveActive: true, idleKeepaliveActive: false });
      expect(buildManagerStats(inputs, FIXED_NOW).activeKeepalive).toBe("api");
    });

    it("is 'idle' when only the idle keepalive is active", () => {
      const inputs = baseInputs({ apiKeepAliveActive: false, idleKeepaliveActive: true });
      expect(buildManagerStats(inputs, FIXED_NOW).activeKeepalive).toBe("idle");
    });

    it("is 'api' when BOTH timers are active — api takes precedence over idle", () => {
      const inputs = baseInputs({ apiKeepAliveActive: true, idleKeepaliveActive: true });
      expect(buildManagerStats(inputs, FIXED_NOW).activeKeepalive).toBe("api");
    });
  });

  it("passes lastIdleWarningSecondsUntilKick through unchanged", () => {
    expect(
      buildManagerStats(baseInputs({ lastIdleWarningSecondsUntilKick: null }), FIXED_NOW)
        .lastIdleWarningSecondsUntilKick,
    ).toBeNull();
    expect(
      buildManagerStats(baseInputs({ lastIdleWarningSecondsUntilKick: 45 }), FIXED_NOW)
        .lastIdleWarningSecondsUntilKick,
    ).toBe(45);
  });

  it("produces a full golden snapshot for a realistic mid-session state", () => {
    const channels: DataChannelSet = {
      chat: fakeChannel("open"),
      control: fakeChannel("open"),
      message: fakeChannel("open"),
      input: fakeChannel("open"),
    };
    const inputs: ManagerStatsInputs = {
      state: "streaming",
      keyframeRequestsSent: 1,
      remoteCandidatesAdded: 6,
      icePollAttemptsUsed: 2,
      iceSource: "xbox-provided",
      stunCount: 2,
      turnCount: 2,
      apiKeepAliveActive: true,
      idleKeepaliveActive: false,
      lastKeepaliveAt: FIXED_NOW - 3_000,
      lastIdleWarningSecondsUntilKick: null,
      channels,
      channelOpenedAt: {
        chat: FIXED_NOW - 9_000,
        control: FIXED_NOW - 8_950,
        message: FIXED_NOW - 8_900,
        input: FIXED_NOW - 8_800,
      },
      firstChannelOpenAt: FIXED_NOW - 9_000,
      handshakeAckAt: FIXED_NOW - 8_700,
      currentAttempt: 0,
      lastTriggerReason: null,
      backoffMs: null,
      videoArrivedAt: FIXED_NOW - 7_000,
      audioArrivedAt: FIXED_NOW - 7_020,
      consoleName: "Living Room Xbox",
      consoleType: "Scarlett",
    };

    const result = buildManagerStats(inputs, FIXED_NOW);

    expect(result).toEqual({
      state: "streaming",
      keyframeRequestsSent: 1,
      remoteCandidatesAdded: 6,
      icePollAttemptsUsed: 2,
      source: "xbox-provided",
      stunCount: 2,
      turnCount: 2,
      activeKeepalive: "api",
      msSinceLastKeepalive: 3_000,
      lastIdleWarningSecondsUntilKick: null,
      channels: [
        { label: "chat", state: "open", openedAt: FIXED_NOW - 9_000 },
        { label: "control", state: "open", openedAt: FIXED_NOW - 8_950 },
        { label: "message", state: "open", openedAt: FIXED_NOW - 8_900 },
        { label: "input", state: "open", openedAt: FIXED_NOW - 8_800 },
      ],
      handshakeMs: 300,
      currentAttempt: 0,
      maxAttempts: RECONNECT_MAX_ATTEMPTS,
      lastTriggerReason: null,
      backoffMs: null,
      videoArrivedAt: FIXED_NOW - 7_000,
      audioArrivedAt: FIXED_NOW - 7_020,
      skewMs: 20,
      outboundPacketHz: null,
      lastSequence: null,
      consoleName: "Living Room Xbox",
      consoleType: "Scarlett",
    });
  });
});
