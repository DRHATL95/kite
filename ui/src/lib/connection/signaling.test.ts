/**
 * signaling.test.ts — TDD for the stateless signaling functions (Task 3 of the
 * ConnectionManager decomposition, see
 * docs/superpowers/specs/2026-07-06-connectionmanager-refactor-design.md).
 *
 * Pins the behaviour extracted verbatim from ConnectionManager's ICE-server
 * resolution (formerly _setupWebRTC's ICE-servers block), _setupIceHandling
 * (local candidate forwarding), the SDP-exchange sequence inline in
 * _setupWebRTC (createOffer → applyVideoBitrateCap → setLocalDescription →
 * ICE_GATHER_WAIT_MS wait → exchangeSdp → setRemoteDescription), and
 * _pollForIceCandidates (remote candidate polling). Every assertion here is
 * cross-checked against ConnectionManager.test.ts Group 1 ("connect
 * ordering"), which exercises the identical behaviour through the full
 * manager and must stay green unmodified — this file is the focused unit-test
 * counterpart.
 *
 * Mocking recipe copied from keepalive.test.ts / ConnectionManager.test.ts:
 * `vi.mock("../ipc/commands.js")` BEFORE importing the module under test,
 * `vi.useFakeTimers()` in beforeEach, `vi.useRealTimers()` in afterEach.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock the IPC commands module before importing signaling.ts ─────────────
vi.mock("../ipc/commands.js", () => ({
  getIceServers: vi.fn(),
  exchangeSdp: vi.fn(),
  sendIceCandidate: vi.fn(),
  pollIceCandidates: vi.fn(),
}));

// ── Import AFTER mock registration ──────────────────────────────────────────
import * as commands from "../ipc/commands.js";
import {
  resolveIceServers,
  wireLocalIceForwarding,
  runSdpExchange,
  pollRemoteIceCandidates,
} from "./signaling.js";
import { ICE_GATHER_WAIT_MS, ICE_POLL_INTERVAL_MS, ICE_POLL_MAX_ATTEMPTS } from "./constants.js";
import type { IceServer, IceCandidate } from "../ipc/types.js";

const SESSION_PATH = "/v5/sessions/home/server-abc/session-1";

function makeLog(): { log: (msg: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (msg: string) => lines.push(msg), lines };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake RTCPeerConnection — minimal duck-typed surface used by signaling.ts
// ─────────────────────────────────────────────────────────────────────────────

type CallRecord = { method: string; args: unknown[] };

class FakePeerConnection {
  calls: CallRecord[] = [];
  localDescription: { type: string; sdp: string } | null = null;
  iceConnectionState: RTCIceConnectionState = "new";
  onicecandidate: ((ev: { candidate: unknown }) => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;

  private _offerSdp =
    "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n" +
    "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\n" +
    "m=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\n";

  async createOffer(): Promise<{ type: string; sdp: string }> {
    this.calls.push({ method: "createOffer", args: [] });
    return { type: "offer", sdp: this._offerSdp };
  }

  async setLocalDescription(desc: { type: string; sdp: string }): Promise<void> {
    this.calls.push({ method: "setLocalDescription", args: [desc] });
    this.localDescription = desc;
  }

  async setRemoteDescription(desc: { type: string; sdp: string }): Promise<void> {
    this.calls.push({ method: "setRemoteDescription", args: [desc] });
  }

  async addIceCandidate(candidate: unknown): Promise<void> {
    this.calls.push({ method: "addIceCandidate", args: [candidate] });
  }

  methodOrder(): string[] {
    return this.calls.map((c) => c.method);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
let savedRTCIceCandidate: unknown;

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

beforeEach(() => {
  vi.useFakeTimers();
  savedRTCIceCandidate = g.RTCIceCandidate;
  g.RTCIceCandidate = FakeRTCIceCandidate;
});

afterEach(() => {
  g.RTCIceCandidate = savedRTCIceCandidate;
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveIceServers()
// ═══════════════════════════════════════════════════════════════════════════

describe("resolveIceServers()", () => {
  it("returns the fallback STUN list with stunCount=3/turnCount=0/source='fallback-only' when the API returns an empty array", async () => {
    vi.mocked(commands.getIceServers).mockResolvedValue([]);
    const { log } = makeLog();

    const result = await resolveIceServers(SESSION_PATH, log);

    expect(result.iceServers).toEqual([
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun.services.mozilla.com" },
    ]);
    expect(result.stunCount).toBe(3);
    expect(result.turnCount).toBe(0);
    expect(result.source).toBe("fallback-only");
  });

  it("falls back to the STUN list when getIceServers() rejects", async () => {
    vi.mocked(commands.getIceServers).mockRejectedValue(new Error("network down"));
    const { log, lines } = makeLog();

    const result = await resolveIceServers(SESSION_PATH, log);

    expect(result.iceServers.length).toBe(3);
    expect(result.stunCount).toBe(3);
    expect(result.turnCount).toBe(0);
    expect(result.source).toBe("fallback-only");
    expect(lines.some((l) => l.includes("Failed to get ICE servers"))).toBe(true);
  });

  it("uses the xbox-provided servers and counts stun vs turn correctly when the API returns entries", async () => {
    const serverIceConfig: IceServer[] = [
      { urls: "turn:turn.example.com:3478", username: "u", credential: "c" },
      { urls: ["stun:stun.example.com:3478", "turns:turns.example.com:5349"], username: "u2", credential: "c2" },
    ];
    vi.mocked(commands.getIceServers).mockResolvedValue(serverIceConfig);
    const { log } = makeLog();

    const result = await resolveIceServers(SESSION_PATH, log);

    // First entry: single "turn:" url → turnCount 1.
    // Second entry: one "stun:" + one "turns:" url → stunCount 1, turnCount 1.
    expect(result.turnCount).toBe(2);
    expect(result.stunCount).toBe(1);
    expect(result.source).toBe("xbox-provided");
    expect(result.iceServers).toEqual([
      { urls: "turn:turn.example.com:3478", username: "u", credential: "c" },
      { urls: ["stun:stun.example.com:3478", "turns:turns.example.com:5349"], username: "u2", credential: "c2" },
    ]);
  });

  it("calls getIceServers() with the given sessionPath", async () => {
    vi.mocked(commands.getIceServers).mockResolvedValue([]);
    await resolveIceServers(SESSION_PATH, () => {});
    expect(commands.getIceServers).toHaveBeenCalledWith(SESSION_PATH);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// wireLocalIceForwarding()
// ═══════════════════════════════════════════════════════════════════════════

describe("wireLocalIceForwarding()", () => {
  it("forwards a local candidate to sendIceCandidate() as a JSON-stringified string", async () => {
    vi.mocked(commands.sendIceCandidate).mockResolvedValue(undefined);
    const pc = new FakePeerConnection();
    const { log } = makeLog();

    wireLocalIceForwarding(pc as unknown as RTCPeerConnection, SESSION_PATH, log);

    const candidate = { candidate: "candidate:1 1 UDP 12345 1.2.3.4 5000 typ host" };
    await pc.onicecandidate!({ candidate });
    // Flush the async onicecandidate handler's own microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(commands.sendIceCandidate).toHaveBeenCalledWith(
      SESSION_PATH,
      JSON.stringify(candidate),
    );
  });

  it("logs 'ICE gathering complete' without calling sendIceCandidate() when candidate is null", async () => {
    const pc = new FakePeerConnection();
    const { log, lines } = makeLog();

    wireLocalIceForwarding(pc as unknown as RTCPeerConnection, SESSION_PATH, log);

    await pc.onicecandidate!({ candidate: null });

    expect(commands.sendIceCandidate).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes("ICE gathering complete"))).toBe(true);
  });

  it("logs (and does not throw) when sendIceCandidate() rejects", async () => {
    vi.mocked(commands.sendIceCandidate).mockRejectedValue(new Error("send failed"));
    const pc = new FakePeerConnection();
    const { log, lines } = makeLog();

    wireLocalIceForwarding(pc as unknown as RTCPeerConnection, SESSION_PATH, log);

    const candidate = { candidate: "candidate:1 1 UDP 12345 1.2.3.4 5000 typ host" };
    await expect(pc.onicecandidate!({ candidate })).resolves.toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();

    expect(lines.some((l) => l.includes("Failed to send ICE"))).toBe(true);
  });

  it("logs the ICE gathering state on onicegatheringstatechange", () => {
    const pc = new FakePeerConnection();
    pc.iceConnectionState = "new";
    (pc as unknown as { iceGatheringState: string }).iceGatheringState = "gathering";
    const { log, lines } = makeLog();

    wireLocalIceForwarding(pc as unknown as RTCPeerConnection, SESSION_PATH, log);
    pc.onicegatheringstatechange!();

    expect(lines.some((l) => l.includes("ICE gathering state: gathering"))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runSdpExchange()
// ═══════════════════════════════════════════════════════════════════════════

describe("runSdpExchange()", () => {
  it("calls createOffer → setLocalDescription → (+ICE_GATHER_WAIT_MS) → exchangeSdp → setRemoteDescription in exact order", async () => {
    vi.mocked(commands.exchangeSdp).mockResolvedValue(
      "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n",
    );
    const pc = new FakePeerConnection();
    const { log } = makeLog();

    const promise = runSdpExchange(pc as unknown as RTCPeerConnection, SESSION_PATH, null, log);

    // Let createOffer/setLocalDescription's microtasks run before the fixed wait.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(pc.methodOrder()).toEqual(["createOffer", "setLocalDescription"]);
    expect(commands.exchangeSdp).not.toHaveBeenCalled();

    // Advancing less than the full wait must not fire the exchange yet.
    await vi.advanceTimersByTimeAsync(ICE_GATHER_WAIT_MS - 100);
    expect(commands.exchangeSdp).not.toHaveBeenCalled();

    // Crossing the threshold fires exchangeSdp, then setRemoteDescription.
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(commands.exchangeSdp).toHaveBeenCalledWith(
      SESSION_PATH,
      expect.any(String),
    );
    expect(pc.methodOrder()).toEqual([
      "createOffer",
      "setLocalDescription",
      "setRemoteDescription",
    ]);
  });

  it("applies the video bitrate cap to the offer SDP before setLocalDescription when maxBitrateKbps is set", async () => {
    vi.mocked(commands.exchangeSdp).mockResolvedValue("v=0\r\n");
    const pc = new FakePeerConnection();
    const { log } = makeLog();

    const promise = runSdpExchange(pc as unknown as RTCPeerConnection, SESSION_PATH, 5000, log);
    await vi.advanceTimersByTimeAsync(ICE_GATHER_WAIT_MS + 100);
    await promise;

    const localDescCall = pc.calls.find((c) => c.method === "setLocalDescription");
    const desc = localDescCall!.args[0] as { sdp: string };
    expect(desc.sdp).toContain("b=AS:5000");
    expect(desc.sdp).toContain("b=TIAS:5000000");
  });

  it("passes the offer through unchanged when maxBitrateKbps is null (Auto)", async () => {
    vi.mocked(commands.exchangeSdp).mockResolvedValue("v=0\r\n");
    const pc = new FakePeerConnection();
    const { log } = makeLog();

    const promise = runSdpExchange(pc as unknown as RTCPeerConnection, SESSION_PATH, null, log);
    await vi.advanceTimersByTimeAsync(ICE_GATHER_WAIT_MS + 100);
    await promise;

    const localDescCall = pc.calls.find((c) => c.method === "setLocalDescription");
    const desc = localDescCall!.args[0] as { sdp: string };
    expect(desc.sdp).not.toContain("b=AS:");
    expect(desc.sdp).not.toContain("b=TIAS:");
  });

  it("passes pc.localDescription!.sdp (not the pre-mutation offer variable) to exchangeSdp", async () => {
    vi.mocked(commands.exchangeSdp).mockResolvedValue("v=0\r\n");
    const pc = new FakePeerConnection();
    const { log } = makeLog();

    const promise = runSdpExchange(pc as unknown as RTCPeerConnection, SESSION_PATH, 3000, log);
    await vi.advanceTimersByTimeAsync(ICE_GATHER_WAIT_MS + 100);
    await promise;

    const sentSdp = vi.mocked(commands.exchangeSdp).mock.calls[0]![1];
    expect(sentSdp).toBe(pc.localDescription!.sdp);
    expect(sentSdp).toContain("b=AS:3000");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// pollRemoteIceCandidates()
// ═══════════════════════════════════════════════════════════════════════════

describe("pollRemoteIceCandidates()", () => {
  it("adds candidates from the poll tick and stops once iceConnectionState reaches 'connected'", async () => {
    const pc = new FakePeerConnection();
    vi.mocked(commands.pollIceCandidates).mockImplementation(async () => {
      pc.iceConnectionState = "connected";
      return [
        { candidate: "candidate:1 1 UDP 1 1.2.3.4 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 },
      ] as IceCandidate[];
    });
    const { log } = makeLog();

    // NOTE on attemptsUsed=0: `attempts++` and the ICE_POLL_INTERVAL_MS wait
    // only execute on a NON-breaking loop iteration (verbatim from
    // ConnectionManager.ts's `_pollForIceCandidates` — attempts++ sits AFTER
    // the connected/completed/failed break checks). Connecting on the very
    // first tick breaks before that increment ever runs.
    const result = await pollRemoteIceCandidates(() => pc as unknown as RTCPeerConnection, SESSION_PATH, log);

    expect(result.added).toBe(1);
    expect(result.attemptsUsed).toBe(0);
    expect(pc.calls.some((c) => c.method === "addIceCandidate")).toBe(true);
  });

  it("stops once iceConnectionState reaches 'completed'", async () => {
    const pc = new FakePeerConnection();
    vi.mocked(commands.pollIceCandidates).mockImplementation(async () => {
      pc.iceConnectionState = "completed";
      return [];
    });
    const { log } = makeLog();

    const result = await pollRemoteIceCandidates(() => pc as unknown as RTCPeerConnection, SESSION_PATH, log);

    expect(result.attemptsUsed).toBe(0);
  });

  it("stops immediately (without any interval wait) once iceConnectionState reaches 'failed'", async () => {
    const pc = new FakePeerConnection();
    vi.mocked(commands.pollIceCandidates).mockImplementation(async () => {
      pc.iceConnectionState = "failed";
      return [];
    });
    const { log } = makeLog();

    const result = await pollRemoteIceCandidates(() => pc as unknown as RTCPeerConnection, SESSION_PATH, log);

    expect(result.attemptsUsed).toBe(0);
    // No ICE_POLL_INTERVAL_MS wait was needed to resolve — the promise
    // settles from a single microtask-only tick, proving the loop broke
    // before reaching the `attempts++` / setTimeout at the bottom.
    expect(commands.pollIceCandidates).toHaveBeenCalledTimes(1);
  });

  it("LIVENESS: stops polling as soon as getPc() returns null mid-loop, without a captured pc reference", async () => {
    const pc = new FakePeerConnection();
    let tickCount = 0;
    let live = true;
    vi.mocked(commands.pollIceCandidates).mockImplementation(async () => {
      tickCount++;
      // Never resolve to "connected"/"failed" — the ONLY way this loop exits
      // (short of ICE_POLL_MAX_ATTEMPTS) is the getPc() liveness check.
      return [];
    });
    const { log } = makeLog();

    // getPc() thunk: live for the first 2 ticks, then simulates cleanup
    // nulling the connection mid-poll.
    const getPc = (): RTCPeerConnection | null =>
      live ? (pc as unknown as RTCPeerConnection) : null;

    const promise = pollRemoteIceCandidates(getPc, SESSION_PATH, log);

    // Tick 1's pollIceCandidates() call resolves on a microtask (no timer
    // needed) — flush microtasks to observe it before any fake time passes.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(tickCount).toBe(1);

    // Tick 1 didn't break (iceConnectionState never reached a terminal
    // value), so the loop falls through to `attempts++` then waits
    // ICE_POLL_INTERVAL_MS before re-checking `getPc()` and starting tick 2.
    // Flip `live = false` DURING that wait, before the loop's next
    // getPc()-truthiness check — this is the liveness property under test:
    // the loop must consult getPc() itself at that check, not a value
    // captured when pollRemoteIceCandidates() was first called.
    live = false;
    await vi.advanceTimersByTimeAsync(ICE_POLL_INTERVAL_MS + 50);
    const result = await promise;

    expect(tickCount).toBe(1); // no second tick — the loop condition saw getPc() === null
    expect(result.attemptsUsed).toBe(1);
  });

  it("tolerates an addIceCandidate() failure for one candidate and still counts/adds the rest", async () => {
    const pc = new FakePeerConnection();
    const originalAdd = pc.addIceCandidate.bind(pc);
    let call = 0;
    pc.addIceCandidate = async (candidate: unknown) => {
      call++;
      if (call === 1) throw new Error("bad candidate");
      return originalAdd(candidate);
    };
    vi.mocked(commands.pollIceCandidates).mockImplementation(async () => {
      pc.iceConnectionState = "connected";
      return [
        { candidate: "candidate:1 1 UDP 1 1.1.1.1 1 typ host", sdpMid: "0", sdpMLineIndex: 0 },
        { candidate: "candidate:2 1 UDP 1 2.2.2.2 2 typ host", sdpMid: "0", sdpMLineIndex: 0 },
      ] as IceCandidate[];
    });
    const { log, lines } = makeLog();

    const promise = pollRemoteIceCandidates(() => pc as unknown as RTCPeerConnection, SESSION_PATH, log);
    await vi.advanceTimersByTimeAsync(ICE_POLL_INTERVAL_MS + 100);
    const result = await promise;

    // Only the SECOND candidate succeeded — the first's failure did not stop
    // the loop or the count of successfully-added candidates.
    expect(result.added).toBe(1);
    expect(lines.some((l) => l.includes("Failed to add ICE"))).toBe(true);
  });

  it("tolerates a pollIceCandidates() rejection for one tick and continues to the next", async () => {
    const pc = new FakePeerConnection();
    let call = 0;
    vi.mocked(commands.pollIceCandidates).mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error("poll failed");
      pc.iceConnectionState = "connected";
      return [];
    });
    const { log, lines } = makeLog();

    const promise = pollRemoteIceCandidates(() => pc as unknown as RTCPeerConnection, SESSION_PATH, log);
    await vi.advanceTimersByTimeAsync(ICE_POLL_INTERVAL_MS * 2 + 100);
    const result = await promise;

    // Tick 1 rejects (caught) → falls through to `attempts++` (now 1) → waits
    // ICE_POLL_INTERVAL_MS → tick 2 connects and breaks WITHOUT incrementing
    // again, so attemptsUsed is 1 (not 2) — verbatim from the original
    // _pollForIceCandidates where attempts++ sits after the break checks.
    expect(result.attemptsUsed).toBe(1);
    expect(commands.pollIceCandidates).toHaveBeenCalledTimes(2);
    expect(lines.some((l) => l.includes("Error polling ICE"))).toBe(true);
  });

  it("gives up after ICE_POLL_MAX_ATTEMPTS ticks when ICE never connects/fails", async () => {
    const pc = new FakePeerConnection();
    vi.mocked(commands.pollIceCandidates).mockResolvedValue([]);
    const { log } = makeLog();

    const promise = pollRemoteIceCandidates(() => pc as unknown as RTCPeerConnection, SESSION_PATH, log);
    await vi.advanceTimersByTimeAsync(ICE_POLL_INTERVAL_MS * ICE_POLL_MAX_ATTEMPTS + 500);
    const result = await promise;

    expect(result.attemptsUsed).toBe(ICE_POLL_MAX_ATTEMPTS);
    expect(commands.pollIceCandidates).toHaveBeenCalledTimes(ICE_POLL_MAX_ATTEMPTS);
  });

  it("calls pollIceCandidates() with the given sessionPath on every tick", async () => {
    const pc = new FakePeerConnection();
    vi.mocked(commands.pollIceCandidates).mockImplementation(async () => {
      pc.iceConnectionState = "connected";
      return [];
    });
    const { log } = makeLog();

    const promise = pollRemoteIceCandidates(() => pc as unknown as RTCPeerConnection, SESSION_PATH, log);
    await vi.advanceTimersByTimeAsync(ICE_POLL_INTERVAL_MS + 100);
    await promise;

    expect(commands.pollIceCandidates).toHaveBeenCalledWith(SESSION_PATH);
  });

  it("returns attemptsUsed=0 and added=0 if getPc() is already null on the very first check", async () => {
    const { log } = makeLog();
    const result = await pollRemoteIceCandidates(() => null, SESSION_PATH, log);

    expect(result.added).toBe(0);
    expect(result.attemptsUsed).toBe(0);
    expect(commands.pollIceCandidates).not.toHaveBeenCalled();
  });
});
