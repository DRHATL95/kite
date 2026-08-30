/**
 * Pure decisions for audio-only mode. Kept separate from ConnectionManager so
 * the WebRTC negotiation/transition rules are unit-testable without a
 * RTCPeerConnection (matches the encodedTapLogic / authFlowLogic pattern).
 */

/** Video transceiver direction for the offer: declined when audio-only. */
export function videoTransceiverDirection(
  audioOnly: boolean,
): "inactive" | "recvonly" {
  return audioOnly ? "inactive" : "recvonly";
}

/**
 * Whether enough tracks have arrived to promote to "streaming". Normal mode
 * waits for BOTH tracks (then a decoded-frame watchdog promotes on first frame);
 * audio-only waits for audio only, since no video track is ever negotiated.
 */
export function tracksReadyToStream(
  audioOnly: boolean,
  hasVideo: boolean,
  hasAudio: boolean,
): boolean {
  return audioOnly ? hasAudio : hasVideo && hasAudio;
}

/** The audio-only panel shows when the stream is audio-only OR video is hidden. */
export function audioViewActive(audioOnly: boolean, videoHidden: boolean): boolean {
  return audioOnly || videoHidden;
}

/** Video-only controls (Immersive / Fix Video / Clip) are meaningful only when a
 *  video track exists AND is not hidden. */
export function videoControlsActive(audioOnly: boolean, videoHidden: boolean): boolean {
  return !audioOnly && !videoHidden;
}

/** Duck-typed receiver so this is testable without a real RTCPeerConnection. */
type VideoToggleReceiver = { track?: { kind: string; enabled: boolean } | null };

/**
 * Enable/disable the video receiver's track (decode on/off). Mutates the found
 * receiver's `track.enabled`; returns true iff a video track was present.
 * ConnectionManager calls this with `pc.getReceivers()`.
 */
export function setVideoReceiverEnabled(
  receivers: readonly VideoToggleReceiver[],
  enabled: boolean,
): boolean {
  const r = receivers.find((rx) => rx.track?.kind === "video");
  if (r?.track) {
    r.track.enabled = enabled;
    return true;
  }
  return false;
}
