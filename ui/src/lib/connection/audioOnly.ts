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
