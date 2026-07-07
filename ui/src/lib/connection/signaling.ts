/**
 * signaling.ts — stateless xHome ICE/SDP signaling functions for
 * ConnectionManager (Task 3 of the ConnectionManager decomposition, see
 * docs/superpowers/specs/2026-07-06-connectionmanager-refactor-design.md
 * §signaling.ts).
 *
 * Extracted verbatim from ConnectionManager._setupWebRTC's ICE-servers block
 * (formerly ConnectionManager.ts ~414-455), the SDP-exchange sequence inline
 * in _setupWebRTC (formerly ~560-585), _setupIceHandling (formerly ~817-841),
 * and _pollForIceCandidates (formerly ~853-906). No state persists between
 * calls — these are plain functions, not a controller/class, because nothing
 * needs to survive across invocations the way KeepaliveController's timers do.
 *
 * This module is STANDALONE — it does NOT import ConnectionManager. IPC calls
 * (getIceServers/exchangeSdp/sendIceCandidate/pollIceCandidates) are imported
 * directly (mocked via `vi.mock` in tests, matching keepalive.ts); live WebRTC
 * objects (RTCPeerConnection) are passed in by the caller. Manager-owned state
 * (session path, "which pc is still live") crosses the seam as either a plain
 * parameter (session path never changes mid-call) or, for the ICE-poll loop
 * specifically, a `getPc` THUNK — see pollRemoteIceCandidates for why.
 *
 * Source of truth for behaviour: ui/public/app.js (ConnectionManager class).
 */

import {
  getIceServers,
  exchangeSdp,
  sendIceCandidate,
  pollIceCandidates,
} from "../ipc/commands.js";

import { ICE_GATHER_WAIT_MS, ICE_POLL_MAX_ATTEMPTS, ICE_POLL_INTERVAL_MS } from "./constants.js";
import { applyVideoBitrateCap } from "./sdpBitrate.js";

import type { IceServer } from "../ipc/types.js";

/** ICE server provenance — matches ConnectionManager's `_iceSource` field type. */
export type IceSource = "xbox-provided" | "fallback-only";

/** Result of resolveIceServers(): the RTCIceServer list plus provenance for diagnostics. */
export interface ResolvedIceServers {
  iceServers: RTCIceServer[];
  stunCount: number;
  turnCount: number;
  source: IceSource;
}

/** Result of pollRemoteIceCandidates(): how many remote candidates were added and how many poll ticks were used. */
export interface IcePollResult {
  added: number;
  attemptsUsed: number;
}

/**
 * Resolve the ICE server list for a session: try the xHome getIceServers API,
 * falling back to a public STUN-only list on empty response or error. Also
 * counts STUN vs TURN URLs for diagnostics (spec §5 ICE server provenance).
 *
 * Formerly ConnectionManager._setupWebRTC's ICE-servers block; app.js:212-232.
 */
export async function resolveIceServers(
  sessionPath: string,
  log: (msg: string) => void,
): Promise<ResolvedIceServers> {
  // Fallback STUN list matches app.js:213-217
  let iceServers: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.services.mozilla.com" },
  ];
  let source: IceSource = "fallback-only";
  let stunCount = 3;
  let turnCount = 0;

  try {
    const serverIceConfig: IceServer[] = await getIceServers(sessionPath);
    if (serverIceConfig && serverIceConfig.length > 0) {
      iceServers = serverIceConfig.map((s) => ({
        urls: s.urls,
        username: s.username,
        credential: s.credential,
      }));
      source = "xbox-provided";

      // Count STUN vs TURN for diagnostics (spec §5 ICE server provenance)
      stunCount = 0;
      turnCount = 0;
      for (const s of serverIceConfig) {
        const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
        for (const u of urls) {
          if (u.startsWith("turn:") || u.startsWith("turns:")) turnCount++;
          else stunCount++;
        }
      }
      log("ICE servers: " + JSON.stringify(iceServers));
    }
  } catch (e) {
    log("Failed to get ICE servers: " + String(e));
  }

  return { iceServers, stunCount, turnCount, source };
}

/**
 * Wire onicecandidate to forward local candidates to the xHome API.
 *
 * Formerly ConnectionManager._setupIceHandling; app.js:740-760.
 */
export function wireLocalIceForwarding(
  pc: RTCPeerConnection,
  sessionPath: string,
  log: (msg: string) => void,
): void {
  pc.onicecandidate = async (event: RTCPeerConnectionIceEvent) => {
    if (event.candidate) {
      log(`Local ICE: ${event.candidate.candidate.substring(0, 50)}...`);
      try {
        await sendIceCandidate(sessionPath, JSON.stringify(event.candidate));
      } catch (error) {
        log("Failed to send ICE: " + String(error));
      }
    } else {
      log("ICE gathering complete");
    }
  };

  pc.onicegatheringstatechange = () => {
    log(`ICE gathering state: ${pc.iceGatheringState}`);
  };
}

/**
 * Run the SDP offer/answer exchange with the xHome API in the EXACT order
 * required (spec §3.3): createOffer → applyVideoBitrateCap → setLocalDescription
 * → a fixed ICE_GATHER_WAIT_MS sleep (gives the local ICE agent time to gather
 * candidates before we send the offer) → exchangeSdp → setRemoteDescription.
 *
 * Formerly inline in ConnectionManager._setupWebRTC; app.js:269-287.
 */
export async function runSdpExchange(
  pc: RTCPeerConnection,
  sessionPath: string,
  maxBitrateKbps: number | null,
  log: (msg: string) => void,
): Promise<void> {
  // ── Create offer — app.js:269-274 ───────────────────────────────────────
  const offer = await pc.createOffer();
  if (offer.sdp) {
    // In audio-only mode the video transceiver direction is "inactive" (see
    // videoTransceiverDirection), so this cap lands on an inactive m-line and
    // is inert — a harmless no-op, no guard needed here.
    offer.sdp = applyVideoBitrateCap(offer.sdp, maxBitrateKbps);
  }
  log(`Created SDP offer (${offer.sdp?.length ?? 0} bytes)`);
  await pc.setLocalDescription(offer);

  // Fixed ICE gather wait — spec §3.3, app.js:274 (ICE_GATHER_WAIT_MS = 1000)
  await new Promise<void>((r) => setTimeout(r, ICE_GATHER_WAIT_MS));

  // ── SDP exchange — app.js:277-287 ───────────────────────────────────────
  const sdpAnswer: string = await exchangeSdp(sessionPath, pc.localDescription!.sdp);
  log(`Got SDP answer (${sdpAnswer.length} bytes)`);

  await pc.setRemoteDescription({ type: "answer", sdp: sdpAnswer });
  log("Set remote description OK");
}

/**
 * Poll xHome for server ICE candidates and add them to the peer connection.
 *
 * Takes a `getPc` THUNK, not a `pc` parameter: the loop condition
 * `while (attempts < ICE_POLL_MAX_ATTEMPTS && getPc())` is a LIVENESS check
 * against the manager's cleanup nulling its `_pc` field mid-poll — a captured
 * `pc` parameter would silently change that late-binding behaviour (the #1
 * behaviour-preservation risk per the design spec's seam rules).
 *
 * Formerly ConnectionManager._pollForIceCandidates; app.js:763-813.
 * spec §3.11: up to ICE_POLL_MAX_ATTEMPTS × ICE_POLL_INTERVAL_MS
 */
export async function pollRemoteIceCandidates(
  getPc: () => RTCPeerConnection | null,
  sessionPath: string,
  log: (msg: string) => void,
): Promise<IcePollResult> {
  let attempts = 0;
  let totalCandidates = 0;

  log("Starting ICE candidate polling...");

  while (attempts < ICE_POLL_MAX_ATTEMPTS && getPc()) {
    try {
      const candidates = await pollIceCandidates(sessionPath);

      // Re-read getPc() fresh after the await (matches the original's
      // `this._pc.addIceCandidate(...)` / `this._pc.iceConnectionState`,
      // which each re-read the live field rather than a value captured
      // before the await). If cleanup nulled the connection while
      // pollIceCandidates() was in flight, this throws — caught by the
      // outer catch below and logged, exactly like the original's implicit
      // null-property-access TypeError would be.
      if (candidates && candidates.length > 0) {
        log(`Got ${candidates.length} remote ICE candidates`);
        for (const candidateObj of candidates) {
          const candidateStr = candidateObj.candidate.trim();
          try {
            await getPc()!.addIceCandidate(
              new RTCIceCandidate({
                candidate: candidateStr,
                sdpMid: candidateObj.sdpMid,
                sdpMLineIndex: candidateObj.sdpMLineIndex,
              }),
            );
            totalCandidates++;
          } catch (e) {
            log("Failed to add ICE: " + (e instanceof Error ? e.message : String(e)));
          }
        }
      }

      const iceState = getPc()!.iceConnectionState;
      if (iceState === "connected" || iceState === "completed") {
        log("*** ICE CONNECTED ***");
        break;
      }
      if (iceState === "failed") {
        log("*** ICE FAILED ***");
        break;
      }
    } catch (error) {
      log("Error polling ICE: " + String(error));
    }

    attempts++;
    await new Promise<void>((r) => setTimeout(r, ICE_POLL_INTERVAL_MS));
  }

  log(`ICE polling done. Added ${totalCandidates} candidates`);
  return { added: totalCandidates, attemptsUsed: attempts };
}
