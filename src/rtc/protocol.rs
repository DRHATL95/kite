// src/rtc/protocol.rs — Xbox data-channel protocol messages + inbound parser
//
// Ported VERBATIM from the TypeScript authoritative sources:
//   ui/src/lib/connection/constants.ts     — load-bearing constants
//   ui/src/lib/connection/messages.ts      — message type shapes
//   ui/src/lib/connection/dataChannels.ts  — handshake sequence + routing
//
// Pure module: std + serde only.  No IO, no str0m/opus/ffmpeg/bytes.
// Compiles and tests under default `cargo test` (no feature flags).

use serde::{Deserialize, Serialize};

// ─────────────────────────────────────────────────────────────────────────────
// Load-bearing protocol constants
// (verbatim from constants.ts — do NOT change without re-verifying against
// the reference implementation and ui/public/app.js)
// ─────────────────────────────────────────────────────────────────────────────

/// Protocol version for the message-channel Handshake.
/// constants.ts: MESSAGE_HANDSHAKE_VERSION = "messageV1"
pub const MESSAGE_HANDSHAKE_VERSION: &str = "messageV1";

/// Correlation ID included in the message-channel Handshake.
/// constants.ts: MESSAGE_HANDSHAKE_ID = "be0bfc6d-1e83-4c8a-90ed-fa8601c5a179"
pub const MESSAGE_HANDSHAKE_ID: &str = "be0bfc6d-1e83-4c8a-90ed-fa8601c5a179";

/// Access key sent in the authorizationRequest on the control channel.
/// constants.ts: CONTROL_ACCESS_KEY = "4BDB3609-C1F1-4195-9B37-FEFF45DA8B8E"
pub const CONTROL_ACCESS_KEY: &str = "4BDB3609-C1F1-4195-9B37-FEFF45DA8B8E";

// ─────────────────────────────────────────────────────────────────────────────
// Outbound message types — message channel
// ─────────────────────────────────────────────────────────────────────────────

/// First message sent on the message channel after it opens.
/// Xbox responds with HandshakeAck.
///
/// messages.ts: HandshakeMessage
/// dataChannels.ts:138-143 (sendMessageHandshake)
/// app.js:457-464
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Handshake {
    /// Always "Handshake"
    #[serde(rename = "type")]
    pub msg_type: String,
    /// "messageV1"
    pub version: String,
    /// "be0bfc6d-1e83-4c8a-90ed-fa8601c5a179"
    pub id: String,
    /// "0"
    pub cv: String,
}

impl Handshake {
    /// Construct the wire-exact Handshake message.
    pub fn new() -> Self {
        Self {
            msg_type: "Handshake".to_owned(),
            version: MESSAGE_HANDSHAKE_VERSION.to_owned(),
            id: MESSAGE_HANDSHAKE_ID.to_owned(),
            cv: "0".to_owned(),
        }
    }
}

impl Default for Handshake {
    fn default() -> Self {
        Self::new()
    }
}

/// Config / property message sent on the message channel after HandshakeAck.
/// Wraps a JSON-stringified content payload with a target path.
///
/// messages.ts: MessageChannelMessage
/// dataChannels.ts:258-268 (sendConfigMessages)
/// app.js:540-548
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DcMessage {
    /// Always "Message"
    #[serde(rename = "type")]
    pub msg_type: String,
    /// JSON.stringify(payload) — the content is already a JSON string
    pub content: String,
    /// UUID v4 (generated per message)
    pub id: String,
    /// e.g. "/streaming/systemUi/configuration"
    pub target: String,
    /// Always ""
    pub cv: String,
}

impl DcMessage {
    /// Construct a DcMessage with a pre-generated id.
    pub fn new(target: impl Into<String>, content: impl Into<String>, id: impl Into<String>) -> Self {
        Self {
            msg_type: "Message".to_owned(),
            content: content.into(),
            id: id.into(),
            target: target.into(),
            cv: String::new(),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Outbound message types — control channel
// ─────────────────────────────────────────────────────────────────────────────

/// Authorization request sent on the control channel immediately after HandshakeAck.
///
/// messages.ts: AuthorizationRequest
/// dataChannels.ts:164-168 (sendControlAuth)
/// app.js:483-487
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ControlAuthorization {
    pub message: String,
    #[serde(rename = "accessKey")]
    pub access_key: String,
}

/// Build the wire-exact authorizationRequest message.
pub fn control_authorization() -> ControlAuthorization {
    ControlAuthorization {
        message: "authorizationRequest".to_owned(),
        access_key: CONTROL_ACCESS_KEY.to_owned(),
    }
}

/// Keyframe (I-frame) request sent on the control channel.
///
/// messages.ts: KeyframeRequest
/// constants.ts: KEYFRAME_REQUEST = { message: "videoKeyframeRequested", ifrRequested: true }
/// dataChannels.ts:175-176 (sendControlAuth → setTimeout)
/// app.js:493-497
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KeyframeRequest {
    pub message: String,
    #[serde(rename = "ifrRequested")]
    pub ifr_requested: bool,
}

/// Build the wire-exact videoKeyframeRequested message.
pub fn keyframe_request() -> KeyframeRequest {
    KeyframeRequest {
        message: "videoKeyframeRequested".to_owned(),
        ifr_requested: true,
    }
}

/// Gamepad connect/disconnect notification on the control channel.
///
/// messages.ts: GamepadChangedMessage
/// dataChannels.ts:197-202 (sendInputStart)
/// app.js:509-514
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GamepadChanged {
    pub message: String,
    #[serde(rename = "gamepadIndex")]
    pub gamepad_index: u32,
    #[serde(rename = "wasAdded")]
    pub was_added: bool,
}

/// Build the wire-exact gamepadChanged message (index 0, wasAdded=true).
pub fn gamepad_changed() -> GamepadChanged {
    GamepadChanged {
        message: "gamepadChanged".to_owned(),
        gamepad_index: 0,
        was_added: true,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Config messages — the 6 /streaming/* messages sent after HandshakeAck
// ─────────────────────────────────────────────────────────────────────────────

/// A config target+content pair (before wrapping in a DcMessage).
#[derive(Debug, Clone)]
pub struct ConfigEntry {
    pub target: &'static str,
    pub content: &'static str,
}

/// The 6 /streaming/* config entries, verbatim from dataChannels.ts:219-252.
/// Callers wrap each in a DcMessage with a generated UUID id.
///
/// dataChannels.ts:219-252 (sendConfigMessages → configs array)
/// app.js:528-535
pub const CONFIG_ENTRIES: [ConfigEntry; 6] = [
    ConfigEntry {
        target: "/streaming/systemUi/configuration",
        content: r#"{"systemUis":[],"version":[0,2,0]}"#,
    },
    ConfigEntry {
        target: "/streaming/properties/clientappinstallid",
        content: r#""c97d7ee0-73b2-4239-bf1d-9d805a338429""#,
    },
    ConfigEntry {
        target: "/streaming/properties/orientation",
        content: "0",
    },
    ConfigEntry {
        target: "/streaming/properties/touchinputenabled",
        content: "false",
    },
    ConfigEntry {
        target: "/streaming/properties/clientDeviceCapabilities",
        content: "{}",
    },
    ConfigEntry {
        target: "/streaming/characteristics/dimensionschanged",
        content: r#"{"horizontal":1920,"vertical":1080,"preferredWidth":1920,"preferredHeight":1080,"safeAreaLeft":0,"safeAreaTop":0,"safeAreaRight":1920,"safeAreaBottom":1080}"#,
    },
];

/// Build the 6 /streaming/* config DcMessages with the given id generator.
///
/// The `make_id` closure is called once per message to produce a UUID v4.
/// In production, pass `|| uuid_v4()`.  In tests, pass a deterministic string.
///
/// dataChannels.ts:255-269 (sendConfigMessages)
pub fn config_messages(mut make_id: impl FnMut() -> String) -> Vec<DcMessage> {
    CONFIG_ENTRIES
        .iter()
        .map(|e| DcMessage::new(e.target, e.content, make_id()))
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbound message parser
// ─────────────────────────────────────────────────────────────────────────────

/// Disconnect reason from a serverInitiatedDisconnect message.
///
/// messages.ts: ServerDisconnectContent.reason
/// dataChannels.ts:317-327 (handleJsonMessage → WarningForBeingIdle / else branch)
#[derive(Debug, Clone, PartialEq)]
pub enum DisconnectReason {
    /// Xbox is about to kick for idle; `seconds_until_kick` is the countdown.
    /// dataChannels.ts:317-321
    WarningForBeingIdle { seconds_until_kick: u32 },
    /// Session terminated because the user was idle too long.
    /// dataChannels.ts:322-327
    KickForBeingIdle,
    /// Any other disconnect reason string.
    Other(String),
}

/// Typed variants of inbound data-channel messages.
///
/// Covers the cases the TS routes explicitly; all others → Unknown.
/// parse_message never panics — unknown/malformed input yields Unknown.
#[derive(Debug, Clone, PartialEq)]
pub enum InboundMsg {
    /// Xbox acknowledged our Handshake.
    /// messages.ts: HandshakeAckMessage
    /// dataChannels.ts:297-300
    HandshakeAck,
    /// Xbox sent a serverInitiatedDisconnect.
    /// messages.ts: ServerDisconnectMessage / ServerDisconnectContent
    /// dataChannels.ts:305-328
    ServerDisconnect(DisconnectReason),
    /// Any other message — do NOT panic on unrecognized input.
    Unknown,
}

/// Parse a raw UTF-8 byte slice from a data channel into an InboundMsg.
///
/// Mirrors the JS handleJsonMessage logic:
///   - type == "HandshakeAck"                       → HandshakeAck
///   - type == "TransactionStart"|"Message"
///     AND target includes "serverInitiatedDisconnect"
///     → ServerDisconnect(reason)
///   - anything else (or parse failure)              → Unknown
///
/// dataChannels.ts:283-329 (handleJsonMessage)
/// app.js:396-440
pub fn parse_message(bytes: &[u8]) -> InboundMsg {
    // Decode UTF-8; non-UTF-8 input → Unknown
    let text = match std::str::from_utf8(bytes) {
        Ok(s) => s,
        Err(_) => return InboundMsg::Unknown,
    };

    // Parse as a generic JSON object; non-JSON → Unknown
    let value: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return InboundMsg::Unknown,
    };

    // Extract the type field (TS checks both "type" and "Type")
    let msg_type = value
        .get("type")
        .or_else(|| value.get("Type"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // ── HandshakeAck ─────────────────────────────────────────────────────────
    // dataChannels.ts:297-300 / app.js:401-404
    if msg_type == "HandshakeAck" {
        return InboundMsg::HandshakeAck;
    }

    // ── Server-initiated disconnect ────────────────────────────────────────────
    // dataChannels.ts:305-328 / app.js:407-438
    if msg_type == "TransactionStart" || msg_type == "Message" {
        let target = value
            .get("target")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if target.contains("serverInitiatedDisconnect") {
            let raw_content = value
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("{}");

            // Parse inner content JSON
            let content: serde_json::Value =
                serde_json::from_str(raw_content).unwrap_or(serde_json::Value::Null);

            let reason = content
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown reason");

            let disconnect_reason = if reason == "WarningForBeingIdle" {
                // dataChannels.ts:318-321
                let secs = content
                    .get("secondsUntilKick")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(120) as u32;
                DisconnectReason::WarningForBeingIdle {
                    seconds_until_kick: secs,
                }
            } else if reason == "KickForBeingIdle" {
                DisconnectReason::KickForBeingIdle
            } else {
                DisconnectReason::Other(reason.to_owned())
            };

            return InboundMsg::ServerDisconnect(disconnect_reason);
        }
    }

    InboundMsg::Unknown
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Outbound: Handshake ──────────────────────────────────────────────────

    #[test]
    fn handshake_serializes_exact_json() {
        let h = Handshake::new();
        insta::assert_json_snapshot!(h, @r#"
        {
          "type": "Handshake",
          "version": "messageV1",
          "id": "be0bfc6d-1e83-4c8a-90ed-fa8601c5a179",
          "cv": "0"
        }
        "#);
    }

    #[test]
    fn handshake_field_values() {
        let h = Handshake::new();
        assert_eq!(h.msg_type, "Handshake");
        assert_eq!(h.version, MESSAGE_HANDSHAKE_VERSION);
        assert_eq!(h.id, MESSAGE_HANDSHAKE_ID);
        assert_eq!(h.cv, "0");
    }

    // ── Outbound: Control authorization ──────────────────────────────────────

    #[test]
    fn control_authorization_serializes_exact_json() {
        let auth = control_authorization();
        insta::assert_json_snapshot!(auth, @r#"
        {
          "message": "authorizationRequest",
          "accessKey": "4BDB3609-C1F1-4195-9B37-FEFF45DA8B8E"
        }
        "#);
    }

    // ── Outbound: Keyframe request ────────────────────────────────────────────

    #[test]
    fn keyframe_request_serializes_exact_json() {
        let kf = keyframe_request();
        insta::assert_json_snapshot!(kf, @r#"
        {
          "message": "videoKeyframeRequested",
          "ifrRequested": true
        }
        "#);
    }

    // ── Outbound: GamepadChanged ──────────────────────────────────────────────

    #[test]
    fn gamepad_changed_serializes_exact_json() {
        let gc = gamepad_changed();
        insta::assert_json_snapshot!(gc, @r#"
        {
          "message": "gamepadChanged",
          "gamepadIndex": 0,
          "wasAdded": true
        }
        "#);
    }

    // ── Outbound: Config messages ─────────────────────────────────────────────

    #[test]
    fn config_messages_count_is_6() {
        let msgs = config_messages(|| "test-id".to_owned());
        assert_eq!(msgs.len(), 6);
    }

    #[test]
    fn config_messages_targets_in_order() {
        let msgs = config_messages(|| "test-id".to_owned());
        let targets: Vec<&str> = msgs.iter().map(|m| m.target.as_str()).collect();
        assert_eq!(
            targets,
            &[
                "/streaming/systemUi/configuration",
                "/streaming/properties/clientappinstallid",
                "/streaming/properties/orientation",
                "/streaming/properties/touchinputenabled",
                "/streaming/properties/clientDeviceCapabilities",
                "/streaming/characteristics/dimensionschanged",
            ]
        );
    }

    #[test]
    fn config_messages_type_and_cv() {
        let msgs = config_messages(|| "test-id".to_owned());
        for msg in &msgs {
            assert_eq!(msg.msg_type, "Message");
            assert_eq!(msg.cv, "");
        }
    }

    /// Snapshot the full 6 config messages with deterministic IDs.
    #[test]
    fn config_messages_snapshot() {
        // Use deterministic IDs for snapshot stability.
        let mut counter = 0u32;
        let msgs = config_messages(|| {
            counter += 1;
            format!("00000000-0000-4000-8000-{:012}", counter)
        });
        insta::assert_json_snapshot!(msgs);
    }

    /// Snapshot the systemUi config content (most complex payload).
    #[test]
    fn config_system_ui_content() {
        let entry = &CONFIG_ENTRIES[0];
        assert_eq!(entry.target, "/streaming/systemUi/configuration");
        // Verify the content parses as valid JSON with the right shape.
        let parsed: serde_json::Value = serde_json::from_str(entry.content).unwrap();
        assert_eq!(parsed["systemUis"], serde_json::json!([]));
        assert_eq!(parsed["version"], serde_json::json!([0, 2, 0]));
    }

    /// Snapshot the dimensionschanged config content.
    #[test]
    fn config_dimensions_content() {
        let entry = &CONFIG_ENTRIES[5];
        assert_eq!(entry.target, "/streaming/characteristics/dimensionschanged");
        let parsed: serde_json::Value = serde_json::from_str(entry.content).unwrap();
        assert_eq!(parsed["horizontal"], 1920);
        assert_eq!(parsed["vertical"], 1080);
        assert_eq!(parsed["preferredWidth"], 1920);
        assert_eq!(parsed["preferredHeight"], 1080);
        assert_eq!(parsed["safeAreaLeft"], 0);
        assert_eq!(parsed["safeAreaTop"], 0);
        assert_eq!(parsed["safeAreaRight"], 1920);
        assert_eq!(parsed["safeAreaBottom"], 1080);
    }

    // ── Inbound: parse_message ────────────────────────────────────────────────

    #[test]
    fn parse_handshake_ack() {
        let json = br#"{"type":"HandshakeAck"}"#;
        assert_eq!(parse_message(json), InboundMsg::HandshakeAck);
    }

    #[test]
    fn parse_handshake_ack_with_extra_fields() {
        let json = br#"{"type":"HandshakeAck","extraField":"ignored","version":"1.0"}"#;
        assert_eq!(parse_message(json), InboundMsg::HandshakeAck);
    }

    #[test]
    fn parse_server_disconnect_warning_for_idle() {
        let content = r#"{"reason":"WarningForBeingIdle","secondsUntilKick":60}"#;
        let msg = serde_json::json!({
            "type": "TransactionStart",
            "target": "serverInitiatedDisconnect",
            "content": content
        });
        let bytes = serde_json::to_vec(&msg).unwrap();
        assert_eq!(
            parse_message(&bytes),
            InboundMsg::ServerDisconnect(DisconnectReason::WarningForBeingIdle {
                seconds_until_kick: 60
            })
        );
    }

    #[test]
    fn parse_server_disconnect_kick_for_idle() {
        let content = r#"{"reason":"KickForBeingIdle"}"#;
        let msg = serde_json::json!({
            "type": "Message",
            "target": "path/serverInitiatedDisconnect/extra",
            "content": content
        });
        let bytes = serde_json::to_vec(&msg).unwrap();
        assert_eq!(
            parse_message(&bytes),
            InboundMsg::ServerDisconnect(DisconnectReason::KickForBeingIdle)
        );
    }

    #[test]
    fn parse_server_disconnect_other_reason() {
        let content = r#"{"reason":"SomeOtherReason"}"#;
        let msg = serde_json::json!({
            "type": "TransactionStart",
            "target": "serverInitiatedDisconnect",
            "content": content
        });
        let bytes = serde_json::to_vec(&msg).unwrap();
        assert_eq!(
            parse_message(&bytes),
            InboundMsg::ServerDisconnect(DisconnectReason::Other("SomeOtherReason".to_owned()))
        );
    }

    #[test]
    fn parse_idle_warning_default_seconds_when_missing() {
        // secondsUntilKick absent → defaults to 120 (matches TS: ?? 120)
        let content = r#"{"reason":"WarningForBeingIdle"}"#;
        let msg = serde_json::json!({
            "type": "TransactionStart",
            "target": "serverInitiatedDisconnect",
            "content": content
        });
        let bytes = serde_json::to_vec(&msg).unwrap();
        assert_eq!(
            parse_message(&bytes),
            InboundMsg::ServerDisconnect(DisconnectReason::WarningForBeingIdle {
                seconds_until_kick: 120
            })
        );
    }

    #[test]
    fn parse_unknown_message_type() {
        let json = br#"{"type":"SomethingElse","data":"value"}"#;
        assert_eq!(parse_message(json), InboundMsg::Unknown);
    }

    #[test]
    fn parse_non_disconnect_message_type() {
        // "Message" type but target does NOT include serverInitiatedDisconnect → Unknown
        let msg = serde_json::json!({
            "type": "Message",
            "target": "/streaming/systemUi/configuration",
            "content": "{}"
        });
        let bytes = serde_json::to_vec(&msg).unwrap();
        assert_eq!(parse_message(&bytes), InboundMsg::Unknown);
    }

    #[test]
    fn parse_non_utf8_input() {
        let bytes = &[0xFF, 0xFE, 0x00, 0x01];
        assert_eq!(parse_message(bytes), InboundMsg::Unknown);
    }

    #[test]
    fn parse_invalid_json() {
        let bytes = b"not json at all";
        assert_eq!(parse_message(bytes), InboundMsg::Unknown);
    }

    #[test]
    fn parse_empty_bytes() {
        assert_eq!(parse_message(&[]), InboundMsg::Unknown);
    }
}
