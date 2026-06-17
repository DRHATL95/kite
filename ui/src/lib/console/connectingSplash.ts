/**
 * connectingSplash.ts — Pure logic for the connecting splash overlay.
 *
 * `connectingSteps` derives the three step indicators (session → handshake →
 * video) from real, observable signals — never faked. The REST session already
 * exists by the time the splash shows (it produced the SDP offer), so `session`
 * is always done; `handshake` tracks data-channel handshake completion and
 * `video` tracks first-frame arrival.
 *
 * `shouldShowSplash` decides visibility: shown from connect start until the
 * <video> element is actually playing.
 */
import type { SessionState } from "../connection/types.js";

export type StepStatus = "done" | "active" | "pending";

export interface ConnectingSteps {
  session: StepStatus;
  handshake: StepStatus;
  video: StepStatus;
}

export interface ConnectingProgress {
  /** True once the data-channel handshake has completed (handshakeMs set). */
  handshakeComplete: boolean;
  /** True once the first video track has arrived (videoArrivedAt set). */
  videoArrived: boolean;
}

export function connectingSteps({
  handshakeComplete,
  videoArrived,
}: ConnectingProgress): ConnectingSteps {
  return {
    session: "done",
    handshake: handshakeComplete ? "done" : "active",
    video: videoArrived ? "done" : handshakeComplete ? "active" : "pending",
  };
}

export function shouldShowSplash(state: SessionState, videoPlaying: boolean): boolean {
  if (videoPlaying) return false;
  return state === "connecting" || state === "reconnecting" || state === "streaming";
}
