//! Pure Xbox data-channel handshake sequencer (str0m-free; default build).
//!
//! Translates abstract channel events (a channel opened; inbound bytes) into the
//! ordered `ChannelWrite`s the xHome handshake requires, using the Phase-1
//! `protocol` builders. The engine maps str0m `Event::ChannelOpen`/`ChannelData`
//! to these events and `ChannelWrite` back to `rtc.channel(id).write`.
//!
//! Sequence (see dataChannels.ts / the Phase-0 findings):
//!   message opens → send Handshake
//!   HandshakeAck  → control authorizationRequest, control gamepadChanged,
//!                   6 message /streaming/* configs, control videoKeyframeRequested

use crate::rtc::protocol::{
    self, DisconnectReason, InboundMsg, config_messages, control_authorization, gamepad_changed,
    keyframe_request,
};

/// The four Xbox channels. Order matches creation order (SCTP stream ids 0..3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelLabel {
    Chat = 0,
    Control = 1,
    Message = 2,
    Input = 3,
}

impl ChannelLabel {
    /// Parse str0m's channel label string. Unknown labels → None (ignored).
    /// (Named `from_label`, not `from_str`, to avoid shadowing `FromStr` — we
    /// want `Option` "ignore unknown", not `FromStr`'s `Result`.)
    pub fn from_label(s: &str) -> Option<Self> {
        match s {
            "chat" => Some(Self::Chat),
            "control" => Some(Self::Control),
            "message" => Some(Self::Message),
            "input" => Some(Self::Input),
            _ => None,
        }
    }
}

/// An abstract inbound channel event the engine feeds the sequencer.
#[derive(Debug)]
pub enum ChannelEvent {
    Opened(ChannelLabel),
    Inbound { label: ChannelLabel, data: Vec<u8> },
}

/// A write the engine must perform: `bytes` (binary) on `label`'s channel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelWrite {
    pub label: ChannelLabel,
    pub bytes: Vec<u8>,
}

/// Drives the one-time Xbox handshake. Stateful but pure (no IO).
pub struct HandshakeSequencer {
    handshake_sent: bool,
    acked: bool,
    make_id: Box<dyn FnMut() -> String + Send>,
    disconnect: Option<DisconnectReason>,
    idle_warning: Option<u32>,
}

impl HandshakeSequencer {
    /// `make_id` generates the per-config UUID (production: a UUID v4 generator).
    pub fn new(make_id: Box<dyn FnMut() -> String + Send>) -> Self {
        Self {
            handshake_sent: false,
            acked: false,
            make_id,
            disconnect: None,
            idle_warning: None,
        }
    }

    /// True once HandshakeAck has been processed (the session is "ready").
    pub fn is_ready(&self) -> bool {
        self.acked
    }

    /// Take any server-initiated disconnect reason seen on inbound data.
    pub fn take_disconnect(&mut self) -> Option<DisconnectReason> {
        self.disconnect.take()
    }

    /// Take any pending idle warning (seconds until kick); answer with a keepalive
    /// pulse and STAY connected — this is not a disconnect.
    pub fn take_idle_warning(&mut self) -> Option<u32> {
        self.idle_warning.take()
    }

    /// Process one event; return the ordered writes to perform.
    pub fn on_event(&mut self, ev: ChannelEvent) -> Vec<ChannelWrite> {
        match ev {
            ChannelEvent::Opened(ChannelLabel::Message) if !self.handshake_sent => {
                self.handshake_sent = true;
                vec![ChannelWrite {
                    label: ChannelLabel::Message,
                    bytes: serde_json::to_vec(&protocol::Handshake::new()).expect("serialize"),
                }]
            }
            ChannelEvent::Inbound { data, .. } => self.on_inbound(&data),
            _ => Vec::new(),
        }
    }

    fn on_inbound(&mut self, data: &[u8]) -> Vec<ChannelWrite> {
        match protocol::parse_message(data) {
            InboundMsg::HandshakeAck if !self.acked => {
                self.acked = true;
                self.post_handshake_burst()
            }
            InboundMsg::ServerDisconnect(DisconnectReason::WarningForBeingIdle {
                seconds_until_kick,
            }) => {
                self.idle_warning = Some(seconds_until_kick);
                Vec::new()
            }
            InboundMsg::ServerDisconnect(reason) => {
                self.disconnect = Some(reason);
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn post_handshake_burst(&mut self) -> Vec<ChannelWrite> {
        let mut out = Vec::with_capacity(9);
        out.push(ChannelWrite {
            label: ChannelLabel::Control,
            bytes: serde_json::to_vec(&control_authorization()).expect("serialize"),
        });
        out.push(ChannelWrite {
            label: ChannelLabel::Control,
            bytes: serde_json::to_vec(&gamepad_changed()).expect("serialize"),
        });
        let id = &mut self.make_id;
        for msg in config_messages(id) {
            out.push(ChannelWrite {
                label: ChannelLabel::Message,
                bytes: serde_json::to_vec(&msg).expect("serialize"),
            });
        }
        out.push(ChannelWrite {
            label: ChannelLabel::Control,
            bytes: serde_json::to_vec(&keyframe_request()).expect("serialize"),
        });
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rtc::protocol::{self, InboundMsg};

    fn det_ids() -> impl FnMut() -> String {
        let mut n = 0u32;
        move || {
            n += 1;
            format!("00000000-0000-4000-8000-{n:012}")
        }
    }

    #[test]
    fn message_open_sends_handshake_once() {
        let mut seq = HandshakeSequencer::new(Box::new(det_ids()));
        let w = seq.on_event(ChannelEvent::Opened(ChannelLabel::Message));
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].label, ChannelLabel::Message);
        assert_eq!(protocol::parse_message(&w[0].bytes), InboundMsg::Unknown); // it's a Handshake, not an inbound type
        let v: serde_json::Value = serde_json::from_slice(&w[0].bytes).unwrap();
        assert_eq!(v["type"], "Handshake");
        // Opening other channels emits nothing.
        assert!(
            seq.on_event(ChannelEvent::Opened(ChannelLabel::Control))
                .is_empty()
        );
        // Re-opening message does not re-send.
        assert!(
            seq.on_event(ChannelEvent::Opened(ChannelLabel::Message))
                .is_empty()
        );
    }

    #[test]
    fn handshake_ack_emits_full_burst_in_order() {
        let mut seq = HandshakeSequencer::new(Box::new(det_ids()));
        let _ = seq.on_event(ChannelEvent::Opened(ChannelLabel::Message));
        let ack = br#"{"type":"HandshakeAck"}"#.to_vec();
        let w = seq.on_event(ChannelEvent::Inbound {
            label: ChannelLabel::Message,
            data: ack,
        });

        // auth (control) + gamepad (control) + 6 configs (message) + keyframe (control) = 9
        assert_eq!(w.len(), 9);
        let labels: Vec<ChannelLabel> = w.iter().map(|x| x.label).collect();
        use ChannelLabel::{Control, Message};
        assert_eq!(
            labels,
            vec![
                Control, Control, Message, Message, Message, Message, Message, Message, Control
            ]
        );
        // First is authorizationRequest, last is videoKeyframeRequested.
        let first: serde_json::Value = serde_json::from_slice(&w[0].bytes).unwrap();
        assert_eq!(first["message"], "authorizationRequest");
        let last: serde_json::Value = serde_json::from_slice(&w[8].bytes).unwrap();
        assert_eq!(last["message"], "videoKeyframeRequested");
        assert!(seq.is_ready());
    }

    #[test]
    fn duplicate_ack_is_ignored() {
        let mut seq = HandshakeSequencer::new(Box::new(det_ids()));
        let _ = seq.on_event(ChannelEvent::Opened(ChannelLabel::Message));
        let ack = br#"{"type":"HandshakeAck"}"#.to_vec();
        let _ = seq.on_event(ChannelEvent::Inbound {
            label: ChannelLabel::Message,
            data: ack.clone(),
        });
        let again = seq.on_event(ChannelEvent::Inbound {
            label: ChannelLabel::Message,
            data: ack,
        });
        assert!(again.is_empty());
    }

    #[test]
    fn server_disconnect_is_surfaced_not_written() {
        let mut seq = HandshakeSequencer::new(Box::new(det_ids()));
        let msg = serde_json::json!({
            "type":"Message","target":"x/serverInitiatedDisconnect","content":"{\"reason\":\"KickForBeingIdle\"}"
        });
        let bytes = serde_json::to_vec(&msg).unwrap();
        let w = seq.on_event(ChannelEvent::Inbound {
            label: ChannelLabel::Message,
            data: bytes,
        });
        assert!(w.is_empty()); // sequencer writes nothing; engine reads last_disconnect()
        assert!(matches!(
            seq.take_disconnect(),
            Some(protocol::DisconnectReason::KickForBeingIdle)
        ));
    }

    #[test]
    fn idle_warning_is_surfaced_as_warning_not_disconnect() {
        let mut seq = HandshakeSequencer::new(Box::new(det_ids()));
        let msg = serde_json::json!({
            "type":"Message","target":"x/serverInitiatedDisconnect",
            "content":"{\"reason\":\"WarningForBeingIdle\",\"secondsUntilKick\":60}"
        });
        let bytes = serde_json::to_vec(&msg).unwrap();
        let w = seq.on_event(ChannelEvent::Inbound { label: ChannelLabel::Message, data: bytes });
        assert!(w.is_empty());
        assert_eq!(seq.take_idle_warning(), Some(60)); // surfaced as a warning
        assert!(seq.take_disconnect().is_none());      // NOT a disconnect
    }

    #[test]
    fn kick_is_still_a_disconnect_not_a_warning() {
        let mut seq = HandshakeSequencer::new(Box::new(det_ids()));
        let msg = serde_json::json!({
            "type":"Message","target":"x/serverInitiatedDisconnect",
            "content":"{\"reason\":\"KickForBeingIdle\"}"
        });
        let bytes = serde_json::to_vec(&msg).unwrap();
        let _ = seq.on_event(ChannelEvent::Inbound { label: ChannelLabel::Message, data: bytes });
        assert!(seq.take_idle_warning().is_none());
        assert!(matches!(seq.take_disconnect(), Some(protocol::DisconnectReason::KickForBeingIdle)));
    }
}
