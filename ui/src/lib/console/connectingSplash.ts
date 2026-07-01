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

export type StepStatus = "done" | "active" | "pending" | "na";

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
  /** Audio-only: no video track is negotiated, so the video step is N/A. */
  audioOnly?: boolean;
}

export function connectingSteps({
  handshakeComplete,
  videoArrived,
  audioOnly = false,
}: ConnectingProgress): ConnectingSteps {
  return {
    session: "done",
    handshake: handshakeComplete ? "done" : "active",
    // Audio-only never negotiates video, so the step is grayed out rather than
    // left forever "active"/"pending" (it can never complete).
    video: audioOnly
      ? "na"
      : videoArrived
        ? "done"
        : handshakeComplete
          ? "active"
          : "pending",
  };
}

export function shouldShowSplash(state: SessionState, videoPlaying: boolean): boolean {
  if (videoPlaying) return false;
  return state === "connecting" || state === "reconnecting" || state === "streaming";
}
