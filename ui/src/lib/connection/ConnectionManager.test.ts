// @vitest-environment jsdom
/**
 * ConnectionManager.test.ts — characterization harness (Task 0 of the
 * ConnectionManager decomposition, see
 * docs/superpowers/specs/2026-07-06-connectionmanager-refactor-design.md).
 *
 * ConnectionManager has NO orchestrator-level tests today. This file PINS the
 * current, unchanged behaviour so that later extraction steps (managerStats,
 * keepalive, signaling, reconnect, receiverTap, inputSession) can be verified
 * to change nothing. Every test here must PASS against the monolith as it
 * stands — if one fails, the test's model of the behaviour is wrong, not the
 * production code (fix the test, never the code, to make these green).
 *
 * jsdom provides NO WebRTC globals (RTCPeerConnection / RTCDataChannel /
 * RTCIceCandidate / navigator.getGamepads are all `undefined` — verified by
 * hand against this exact vitest/jsdom pair). This file installs minimal fake
 * implementations of exactly the members ConnectionManager.ts uses (enumerated
 * below) on `globalThis` for the duration of each test.
 *
 * RTCPeerConnection members used by ConnectionManager.ts:
 *   createDataChannel, addTransceiver, createOffer, setLocalDescription,
 *   setRemoteDescription, addIceCandidate, getStats, getReceivers, close,
 *   localDescription (read), connectionState / iceConnectionState /
 *   iceGatheringState (read/write for the fake to drive handlers),
 *   ontrack, onconnectionstatechange, oniceconnectionstatechange,
 *   onicecandidate, onicegatheringstatechange, ondatachannel.
 *
 * RTCDataChannel members used:
 *   createDataChannel(label, {ordered, protocol}) return value's
 *   binaryType, send, close, readyState, label, id,
 *   onopen, onmessage, onclose, onerror.
 *
 * Mocking recipe copied from NativeConnection.test.ts:
 * `vi.mock("../ipc/commands.js")` BEFORE importing ConnectionManager,
 * `vi.useFakeTimers()` in beforeEach, `vi.useRealTimers()` +
 * `vi.clearAllMocks()` in afterEach.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";

// ── Mock the IPC commands module before importing ConnectionManager ────────
// NOTE: ConnectionManager's `_log()` goes through `$lib/log/logger.js`, which
// ALSO imports `logEvent` from this same module (to forward log records to
// the Rust backend). It must be present in the mock or every `_log()` call
// throws "No 'logEvent' export is defined" (logger.ts swallows the throw with
// a console.warn, but the underlying batcher never flushes correctly, so we
// mock it properly rather than rely on that swallow).
vi.mock("../ipc/commands.js", () => ({
  createXhomeSession: vi.fn(),
  getIceServers: vi.fn(),
  exchangeSdp: vi.fn(),
  sendIceCandidate: vi.fn(),
  pollIceCandidates: vi.fn(),
  sendSessionKeepalive: vi.fn(),
  setStreamStatus: vi.fn(),
  logEvent: vi.fn().mockResolvedValue(undefined),
}));

// ── Import AFTER mock registration ──────────────────────────────────────────
import * as commands from "../ipc/commands.js";
import { ConnectionManager } from "./ConnectionManager.js";
import type { ConnectionManagerCallbacks } from "./ConnectionManager.js";
import type { XHomeConsole, StreamConfig, IceServer } from "../ipc/types.js";
import {
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_BASE_DELAY_MS,
  API_KEEPALIVE_MS,
  IDLE_PULSE_LEFT_THUMB_X,
  IDLE_PULSE_RECENTER_MS,
  IDLE_KEEPALIVE_INTERVAL_MS,
  ICE_GATHER_WAIT_MS,
  DISCONNECT_GRACE_MS,
  WAIT_FOR_DATA_CHANNELS_MS,
} from "./constants.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fake WebRTC harness
// ─────────────────────────────────────────────────────────────────────────────

/** One recorded call in the shared call-order ledger. */
type CallRecord = { target: string; method: string; args: unknown[] };

/** Reset between tests; captures the GLOBAL order of fake-object method calls. */
let callLog: CallRecord[] = [];

function record(target: string, method: string, args: unknown[] = []): void {
  callLog.push({ target, method, args });
}

/** Minimal duck-typed receiver satisfying `_wireEncodedTap` + `getReceivers()`. */
class FakeRTCRtpReceiver {
  constructor(public track: { kind: string; enabled: boolean } | null) {}
  createEncodedStreams(): { readable: ReadableStream; writable: WritableStream } {
    // Real TransformStream machinery (available natively in this jsdom/vitest
    // pair) so `_wireEncodedTap`'s `readable.pipeThrough(transform).pipeTo(writable)`
    // does not throw. No consumer reads `writable` in these tests — a plain
    // sink is enough since ConnectionManager only ever writes into it.
    const ts = new TransformStream();
    return { readable: ts.readable, writable: ts.writable };
  }
}

/** All FakeRTCDataChannel instances created this test, indexed by label (last wins). */
let channelsByLabel: Map<string, FakeRTCDataChannel>;

class FakeRTCDataChannel {
  label: string;
  protocol: string;
  ordered: boolean;
  id = Math.floor(Math.random() * 100000);
  binaryType = "blob";
  readyState: RTCDataChannelState = "connecting";
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sent: Uint8Array[] = [];

  constructor(label: string, opts: { ordered?: boolean; protocol?: string } = {}) {
    this.label = label;
    this.ordered = opts.ordered ?? true;
    this.protocol = opts.protocol ?? "";
    channelsByLabel.set(label, this);
  }

  send(data: Uint8Array | string): void {
    record("channel:" + this.label, "send", [data]);
    if (typeof data === "string") {
      this.sent.push(new TextEncoder().encode(data));
    } else {
      this.sent.push(new Uint8Array(data));
    }
  }

  close(): void {
    record("channel:" + this.label, "close");
    this.readyState = "closed";
  }

  /** Test helper: simulate the channel reaching 'open' and fire onopen. */
  simulateOpen(): void {
    this.readyState = "open";
    this.onopen?.();
  }

  /** Test helper: simulate an inbound message (JSON auto-stringified). */
  simulateMessage(data: unknown): void {
    const text = typeof data === "string" ? data : JSON.stringify(data);
    this.onmessage?.({ data: text } as MessageEvent);
  }

  /** Test helper: simulate the channel closing (fires onclose). */
  simulateClose(): void {
    this.readyState = "closed";
    this.onclose?.();
  }
}

/** The most recently constructed FakeRTCPeerConnection (tests read this). */
let lastPc: FakeRTCPeerConnection | null = null;

class FakeRTCPeerConnection {
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
  localDescription: { type: string; sdp: string } | null = null;
  ontrack: ((ev: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onicecandidate: ((ev: { candidate: unknown }) => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;
  ondatachannel: ((ev: { channel: FakeRTCDataChannel }) => void) | null = null;

  private _receivers: FakeRTCRtpReceiver[] = [];
  private readonly _config: unknown;

  constructor(config: unknown) {
    this._config = config;
    record("pc", "constructor", [config]);
    lastPc = this;
  }

  createDataChannel(label: string, opts?: { ordered?: boolean; protocol?: string }): FakeRTCDataChannel {
    record("pc", "createDataChannel", [label, opts]);
    return new FakeRTCDataChannel(label, opts);
  }

  addTransceiver(kind: string, opts?: { direction?: string }): void {
    record("pc", "addTransceiver", [kind, opts]);
  }

  async createOffer(): Promise<{ type: string; sdp: string }> {
    record("pc", "createOffer");
    return {
      type: "offer",
      sdp:
        "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n" +
        "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\n" +
        "m=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\n",
    };
  }

  async setLocalDescription(desc: { type: string; sdp: string }): Promise<void> {
    record("pc", "setLocalDescription", [desc]);
    this.localDescription = desc;
  }

  async setRemoteDescription(desc: { type: string; sdp: string }): Promise<void> {
    record("pc", "setRemoteDescription", [desc]);
  }

  async addIceCandidate(candidate: unknown): Promise<void> {
    record("pc", "addIceCandidate", [candidate]);
  }

  async getStats(): Promise<Map<string, unknown>> {
    return new Map();
  }

  getReceivers(): FakeRTCRtpReceiver[] {
    return this._receivers;
  }

  close(): void {
    record("pc", "close");
    this.connectionState = "closed";
  }

  // ── Test helpers (not part of the real RTCPeerConnection surface) ────────

  /** Simulate a track arriving; builds a fake receiver + fires ontrack. */
  simulateTrack(kind: "video" | "audio", withStream = true): FakeRTCRtpReceiver {
    const track = {
      kind,
      enabled: true,
      onmute: null,
      onunmute: null,
      onended: null,
      // Real MediaStreamTrack has stop(); _cleanupConnection calls it on
      // every track in the (fake) MediaStream during teardown.
      stop: () => {},
    } as unknown as {
      kind: string;
      enabled: boolean;
      onmute: (() => void) | null;
      onunmute: (() => void) | null;
      onended: (() => void) | null;
      stop: () => void;
      id: string;
    };
    (track as { id: string }).id = kind + "-track-1";
    const receiver = new FakeRTCRtpReceiver(track as unknown as { kind: string; enabled: boolean });
    this._receivers.push(receiver);
    const fakeStream = withStream ? new FakeMediaStream([track]) : null;
    this.ontrack?.({
      track,
      receiver,
      streams: fakeStream ? [fakeStream] : [],
    });
    return receiver;
  }

  /** Simulate a connectionState transition; fires onconnectionstatechange. */
  simulateConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  /** Simulate an iceConnectionState transition; fires oniceconnectionstatechange. */
  simulateIceConnectionState(state: RTCIceConnectionState): void {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }
}

/** Duck-typed fake MediaStreamTrack: id/kind (identity) + stop() (real
 *  MediaStreamTrack API — _cleanupConnection calls it on every track). */
type FakeTrack = { id: string; kind: string; stop: () => void };

/** Minimal fake MediaStream — jsdom has none; ConnectionManager only calls
 *  addTrack / getTracks / getTrackById on it. */
class FakeMediaStream {
  private tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }
  addTrack(t: FakeTrack): void {
    this.tracks.push(t);
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getTrackById(id: string): FakeTrack | null {
    return this.tracks.find((t) => t.id === id) ?? null;
  }
}

/** Minimal fake RTCIceCandidate — ConnectionManager only constructs+forwards it. */
class FakeRTCIceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  constructor(init: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }) {
    this.candidate = init.candidate;
    this.sdpMid = init.sdpMid ?? null;
    this.sdpMLineIndex = init.sdpMLineIndex ?? null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Install / uninstall on globalThis
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type G = Record<string, any>;
let savedGlobals: {
  RTCPeerConnection: unknown;
  RTCDataChannel: unknown;
  RTCIceCandidate: unknown;
  MediaStream: unknown;
  getGamepads: unknown;
} | null = null;

function installFakeWebRtc(): void {
  const g = globalThis as G;
  savedGlobals = {
    RTCPeerConnection: g.RTCPeerConnection,
    RTCDataChannel: g.RTCDataChannel,
    RTCIceCandidate: g.RTCIceCandidate,
    MediaStream: g.MediaStream,
    getGamepads: g.navigator?.getGamepads,
  };
  g.RTCPeerConnection = FakeRTCPeerConnection;
  g.RTCDataChannel = FakeRTCDataChannel;
  g.RTCIceCandidate = FakeRTCIceCandidate;
  g.MediaStream = FakeMediaStream;

  // GamepadPoller reads navigator.getGamepads() once streaming starts.
  // Stub to "no physical pad" so the poller falls back to idle frames only.
  Object.defineProperty(g.navigator, "getGamepads", {
    value: () => [null, null, null, null],
    configurable: true,
    writable: true,
  });
}

function uninstallFakeWebRtc(): void {
  const g = globalThis as G;
  if (!savedGlobals) return;
  g.RTCPeerConnection = savedGlobals.RTCPeerConnection;
  g.RTCDataChannel = savedGlobals.RTCDataChannel;
  g.RTCIceCandidate = savedGlobals.RTCIceCandidate;
  g.MediaStream = savedGlobals.MediaStream;
  if (savedGlobals.getGamepads) {
    Object.defineProperty(g.navigator, "getGamepads", {
      value: savedGlobals.getGamepads,
      configurable: true,
      writable: true,
    });
  }
  savedGlobals = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeConsole(): XHomeConsole {
  return {
    serverId: "server-abc",
    deviceName: "My Xbox",
    consoleType: "XboxSeriesX",
    powerState: "On",
    isDevKit: false,
    playPath: "/v5/sessions/home/server-abc/play",
  };
}

function makeSession(overrides: Partial<StreamConfig> = {}): StreamConfig {
  return {
    sessionId: "session-1",
    sessionPath: "/v5/sessions/home/server-abc/session-1",
    exchangeResponse: "",
    gsToken: "gs-token-1",
    keepAlivePulseSeconds: 60,
    ...overrides,
  };
}

function makeIceServers(): IceServer[] {
  return [{ urls: "turn:turn.example.com:3478", username: "u", credential: "c" }];
}

interface SpyCbs {
  onStateChange: Mock;
  onDiagnostics: Mock;
  onLog: Mock;
  onMediaStream: Mock;
  onReconnectAttempt: Mock;
  asCallbacks(): ConnectionManagerCallbacks;
}

function makeCallbacks(): SpyCbs {
  const cbs: SpyCbs = {
    onStateChange: vi.fn(),
    onDiagnostics: vi.fn(),
    onLog: vi.fn(),
    onMediaStream: vi.fn(),
    onReconnectAttempt: vi.fn(),
    asCallbacks() {
      return {
        onStateChange: cbs.onStateChange,
        onDiagnostics: cbs.onDiagnostics,
        onLog: cbs.onLog,
        onMediaStream: cbs.onMediaStream,
        onReconnectAttempt: cbs.onReconnectAttempt,
      };
    },
  };
  return cbs;
}

/**
 * Default-wires all IPC mocks to resolve happily; each test may override.
 *
 * `pollIceCandidates` flips `lastPc.iceConnectionState` to "connected" on its
 * FIRST call, mimicking real ICE negotiation succeeding quickly — this makes
 * `_pollForIceCandidates`'s `while` loop (constants.ts: ICE_POLL_MAX_ATTEMPTS=20
 * × ICE_POLL_INTERVAL_MS=500ms) exit after exactly one 500ms tick instead of
 * consuming its full 10s worst-case budget, keeping tests fast and precise.
 */
function wireHappyIpc(): void {
  vi.mocked(commands.createXhomeSession).mockResolvedValue(makeSession());
  vi.mocked(commands.getIceServers).mockResolvedValue(makeIceServers());
  vi.mocked(commands.exchangeSdp).mockResolvedValue(
    "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n",
  );
  vi.mocked(commands.sendIceCandidate).mockResolvedValue(undefined);
  vi.mocked(commands.pollIceCandidates).mockImplementation(async () => {
    if (lastPc) lastPc.iceConnectionState = "connected";
    return [];
  });
  vi.mocked(commands.sendSessionKeepalive).mockResolvedValue("200");
  vi.mocked(commands.setStreamStatus).mockResolvedValue(undefined);
}

/** Drain the microtask queue without advancing fake time (lets pending awaits
 *  on already-resolved promises settle before the next assertion). */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

/**
 * Drive a `connect()` call all the way through `_setupWebRTC` INCLUDING the
 * ICE-poll loop (which — per `wireHappyIpc` — exits after exactly one 500ms
 * tick because `pollIceCandidates` flips iceConnectionState to "connected").
 * Resolves once `connect()` itself resolves. Deliberately does NOT use
 * `vi.runAllTimersAsync()`: ConnectionManager arms several PERSISTENT
 * intervals once streaming starts (StatsSampler @2000ms, the media-monitor
 * ticker @1000ms, GamepadPoller @16ms, the API keepalive @30000ms) that never
 * self-clear while a session is active, which makes runAllTimersAsync's
 * "empty queue" exit condition unreachable (observed: "Aborting after running
 * 10000 timers, assuming an infinite loop!"). Advancing by a bounded, exact
 * amount of fake time is the only way to drive this deterministically.
 */
async function driveConnect(promise: Promise<void>): Promise<void> {
  await flushMicrotasks();
  await vi.advanceTimersByTimeAsync(ICE_GATHER_WAIT_MS); // exchangeSdp fires
  await flushMicrotasks();
  await vi.advanceTimersByTimeAsync(600); // one ICE_POLL_INTERVAL_MS tick (500ms) + margin
  await flushMicrotasks();
  await promise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite setup
// ─────────────────────────────────────────────────────────────────────────────

describe("ConnectionManager (characterization)", () => {
  let cm: ConnectionManager;
  let cbs: SpyCbs;

  beforeEach(() => {
    vi.useFakeTimers();
    callLog = [];
    channelsByLabel = new Map();
    lastPc = null;
    installFakeWebRtc();
    wireHappyIpc();
    cbs = makeCallbacks();
    cm = new ConnectionManager(cbs.asCallbacks());
  });

  afterEach(() => {
    uninstallFakeWebRtc();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Group 1 — Connect ordering
  // ═══════════════════════════════════════════════════════════════════════

  describe("Group 1: connect ordering", () => {
    it("creates the xHome session before requesting ICE servers or constructing the RTCPeerConnection", async () => {
      // createXhomeSession is awaited BEFORE _setupWebRTC even starts
      // (ConnectionManager.ts:391-421 _createSessionAndStream), so make it
      // hang deliberately to observe the ordering precisely: nothing
      // ICE/PC-related can happen until it resolves.
      let resolveSession: ((v: StreamConfig) => void) | null = null;
      vi.mocked(commands.createXhomeSession).mockImplementation(
        () => new Promise((resolve) => { resolveSession = resolve; }),
      );

      const connectPromise = cm.connect(makeConsole());
      await flushMicrotasks();

      expect(commands.createXhomeSession).toHaveBeenCalledWith("server-abc", undefined);
      expect(commands.getIceServers).not.toHaveBeenCalled();
      expect(callLog.find((c) => c.target === "pc")).toBeUndefined();

      // Now let session creation resolve and the rest of connect() proceed.
      resolveSession!(makeSession());
      await driveConnect(connectPromise);

      expect(commands.getIceServers).toHaveBeenCalled();
      expect(callLog.find((c) => c.target === "pc" && c.method === "constructor")).toBeDefined();
    });

    it("arms the API keepalive with NO immediate send; first send only at +30s", async () => {
      // _startApiKeepalive() runs synchronously right after session creation
      // (ConnectionManager.ts:418), BEFORE _setupWebRTC — so the interval's
      // own clock starts at t=armedAt, which is earlier than when
      // driveConnect() finishes walking the rest of connect() to completion
      // (it burns ~1.6s of fake time on ICE_GATHER_WAIT_MS + the ICE-poll
      // tick). Anchor on Date.now() (mocked by vi.useFakeTimers(), like every
      // other timer primitive) rather than hardcoding driveConnect's internal
      // budget, so this test is independent of that helper's implementation.
      const armedAt = Date.now();
      const connectPromise = cm.connect(makeConsole());
      await driveConnect(connectPromise);

      // Nothing sent yet, even after the full connect has settled — the
      // interval fires no earlier than API_KEEPALIVE_MS after it armed.
      expect(commands.sendSessionKeepalive).not.toHaveBeenCalled();

      // Advance to just short of the 30s mark (measured from armedAt) — still
      // zero sends.
      const msUntil30s = armedAt + API_KEEPALIVE_MS - Date.now();
      await vi.advanceTimersByTimeAsync(msUntil30s - 100);
      expect(commands.sendSessionKeepalive).not.toHaveBeenCalled();

      // Crossing the 30s mark (from interval-arm time) fires exactly one send.
      await vi.advanceTimersByTimeAsync(200);
      expect(commands.sendSessionKeepalive).toHaveBeenCalledTimes(1);
      expect(commands.sendSessionKeepalive).toHaveBeenCalledWith(
        "/v5/sessions/home/server-abc/session-1",
      );
    });

    it("fetches ICE servers, THEN creates 4 data channels BEFORE createOffer, THEN setLocalDescription", async () => {
      const connectPromise = cm.connect(makeConsole());
      await driveConnect(connectPromise);

      expect(commands.getIceServers).toHaveBeenCalledWith(
        "/v5/sessions/home/server-abc/session-1",
      );

      const pcOps = callLog.filter((c) => c.target === "pc").map((c) => c.method);
      const createDataChannelIdxs = pcOps
        .map((m, i) => (m === "createDataChannel" ? i : -1))
        .filter((i) => i >= 0);
      const createOfferIdx = pcOps.indexOf("createOffer");
      const setLocalDescIdx = pcOps.indexOf("setLocalDescription");

      expect(createDataChannelIdxs.length).toBe(4);
      expect(Math.max(...createDataChannelIdxs)).toBeLessThan(createOfferIdx);
      expect(createOfferIdx).toBeLessThan(setLocalDescIdx);

      const labels = callLog
        .filter((c) => c.target === "pc" && c.method === "createDataChannel")
        .map((c) => c.args[0]);
      expect(labels).toEqual(["chat", "control", "message", "input"]);
    });

    it("waits ICE_GATHER_WAIT_MS after setLocalDescription before exchangeSdp, then setRemoteDescription, then begins ICE polling", async () => {
      const connectPromise = cm.connect(makeConsole());
      await flushMicrotasks();

      // Reach setLocalDescription but do NOT advance the gather wait yet.
      const pcOpsBefore = callLog.filter((c) => c.target === "pc").map((c) => c.method);
      expect(pcOpsBefore).toContain("setLocalDescription");
      expect(commands.exchangeSdp).not.toHaveBeenCalled();

      // Advancing less than the full wait must not trigger the exchange yet.
      await vi.advanceTimersByTimeAsync(ICE_GATHER_WAIT_MS - 100);
      expect(commands.exchangeSdp).not.toHaveBeenCalled();

      // Crossing the threshold fires the exchange.
      await vi.advanceTimersByTimeAsync(100);
      await flushMicrotasks();
      expect(commands.exchangeSdp).toHaveBeenCalledWith(
        "/v5/sessions/home/server-abc/session-1",
        expect.any(String),
      );

      const pcOpsAfter = callLog.filter((c) => c.target === "pc").map((c) => c.method);
      expect(pcOpsAfter).toContain("setRemoteDescription");
      expect(pcOpsAfter.indexOf("setRemoteDescription")).toBeGreaterThan(
        pcOpsAfter.indexOf("setLocalDescription"),
      );

      // ICE polling begins — pollIceCandidates is called at least once. Our
      // mock flips iceConnectionState to "connected" on its first call, so
      // the poll loop's `while` condition exits after that single tick.
      await vi.advanceTimersByTimeAsync(600);
      await flushMicrotasks();
      expect(commands.pollIceCandidates).toHaveBeenCalled();

      await connectPromise;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Group 2 — Reconnect ladder
  // ═══════════════════════════════════════════════════════════════════════

  describe("Group 2: reconnect ladder", () => {
    /** Drive a connect() to the point where the PC exists and channels are open. */
    async function connectAndSettleChannels(): Promise<void> {
      const p = cm.connect(makeConsole());
      await driveConnect(p);
      // Open the message channel so _waitForDataChannels resolves quickly on
      // each reconnect attempt.
      channelsByLabel.get("message")?.simulateOpen();
    }

    it("attempts 1..3 with 3s/6s/9s backoff, cleanup before each backoff, onReconnectAttempt(n,3), and 'failed' after max", async () => {
      await connectAndSettleChannels();
      cbs.onStateChange.mockClear();
      cbs.onReconnectAttempt.mockClear();
      // The initial connect() already called createXhomeSession once; clear
      // so the counters below measure ONLY the reconnect ladder's own calls.
      vi.mocked(commands.createXhomeSession).mockClear();

      // Make every subsequent createXhomeSession fail so the ladder exhausts
      // all 3 attempts (channel never opens because _createSessionAndStream
      // itself rejects before a new pc/channels are made).
      vi.mocked(commands.createXhomeSession).mockRejectedValue(new Error("boom"));

      const pcBeforeFail = lastPc!;
      pcBeforeFail.simulateConnectionState("failed");

      // Reconnecting state fires synchronously inside _reconnect() before the
      // first backoff wait.
      expect(cbs.onStateChange).toHaveBeenCalledWith("reconnecting");

      // ── Attempt 1: 3s backoff ──────────────────────────────────────────
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS - 100);
      expect(cbs.onReconnectAttempt).toHaveBeenCalledWith(1, RECONNECT_MAX_ATTEMPTS);
      // cleanup() closes the old pc BEFORE the backoff wait for that attempt.
      expect(pcBeforeFail.connectionState).toBe("closed");

      await vi.advanceTimersByTimeAsync(100); // cross the 3s mark
      await flushMicrotasks();
      // createXhomeSession invoked for attempt 1's _createSessionAndStream.
      expect(commands.createXhomeSession).toHaveBeenCalledTimes(1);

      // ── Attempt 2: 6s backoff ──────────────────────────────────────────
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS * 2);
      await flushMicrotasks();
      expect(cbs.onReconnectAttempt).toHaveBeenCalledWith(2, RECONNECT_MAX_ATTEMPTS);
      expect(commands.createXhomeSession).toHaveBeenCalledTimes(2);

      // ── Attempt 3: 9s backoff ──────────────────────────────────────────
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS * 3);
      await flushMicrotasks();
      expect(cbs.onReconnectAttempt).toHaveBeenCalledWith(3, RECONNECT_MAX_ATTEMPTS);
      expect(commands.createXhomeSession).toHaveBeenCalledTimes(3);

      // After exhausting all 3 attempts (each createXhomeSession rejects
      // synchronously, so the loop's `while` condition re-checks immediately
      // with no further timer needed), the ladder gives up.
      await flushMicrotasks();
      expect(cm.state).toBe("failed");
      expect(cbs.onStateChange).toHaveBeenCalledWith("failed");
    });

    it("exact backoff delays are RECONNECT_BASE_DELAY_MS × attempt (3000/6000/9000ms)", () => {
      expect(RECONNECT_BASE_DELAY_MS).toBe(3000);
      expect(RECONNECT_BASE_DELAY_MS * 1).toBe(3000);
      expect(RECONNECT_BASE_DELAY_MS * 2).toBe(6000);
      expect(RECONNECT_BASE_DELAY_MS * 3).toBe(9000);
    });

    it("a 'disconnected' connectionState waits DISCONNECT_GRACE_MS before reconnecting, and does NOT reconnect if it recovers within the grace window", async () => {
      await connectAndSettleChannels();
      cbs.onStateChange.mockClear();

      const pc = lastPc!;
      pc.simulateConnectionState("disconnected");
      // Unlike "failed", "disconnected" does NOT trigger an immediate
      // reconnect — spec §3.9 grants a DISCONNECT_GRACE_MS grace period first.
      expect(cm.state).not.toBe("reconnecting");
      expect(cbs.onStateChange).not.toHaveBeenCalledWith("reconnecting");

      // Recovering to "connected" BEFORE the grace timer fires must cancel
      // the pending reconnect entirely (ConnectionManager.ts:800-804 clears
      // the timer on EVERY connectionstatechange, not just terminal ones).
      await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS - 1_000);
      pc.simulateConnectionState("connected");
      await vi.advanceTimersByTimeAsync(2_000); // past where the original grace timer would have fired
      expect(cm.state).not.toBe("reconnecting");
      expect(commands.createXhomeSession).toHaveBeenCalledTimes(1); // no reconnect attempt happened
    });

    it("a 'disconnected' connectionState that is STILL disconnected after DISCONNECT_GRACE_MS triggers a reconnect", async () => {
      await connectAndSettleChannels();
      cbs.onStateChange.mockClear();

      const pc = lastPc!;
      // IMPORTANT (design spec risk #1 — grace-timer precision): the re-check
      // inside the grace-timer callback reads the HANDLER-CLOSURE'S captured
      // `pc` (`pc.connectionState === "disconnected"`), not a live `this._pc`
      // thunk — so it only fires if THIS SAME pc object is still reporting
      // "disconnected" when the timer elapses. We leave `pc.connectionState`
      // unchanged (still "disconnected") for the whole grace window here.
      pc.simulateConnectionState("disconnected");
      expect(cm.state).not.toBe("reconnecting");

      await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS + 100);
      await flushMicrotasks();
      expect(cm.state).toBe("reconnecting");

      // The ladder now runs exactly like a "failed" trigger — attempt 1 fires
      // synchronously with reason "connectionStateDisconnected".
      expect(cm.lastTriggerReason).toBe("connectionStateDisconnected");

      // Drain the ladder (createXhomeSession happy-path resumes here since we
      // didn't override it in this test) so afterEach doesn't leak timers.
      channelsByLabel.get("message")?.simulateOpen();
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(ICE_GATHER_WAIT_MS + 600);
      await flushMicrotasks();
      channelsByLabel.get("message")?.simulateOpen();
      await vi.advanceTimersByTimeAsync(300);
      await flushMicrotasks();
    });

    it("disconnect() mid-backoff aborts the ladder without forcing 'failed'", async () => {
      await connectAndSettleChannels();
      vi.mocked(commands.createXhomeSession).mockRejectedValue(new Error("boom"));

      lastPc!.simulateConnectionState("failed");
      expect(cm.state).toBe("reconnecting");

      // Partway through attempt 1's 3s backoff wait, the user disconnects.
      await vi.advanceTimersByTimeAsync(1_000);
      await cm.disconnect();
      expect(cm.state).toBe("idle");

      // Let the in-flight backoff timer fire (2s remaining of the 3s wait);
      // the loop must notice state is no longer "reconnecting" and bail
      // WITHOUT flipping to "failed".
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS - 1_000 + 100);
      await flushMicrotasks();
      expect(cm.state).toBe("idle");
    });

    it("a mid-ladder success resets the attempt counter to 0", async () => {
      await connectAndSettleChannels();

      // Attempt 1 fails (createXhomeSession rejects); attempt 2 succeeds —
      // meaning attempt 2 runs the FULL _createSessionAndStream →
      // _setupWebRTC pipeline again (fresh pc, fresh channels).
      vi.mocked(commands.createXhomeSession)
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue(makeSession({ sessionId: "session-2" }));

      const pcAttempt0 = lastPc!;
      // IMPORTANT: onReconnectAttempt(1, 3) fires SYNCHRONOUSLY inside
      // _reconnect(), at the top of the while loop, BEFORE the first backoff
      // `await` — so it must be observed (or cleared) around the
      // simulateConnectionState() call, not after advancing time past it.
      cbs.onReconnectAttempt.mockClear();
      pcAttempt0.simulateConnectionState("failed");
      expect(cbs.onReconnectAttempt).toHaveBeenCalledWith(1, RECONNECT_MAX_ATTEMPTS);
      cbs.onReconnectAttempt.mockClear();

      // ── Attempt 1's 3s backoff elapses: createXhomeSession rejects, no new pc ──
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS);
      await flushMicrotasks();
      // Attempt 1 failed → loop continues → onReconnectAttempt(2,3) fires
      // synchronously for attempt 2, which then begins its own 6s backoff.
      expect(cbs.onReconnectAttempt).toHaveBeenCalledWith(2, RECONNECT_MAX_ATTEMPTS);
      expect(lastPc).toBe(pcAttempt0); // no new pc was constructed — attempt 1 failed before _setupWebRTC

      // ── Attempt 2's 6s backoff elapses: createXhomeSession succeeds — a
      // full new _setupWebRTC pipeline runs (new pc, new channels,
      // ICE_GATHER_WAIT_MS wait, exchangeSdp, one ICE-poll tick). ──
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS * 2);
      await flushMicrotasks();
      expect(lastPc).not.toBe(pcAttempt0); // attempt 2 constructed a fresh pc

      await vi.advanceTimersByTimeAsync(ICE_GATHER_WAIT_MS + 600); // gather wait + one ICE-poll tick
      await flushMicrotasks();

      // Attempt 2's _createSessionAndStream succeeded; open the (new) message
      // channel so _waitForDataChannels resolves "true" (reconnect success).
      channelsByLabel.get("message")?.simulateOpen();
      await vi.advanceTimersByTimeAsync(300); // past the 250ms _waitForDataChannels poll tick
      await flushMicrotasks();

      // IMPORTANT characterization detail: a successful _reconnect() only
      // resets the attempt counter and returns — it does NOT itself transition
      // state away from "reconnecting" (ConnectionManager.ts:1301-1305). State
      // only leaves "reconnecting" via the dual-track gate + MediaMonitor
      // promoting to "streaming", same as a fresh connect(). _triggerReconnect
      // bails immediately while state === "reconnecting" (1227-1231), so we
      // must drive an actual promotion to "streaming" before the next trigger
      // can prove anything about the attempt counter.
      lastPc!.simulateTrack("video");
      lastPc!.simulateTrack("audio");
      lastPc!.getStats = async () =>
        new Map([
          ["rtp1", { type: "inbound-rtp", kind: "video", framesDecoded: 5, bytesReceived: 1000, timestamp: Date.now() }],
        ]) as unknown as Map<string, unknown>;
      await vi.advanceTimersByTimeAsync(2100); // stats-sampler tick (2000ms) feeds the media-monitor tick (1000ms)
      await flushMicrotasks();
      expect(cm.state).toBe("streaming");

      // A fresh trigger should now start again from attempt 1, proving the
      // counter was reset to 0 by the successful reconnect (had it NOT reset,
      // this trigger would report attempt 3, then immediately fail/"failed").
      // onReconnectAttempt(1,3) fires SYNCHRONOUSLY inside simulateConnectionState
      // (same as the very first trigger above) — assert it right there.
      vi.mocked(commands.createXhomeSession).mockRejectedValue(new Error("boom again"));
      cbs.onReconnectAttempt.mockClear();
      lastPc!.simulateConnectionState("failed");
      expect(cbs.onReconnectAttempt).toHaveBeenCalledWith(1, RECONNECT_MAX_ATTEMPTS);
      expect(cm.state).not.toBe("failed"); // only the trigger itself has happened — not exhausted

      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS);
      await flushMicrotasks();
      expect(cm.state).not.toBe("failed"); // only 1 of 3 attempts consumed — not exhausted

      // Drain the remaining 2 attempts of this final ladder precisely so the
      // manager settles into "failed" and afterEach doesn't leak timers.
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS * 2);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS * 3);
      await flushMicrotasks();
      expect(cm.state).toBe("failed");
    });

    it("an attempt whose message channel never opens within WAIT_FOR_DATA_CHANNELS_MS is logged as failed and the ladder continues", async () => {
      await connectAndSettleChannels();
      cbs.onStateChange.mockClear();

      // createXhomeSession keeps succeeding on every attempt (default happy
      // mock) — the FAILURE mode here is specifically that the new message
      // channel never reaches "open" (we deliberately do NOT call
      // simulateOpen() on it), so _waitForDataChannels times out.
      lastPc!.simulateConnectionState("failed");
      expect(cm.state).toBe("reconnecting");

      // Attempt 1's 3s backoff, then its full _setupWebRTC pipeline runs.
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(ICE_GATHER_WAIT_MS + 600); // gather wait + ICE-poll tick
      await flushMicrotasks();

      // _waitForDataChannels polls every 250ms up to WAIT_FOR_DATA_CHANNELS_MS
      // (15s) — the message channel is left un-opened, so it resolves false.
      cbs.onLog.mockClear();
      await vi.advanceTimersByTimeAsync(WAIT_FOR_DATA_CHANNELS_MS + 300);
      await flushMicrotasks();

      expect(cbs.onLog).toHaveBeenCalledWith(
        expect.stringContaining(
          `Data channels did not open within ${WAIT_FOR_DATA_CHANNELS_MS / 1000}s`,
        ),
      );
      // The ladder continues to attempt 2 rather than giving up after just
      // attempt 1's timeout (still not "failed" — 1 of 3 attempts spent).
      expect(cm.state).toBe("reconnecting");
      expect(cm.state).not.toBe("failed");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Group 3 — Keepalive stop rules
  // ═══════════════════════════════════════════════════════════════════════

  describe("Group 3: keepalive stop rules", () => {
    /** NOTE: despite the group's focus, this only drives to "connecting" (no
     *  tracks fired) — the API keepalive interval is armed regardless of the
     *  dual-track gate, so streaming is not required to exercise it. */
    async function connectAndSettle(): Promise<void> {
      const p = cm.connect(makeConsole());
      await driveConnect(p);
    }

    it("stops the API keepalive interval when sendSessionKeepalive rejects with a '400' error", async () => {
      await connectAndSettle();
      vi.mocked(commands.sendSessionKeepalive).mockRejectedValue(new Error("HTTP 400 Bad Request"));

      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      await flushMicrotasks();
      expect(commands.sendSessionKeepalive).toHaveBeenCalledTimes(1);

      // Interval was cleared — no further sends even after another 30s.
      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      await flushMicrotasks();
      expect(commands.sendSessionKeepalive).toHaveBeenCalledTimes(1);
    });

    it("stops the API keepalive interval when sendSessionKeepalive rejects with 'SessionInUnexpectedState'", async () => {
      await connectAndSettle();
      vi.mocked(commands.sendSessionKeepalive).mockRejectedValue(
        new Error("SessionInUnexpectedState: already streaming"),
      );

      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      await flushMicrotasks();
      expect(commands.sendSessionKeepalive).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      await flushMicrotasks();
      expect(commands.sendSessionKeepalive).toHaveBeenCalledTimes(1);
    });

    it("stops the API keepalive once state === 'streaming', even on an unrelated rejection", async () => {
      await connectAndSettle();

      // Drive to GENUINE "streaming" via the dual-track gate + media
      // watchdog: fire both tracks (arms the watchdog), then make getStats()
      // report an EVER-INCREASING framesDecoded so the watchdog's "flowing"
      // phase sees real progress (a static framesDecoded would look STALLED
      // after MEDIA_STALL_TIMEOUT_MS=8s of "no progress" and itself trigger a
      // reconnect — a real characterization trap this test fell into at first).
      let framesDecoded = 0;
      lastPc!.simulateTrack("video");
      lastPc!.simulateTrack("audio");
      lastPc!.getStats = async () =>
        new Map([
          ["rtp1", { type: "inbound-rtp", kind: "video", framesDecoded: (framesDecoded += 5), bytesReceived: 1000, timestamp: Date.now() }],
        ]) as unknown as Map<string, unknown>;
      await vi.advanceTimersByTimeAsync(2100); // stats-sampler tick (2000ms) feeds the media-monitor tick (1000ms)
      await flushMicrotasks();
      expect(cm.state).toBe("streaming");

      // Now an UNRELATED rejection (no "400"/"SessionInUnexpectedState"
      // substring) should STILL stop the keepalive — the catch-branch's
      // condition is `errStr.includes(...) || this._state === "streaming"`
      // (ConnectionManager.ts:973-977), an OR, so state alone is sufficient.
      vi.mocked(commands.sendSessionKeepalive).mockRejectedValue(
        new Error("unrelated transient network error"),
      );

      // API_KEEPALIVE_MS has already partly elapsed (the driveConnect +
      // dual-track-gate steps above consumed some of the 30s window) —
      // advancing the full API_KEEPALIVE_MS again guarantees crossing the
      // next tick regardless of how much was already consumed.
      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      await flushMicrotasks();
      expect(commands.sendSessionKeepalive).toHaveBeenCalledTimes(1);

      // Interval was cleared — no further sends even after another full window.
      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      await flushMicrotasks();
      expect(commands.sendSessionKeepalive).toHaveBeenCalledTimes(1);
    });

    it("keeps retrying (does NOT stop) on a plain transient failure while not streaming", async () => {
      await connectAndSettle();
      vi.mocked(commands.sendSessionKeepalive).mockRejectedValue(new Error("network blip"));

      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      await flushMicrotasks();
      expect(commands.sendSessionKeepalive).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      await flushMicrotasks();
      expect(commands.sendSessionKeepalive).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(API_KEEPALIVE_MS);
      await flushMicrotasks();
      expect(commands.sendSessionKeepalive).toHaveBeenCalledTimes(3);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Group 4 — Idle warning (byte-level pulse)
  // ═══════════════════════════════════════════════════════════════════════

  describe("Group 4: idle warning micro-pulse", () => {
    async function connectAndOpenChannels(): Promise<void> {
      const p = cm.connect(makeConsole());
      await driveConnect(p);
      channelsByLabel.get("input")?.simulateOpen();
      channelsByLabel.get("message")?.simulateOpen();
    }

    it("sends an immediate 38-byte pulse with LeftThumbX=4096 at byte offset 18, then a recenter frame at +32ms, and arms the 30s interval exactly once", async () => {
      await connectAndOpenChannels();
      const inputCh = channelsByLabel.get("input")!;
      const messageCh = channelsByLabel.get("message")!;

      messageCh.simulateMessage({
        type: "Message",
        target: "/foo/serverInitiatedDisconnect",
        content: JSON.stringify({ reason: "WarningForBeingIdle", secondsUntilKick: 45 }),
        id: "x",
        cv: "",
      });

      // Immediate pulse — sent synchronously inside onIdleWarning.
      expect(inputCh.sent.length).toBe(1);
      const pulse = inputCh.sent[0]!;
      expect(pulse.length).toBe(38);

      const pulseView = new DataView(pulse.buffer, pulse.byteOffset, pulse.byteLength);
      expect(pulseView.getUint16(0, true)).toBe(2); // REPORT_TYPE_GAMEPAD
      expect(pulseView.getUint8(14)).toBe(1); // frameCount
      expect(pulseView.getUint16(16, true)).toBe(0); // buttons: none
      expect(pulseView.getInt16(18, true)).toBe(IDLE_PULSE_LEFT_THUMB_X); // LeftThumbX
      expect(pulseView.getInt16(18, true)).toBe(4096);
      expect(pulseView.getInt16(20, true)).toBe(0); // LeftThumbY
      expect(pulseView.getInt16(22, true)).toBe(0); // RightThumbX
      expect(pulseView.getInt16(24, true)).toBe(0); // RightThumbY

      // Recenter frame at +32ms (IDLE_PULSE_RECENTER_MS) — all-zero after header.
      expect(inputCh.sent.length).toBe(1);
      await vi.advanceTimersByTimeAsync(IDLE_PULSE_RECENTER_MS);
      expect(inputCh.sent.length).toBe(2);
      const recenter = inputCh.sent[1]!;
      expect(recenter.length).toBe(38);
      const recenterView = new DataView(recenter.buffer, recenter.byteOffset, recenter.byteLength);
      expect(recenterView.getInt16(18, true)).toBe(0); // LeftThumbX recentred to 0

      // The periodic 30s idle-keepalive interval is armed — advancing by
      // IDLE_KEEPALIVE_INTERVAL_MS sends exactly one more pulse (not two).
      await vi.advanceTimersByTimeAsync(IDLE_KEEPALIVE_INTERVAL_MS);
      // +1 pulse, then its own +32ms recenter fires within the same window
      // (32ms << 30s), so we expect exactly 2 more sends (pulse + recenter).
      expect(inputCh.sent.length).toBe(4);

      // A second idle-warning message while the interval is already armed
      // must NOT create a SECOND interval (armed "exactly once") — but it
      // DOES still send its own immediate pulse (+ own +32ms recenter),
      // because onIdleWarning always micro-pulses regardless of whether the
      // periodic interval already exists; only the `setInterval` itself is
      // guarded by `if (!this._idleKeepaliveInterval)`.
      messageCh.simulateMessage({
        type: "Message",
        target: "/foo/serverInitiatedDisconnect",
        content: JSON.stringify({ reason: "WarningForBeingIdle", secondsUntilKick: 30 }),
        id: "y",
        cv: "",
      });
      // The second warning's own immediate pulse was sent synchronously above.
      expect(inputCh.sent.length).toBe(5);
      const countAfterSecondWarning = inputCh.sent.length;

      await vi.advanceTimersByTimeAsync(IDLE_KEEPALIVE_INTERVAL_MS);
      // Within this 30s window: (a) the second warning's own pending +32ms
      // recenter fires (+1), (b) the ALREADY-ARMED periodic interval fires
      // once more at +30s (+1 pulse), and (c) THAT pulse's own +32ms recenter
      // also falls inside the same 30s window since 32ms ≪ 30000ms (+1) — so
      // +3 total. Had a SECOND interval been armed, this window would show
      // 2 intervals × 2 frames = +4 instead; the real code arms it once, so
      // the ledger below (+3, not +4) is the actual dispositive assertion.
      expect(inputCh.sent.length).toBe(countAfterSecondWarning + 3);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Group 5 — Guards / races
  // ═══════════════════════════════════════════════════════════════════════

  describe("Group 5: guards and races", () => {
    it("a second connect() while already connecting is ignored (no second session created)", async () => {
      const p1 = cm.connect(makeConsole());
      await flushMicrotasks();
      expect(cm.state).toBe("connecting");

      // p2 hits the duplicate-guard and returns immediately (no awaits) —
      // it resolves on its own without needing driveConnect().
      const p2 = cm.connect(makeConsole());
      await p2;

      // Only ONE createXhomeSession call — the duplicate was ignored outright.
      expect(commands.createXhomeSession).toHaveBeenCalledTimes(1);
      expect(cbs.onLog).toHaveBeenCalledWith(
        expect.stringContaining("Already connecting"),
      );

      // Let p1 (the real, in-flight connect) settle so afterEach is clean.
      await driveConnect(p1);
    });

    it("disconnect() during a connect() await leaves the manager in 'idle', not 'failed'", async () => {
      // Make createXhomeSession hang so we can disconnect mid-await.
      let resolveSession: ((v: StreamConfig) => void) | null = null;
      vi.mocked(commands.createXhomeSession).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSession = resolve;
          }),
      );

      const connectPromise = cm.connect(makeConsole());
      await flushMicrotasks();
      expect(cm.state).toBe("connecting");

      await cm.disconnect();
      expect(cm.state).toBe("idle");

      // Let the stalled createXhomeSession resolve late; connect()'s catch
      // path must NOT stomp "idle" back to "failed" (the state-guard at
      // ConnectionManager.ts's connect() checks state === "connecting").
      // The in-flight connect() is NOT aborted by disconnect() — it keeps
      // running _createSessionAndStream → _setupWebRTC to completion (the pc
      // it builds is simply orphaned since nothing reads it), including the
      // real ICE_GATHER_WAIT_MS timer, so we must drive that timer too or
      // `await connectPromise` never resolves.
      resolveSession!(makeSession());
      await driveConnect(connectPromise);
      expect(cm.state).toBe("idle");
    });

    it("a serverInitiatedDisconnect (non-idle reason) → 'failed' with a consoleDisconnected: reason and does NOT reconnect", async () => {
      const p = cm.connect(makeConsole());
      await driveConnect(p);

      const messageCh = channelsByLabel.get("message")!;
      cbs.onStateChange.mockClear();

      messageCh.simulateMessage({
        type: "Message",
        target: "/foo/serverInitiatedDisconnect",
        content: JSON.stringify({ reason: "KickForBeingIdle" }),
        id: "z",
        cv: "",
      });

      expect(cm.state).toBe("failed");
      expect(cbs.onStateChange).toHaveBeenCalledWith("failed");
      expect(cm.lastTriggerReason).toBe("consoleDisconnected: KickForBeingIdle");

      // No reconnect attempt was started (onReconnectAttempt never called,
      // and createXhomeSession call count stays at exactly 1).
      expect(cbs.onReconnectAttempt).not.toHaveBeenCalled();
      expect(commands.createXhomeSession).toHaveBeenCalledTimes(1);

      // Advancing time confirms no ladder is silently running in the background.
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS * 4);
      expect(commands.createXhomeSession).toHaveBeenCalledTimes(1);
      expect(cm.state).toBe("failed");
    });

    it("control-channel close reconnects ONLY while state === 'streaming'", async () => {
      const p = cm.connect(makeConsole());
      await driveConnect(p);

      // Still in "connecting" (no tracks arrived yet) — a control-channel
      // close here must NOT trigger a reconnect.
      expect(cm.state).toBe("connecting");
      const controlCh1 = channelsByLabel.get("control")!;
      controlCh1.simulateClose();
      await flushMicrotasks();
      expect(commands.createXhomeSession).toHaveBeenCalledTimes(1); // unchanged
      expect(cm.state).toBe("connecting"); // no reconnect ⇒ no state change either

      // Now promote to real "streaming" via the dual-track gate + media
      // watchdog: fire both tracks (arms the watchdog), then make getStats()
      // report a non-zero framesDecoded so the watchdog's next tick promotes.
      lastPc!.simulateTrack("video");
      lastPc!.simulateTrack("audio");
      expect(cm.state).toBe("connecting"); // dual-track arrival alone doesn't promote (Group 6)

      lastPc!.getStats = async () =>
        new Map([
          ["rtp1", { type: "inbound-rtp", kind: "video", framesDecoded: 5, bytesReceived: 1000, timestamp: Date.now() }],
        ]) as unknown as Map<string, unknown>;
      await vi.advanceTimersByTimeAsync(2100); // stats-sampler tick (2000ms) feeds the media-monitor tick (1000ms)
      await flushMicrotasks();
      expect(cm.state).toBe("streaming");

      // NOW a control-channel close on the (same) control channel must
      // trigger a reconnect: createXhomeSession is called again.
      const createCallsBeforeClose = vi.mocked(commands.createXhomeSession).mock.calls.length;
      controlCh1.simulateClose();
      expect(cm.state).toBe("reconnecting"); // _triggerReconnect sets this synchronously

      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS + 100);
      await flushMicrotasks();
      expect(vi.mocked(commands.createXhomeSession).mock.calls.length).toBeGreaterThan(
        createCallsBeforeClose,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Group 6 — Dual-track gate
  // ═══════════════════════════════════════════════════════════════════════

  describe("Group 6: dual-track gate", () => {
    async function connectNormally(): Promise<void> {
      const p = cm.connect(makeConsole());
      await driveConnect(p);
    }

    it("both tracks arriving arms the watchdog but does NOT transition to streaming until MediaMonitor.onMediaStart fires", async () => {
      await connectNormally();
      cbs.onStateChange.mockClear();

      lastPc!.simulateTrack("video");
      expect(cm.state).toBe("connecting"); // one track: not ready yet

      lastPc!.simulateTrack("audio");
      // Both tracks negotiated — watchdog armed, but ontrack itself must NOT
      // set "streaming" (spec §3.10 — ontrack fires before media flows).
      expect(cm.state).toBe("connecting");
      expect(cbs.onStateChange).not.toHaveBeenCalledWith("streaming");

      // Drive the media watchdog's tick via the stats-sampler interval
      // (MEDIA_MONITOR_TICK_MS = 1000ms) with getStats() reporting a
      // non-zero framesDecoded via an inbound-rtp video report, so the
      // watchdog sees real frame progress on its very next tick.
      lastPc!.getStats = async () =>
        new Map([
          [
            "rtp1",
            {
              type: "inbound-rtp",
              kind: "video",
              framesDecoded: 5,
              bytesReceived: 1000,
              timestamp: Date.now(),
            },
          ],
        ]) as unknown as Map<string, unknown>;

      // Advance past the 2000ms stats-sampler tick (populates lastSnapshot)
      // AND the 1000ms media-monitor tick (reads lastSnapshot.framesDecoded).
      await vi.advanceTimersByTimeAsync(2100);
      await flushMicrotasks();

      expect(cm.state).toBe("streaming");
      expect(cbs.onStateChange).toHaveBeenCalledWith("streaming");
    });

    it("audio-only mode transitions to streaming on audio-track arrival alone, with NO watchdog armed", async () => {
      const p = cm.connect(makeConsole(), { audioOnly: true });
      await driveConnect(p);

      cbs.onStateChange.mockClear();

      lastPc!.simulateTrack("audio");
      // Audio-only: streaming immediately on the audio track, no watchdog wait.
      expect(cm.state).toBe("streaming");
      expect(cbs.onStateChange).toHaveBeenCalledWith("streaming");

      // Confirm no watchdog is running: even if getStats() never reports
      // framesDecoded, advancing well past the start-timeout must NOT
      // trigger a "mediaNeverStarted" reconnect (state stays "streaming").
      await vi.advanceTimersByTimeAsync(15_000);
      expect(cm.state).toBe("streaming");
      expect(commands.createXhomeSession).toHaveBeenCalledTimes(1); // no reconnect fired
    });
  });
});
