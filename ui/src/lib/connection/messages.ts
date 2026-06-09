/**
 * messages.ts — Xbox Remote wire-protocol message types
 *
 * TypeScript shapes for every JSON message sent or received over the
 * WebRTC data channels.  All field names / values are taken verbatim from
 * ui/public/app.js — do NOT change them without also verifying against the
 * reference implementation (xbox-xcloud-player).
 */

// ─────────────────────────────────────────────────────────────
// Message channel — outbound
// ─────────────────────────────────────────────────────────────

/**
 * First message sent on the message channel after it opens.
 * Xbox responds with HandshakeAck.
 *
 * app.js:457-464 (_sendMessageHandshake)
 */
export interface HandshakeMessage {
  type: "Handshake";
  version: string;  // "messageV1"
  id: string;       // "be0bfc6d-1e83-4c8a-90ed-fa8601c5a179"
  cv: string;       // "0"
}

/**
 * Config / property message sent on the message channel after HandshakeAck.
 * Wraps a JSON-stringified content payload with a target path.
 *
 * app.js:540-548 (_sendConfigMessages)
 */
export interface MessageChannelMessage {
  type: "Message";
  content: string;   // JSON.stringify(payload)
  id: string;        // uuid v4
  target: string;    // e.g. "/streaming/systemUi/configuration"
  cv: string;        // ""
}

// ─────────────────────────────────────────────────────────────
// Message channel — inbound
// ─────────────────────────────────────────────────────────────

/**
 * Acknowledgement sent by Xbox in response to our Handshake.
 * Receiving this is the trigger to unlock the control and input channels.
 *
 * app.js:401-404 (_handleJsonMessage)
 */
export interface HandshakeAckMessage {
  type: "HandshakeAck";
  [key: string]: unknown;
}

/**
 * Server-initiated disconnect notification.
 * Arrives as a TransactionStart or Message with a serverInitiatedDisconnect target.
 *
 * app.js:407-438 (_handleJsonMessage)
 */
export interface ServerDisconnectMessage {
  type: "TransactionStart" | "Message";
  target: string;   // includes "serverInitiatedDisconnect"
  content: string;  // JSON.stringify({ reason, secondsUntilKick? })
  [key: string]: unknown;
}

/**
 * Parsed content of a serverInitiatedDisconnect message.
 *
 * app.js:411-438 (_handleJsonMessage → JSON.parse(msg.content))
 */
export interface ServerDisconnectContent {
  reason: "WarningForBeingIdle" | "KickForBeingIdle" | string;
  secondsUntilKick?: number;  // present when reason === "WarningForBeingIdle"
}

/**
 * Union of all inbound message types on the message channel.
 */
export type InboundMessage =
  | HandshakeAckMessage
  | ServerDisconnectMessage
  | { type: string; [key: string]: unknown };  // catch-all for unknown types

// ─────────────────────────────────────────────────────────────
// Control channel — outbound
// ─────────────────────────────────────────────────────────────

/**
 * Authorization request sent on the control channel immediately after
 * HandshakeAck. Xbox rejects input until this arrives with the correct
 * accessKey.
 *
 * app.js:483-487 (_sendControlAuth)
 */
export interface AuthorizationRequest {
  message: "authorizationRequest";
  accessKey: string;  // CONTROL_ACCESS_KEY
}

/**
 * Keyframe (I-frame) request sent on the control channel.
 * Sent KEYFRAME_DELAY_MS after authorizationRequest, and on demand.
 *
 * app.js:493-497 (_sendControlAuth → setTimeout)
 * app.js:877-880 (sendKeyframeRequest)
 */
export interface KeyframeRequest {
  message: "videoKeyframeRequested";
  ifrRequested: true;
}

/**
 * Gamepad connect/disconnect notification sent on the control channel
 * immediately after HandshakeAck. Tells Xbox that a gamepad at index 0
 * has been added.
 *
 * app.js:509-514 (_sendInputStart)
 */
export interface GamepadChangedMessage {
  message: "gamepadChanged";
  gamepadIndex: number;  // 0
  wasAdded: boolean;     // true
}

/**
 * Union of all outbound control-channel messages.
 */
export type ControlMessage =
  | AuthorizationRequest
  | KeyframeRequest
  | GamepadChangedMessage;
