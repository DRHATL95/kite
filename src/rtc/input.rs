// src/rtc/input.rs — byte-exact 38-byte Xbox input packet encoder
//
// Ported field-for-field from `ui/src/lib/connection/input.ts` and
// `ui/src/lib/connection/constants.ts`, which work against a real Xbox console.
// Do NOT change byte offsets or the LE/BE split without re-verifying against
// those TypeScript sources.

// ─────────────────────────────────────────────────────────────────────────────
// Constants (from constants.ts)
// ─────────────────────────────────────────────────────────────────────────────

/// Input packet report-type for standard gamepad frames.
/// constants.ts: REPORT_TYPE_GAMEPAD = 2
pub const REPORT_TYPE_GAMEPAD: u16 = 2;

/// Input packet report-type for the ClientMetadata initialisation packet.
/// constants.ts: REPORT_TYPE_CLIENT_METADATA = 8
pub const REPORT_TYPE_CLIENT_METADATA: u16 = 8;

/// LeftThumbX value for the idle micro-pulse (~12.5% deflection).
/// Inside most game deadzones but detectable by Xbox session manager.
/// constants.ts: IDLE_PULSE_LEFT_THUMB_X = 4096
pub const IDLE_PULSE_LEFT_THUMB_X: i16 = 4096;

// ─────────────────────────────────────────────────────────────────────────────
// Button bitmask constants (from constants.ts BUTTON_BITS)
// ─────────────────────────────────────────────────────────────────────────────

pub const BTN_NEXUS: u16          = 2;       // index 16
pub const BTN_MENU: u16           = 4;       // index 9
pub const BTN_VIEW: u16           = 8;       // index 8
pub const BTN_A: u16              = 16;      // index 0
pub const BTN_B: u16              = 32;      // index 1
pub const BTN_X: u16              = 64;      // index 2
pub const BTN_Y: u16              = 128;     // index 3
pub const BTN_DPAD_UP: u16        = 256;     // index 12
pub const BTN_DPAD_DOWN: u16      = 512;     // index 13
pub const BTN_DPAD_LEFT: u16      = 1024;    // index 14
pub const BTN_DPAD_RIGHT: u16     = 2048;    // index 15
pub const BTN_LEFT_SHOULDER: u16  = 4096;    // index 4
pub const BTN_RIGHT_SHOULDER: u16 = 8192;    // index 5
pub const BTN_LEFT_THUMB: u16     = 16384;   // index 10
pub const BTN_RIGHT_THUMB: u16    = 32768;   // index 11

// ─────────────────────────────────────────────────────────────────────────────
// GamepadFrame
// ─────────────────────────────────────────────────────────────────────────────

/// Virtual gamepad state — pre-processed values ready for wire encoding.
///
/// Callers are responsible for applying dead-zones and normalising axes
/// before populating this struct (i.e., these are the final i16/u16 values
/// that go directly into the packet — the Y-axis negation is applied inside
/// `encode_gamepad`, matching input.ts).
#[derive(Debug, Clone, Default)]
pub struct GamepadFrame {
    /// Button bitmask (BUTTON_BITS from constants.ts).
    pub buttons: u16,
    /// Left stick X in [-32767, 32767]. input.ts: axes[0] → normalizeAxis(lx).
    pub left_thumb_x: i16,
    /// Left stick Y in [-32767, 32767]. **Negated on encode** per protocol.
    /// input.ts: axes[1] → normalizeAxis(-ly).
    pub left_thumb_y: i16,
    /// Right stick X in [-32767, 32767].
    pub right_thumb_x: i16,
    /// Right stick Y in [-32767, 32767]. **Negated on encode** per protocol.
    pub right_thumb_y: i16,
    /// Left trigger in [0, 65535]. input.ts: normalizeTrigger(buttons[6].value).
    pub left_trigger: u16,
    /// Right trigger in [0, 65535]. input.ts: normalizeTrigger(buttons[7].value).
    pub right_trigger: u16,
}

impl GamepadFrame {
    /// All fields zero — neutral/idle gamepad state.
    pub fn neutral() -> Self {
        Self::default()
    }

    /// Idle micro-pulse frame: LeftThumbX = 4096, everything else neutral.
    /// This is inside game deadzones but detectable by the Xbox session manager.
    /// constants.ts: IDLE_PULSE_LEFT_THUMB_X = 4096
    pub fn idle_pulse() -> Self {
        Self {
            left_thumb_x: IDLE_PULSE_LEFT_THUMB_X,
            ..Self::default()
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Packet encoders
// ─────────────────────────────────────────────────────────────────────────────

/// Encode a single gamepad frame into the 38-byte Xbox input packet.
///
/// Byte layout (from input.ts docblock and app.js:1596-1645):
///
/// ```text
/// Header (14 bytes):
///   [0..2]   reportType          u16 LE = REPORT_TYPE_GAMEPAD (2)
///   [2..6]   sequence            u32 LE
///   [6..14]  timestamp           f64 LE (ms)
///
/// Frame count (1 byte):
///   [14]     frameCount          u8 = 1
///
/// Gamepad frame (23 bytes, o = 15):
///   [15]     gamepadIndex        u8 = 0
///   [16..18] buttons             u16 LE bitmask
///   [18..20] leftThumbX          i16 LE
///   [20..22] leftThumbY          i16 LE  (negated: -left_thumb_y)
///   [22..24] rightThumbX         i16 LE
///   [24..26] rightThumbY         i16 LE  (negated: -right_thumb_y)
///   [26..28] leftTrigger         u16 LE
///   [28..30] rightTrigger        u16 LE
///   [30..34] PhysicalPhysicality u32 LE = 1  (app.js:1642)
///   [34..38] VirtualPhysicality  u32 BE = 1  (app.js:1643 — big-endian quirk!)
/// ```
pub fn encode_gamepad(f: &GamepadFrame, sequence: u32, timestamp_ms: f64) -> [u8; 38] {
    let mut buf = [0u8; 38];

    // ── Header (14 bytes) ────────────────────────────────────────────────────
    // [0..2] reportType u16 LE
    buf[0..2].copy_from_slice(&REPORT_TYPE_GAMEPAD.to_le_bytes());
    // [2..6] sequence u32 LE
    buf[2..6].copy_from_slice(&sequence.to_le_bytes());
    // [6..14] timestamp f64 LE
    buf[6..14].copy_from_slice(&timestamp_ms.to_le_bytes());

    // ── Frame count (1 byte) ─────────────────────────────────────────────────
    // [14] frameCount u8 = 1
    buf[14] = 1;

    // ── Gamepad frame (23 bytes), offset o = 15 ─────────────────────────────
    let o: usize = 15;

    // [o+0 = 15] gamepadIndex u8 = 0
    buf[o] = 0;

    // [o+1..o+3 = 16..18] buttons u16 LE
    buf[o + 1..o + 3].copy_from_slice(&f.buttons.to_le_bytes());

    // [o+3..o+5 = 18..20] leftThumbX i16 LE
    buf[o + 3..o + 5].copy_from_slice(&f.left_thumb_x.to_le_bytes());

    // [o+5..o+7 = 20..22] leftThumbY i16 LE — NEGATED per protocol
    // input.ts: v.setInt16(o + 5, normalizeAxis(-ly), true)
    buf[o + 5..o + 7].copy_from_slice(&(-f.left_thumb_y).to_le_bytes());

    // [o+7..o+9 = 22..24] rightThumbX i16 LE
    buf[o + 7..o + 9].copy_from_slice(&f.right_thumb_x.to_le_bytes());

    // [o+9..o+11 = 24..26] rightThumbY i16 LE — NEGATED per protocol
    // input.ts: v.setInt16(o + 9, normalizeAxis(-ry), true)
    buf[o + 9..o + 11].copy_from_slice(&(-f.right_thumb_y).to_le_bytes());

    // [o+11..o+13 = 26..28] leftTrigger u16 LE
    buf[o + 11..o + 13].copy_from_slice(&f.left_trigger.to_le_bytes());

    // [o+13..o+15 = 28..30] rightTrigger u16 LE
    buf[o + 13..o + 15].copy_from_slice(&f.right_trigger.to_le_bytes());

    // [o+15..o+19 = 30..34] PhysicalPhysicality u32 LITTLE-ENDIAN = 1
    // input.ts: v.setUint32(o + 15, 1, true)   ← true = LE
    buf[o + 15..o + 19].copy_from_slice(&1u32.to_le_bytes());

    // [o+19..o+23 = 34..38] VirtualPhysicality u32 BIG-ENDIAN = 1
    // input.ts: v.setUint32(o + 19, 1, false)  ← false = BE  (load-bearing quirk!)
    buf[o + 19..o + 23].copy_from_slice(&1u32.to_be_bytes());

    buf
}

/// Encode the 15-byte ClientMetadata initialisation packet.
/// Sent exactly once when the input channel first opens.
///
/// Byte layout (from input.ts docblock and app.js:1585-1593):
/// ```text
///   [0..2]   reportType      u16 LE = REPORT_TYPE_CLIENT_METADATA (8)
///   [2..6]   sequence        u32 LE
///   [6..14]  timestamp       f64 LE (ms)
///   [14]     maxTouchpoints  u8 = 1
/// ```
///
/// Note: input.ts `encodeClientMetadata(seq, timestampMs)` takes seq and
/// timestamp as parameters. This Rust port matches that signature.
pub fn encode_client_metadata(sequence: u32, timestamp_ms: f64) -> [u8; 15] {
    let mut buf = [0u8; 15];

    // [0..2] reportType u16 LE
    buf[0..2].copy_from_slice(&REPORT_TYPE_CLIENT_METADATA.to_le_bytes());
    // [2..6] sequence u32 LE
    buf[2..6].copy_from_slice(&sequence.to_le_bytes());
    // [6..14] timestamp f64 LE
    buf[6..14].copy_from_slice(&timestamp_ms.to_le_bytes());
    // [14] maxTouchpoints u8 = 1
    buf[14] = 1;

    buf
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Scaffold tests from task brief ───────────────────────────────────────

    #[test]
    fn neutral_frame_layout() {
        let f = GamepadFrame::neutral();
        let bytes = encode_gamepad(&f, /*sequence*/ 7, /*timestamp_ms*/ 1234.5);
        assert_eq!(bytes.len(), 38);
        assert_eq!(u16::from_le_bytes([bytes[0], bytes[1]]), REPORT_TYPE_GAMEPAD); // 2
        assert_eq!(u32::from_le_bytes([bytes[2], bytes[3], bytes[4], bytes[5]]), 7); // sequence
        assert_eq!(bytes[14], 1); // frameCount
        assert_eq!(bytes[15], 0); // gamepadIndex
        // PhysicalPhysicality @30..34 little-endian == 1
        assert_eq!(
            u32::from_le_bytes([bytes[30], bytes[31], bytes[32], bytes[33]]),
            1
        );
        // VirtualPhysicality @34..38 BIG-endian == 1  (load-bearing quirk!)
        assert_eq!(
            u32::from_be_bytes([bytes[34], bytes[35], bytes[36], bytes[37]]),
            1
        );
    }

    #[test]
    fn y_axis_is_negated() {
        let mut f = GamepadFrame::neutral();
        f.left_thumb_y = 10000;
        let bytes = encode_gamepad(&f, 0, 0.0);
        // Confirmed against input.ts: leftThumbY at o+5 = 15+5 = 20..22
        // input.ts: v.setInt16(o + 5, normalizeAxis(-ly), true)
        assert_eq!(i16::from_le_bytes([bytes[20], bytes[21]]), -10000); // negated per protocol
    }

    #[test]
    fn idle_pulse_uses_4096() {
        let f = GamepadFrame::idle_pulse();
        assert_eq!(f.left_thumb_x, 4096); // inside deadzone, detectable by Xbox
    }

    // ── Additional coverage ──────────────────────────────────────────────────

    #[test]
    fn timestamp_encoded_at_bytes_6_to_14() {
        let f = GamepadFrame::neutral();
        let ts = 1234.5_f64;
        let bytes = encode_gamepad(&f, 0, ts);
        let decoded = f64::from_le_bytes([
            bytes[6], bytes[7], bytes[8], bytes[9],
            bytes[10], bytes[11], bytes[12], bytes[13],
        ]);
        assert_eq!(decoded, ts);
    }

    #[test]
    fn right_thumb_y_is_negated() {
        let mut f = GamepadFrame::neutral();
        f.right_thumb_y = 5000;
        let bytes = encode_gamepad(&f, 0, 0.0);
        // rightThumbY at o+9 = 15+9 = 24..26
        assert_eq!(i16::from_le_bytes([bytes[24], bytes[25]]), -5000);
    }

    #[test]
    fn buttons_encoded_at_offset_16() {
        let mut f = GamepadFrame::neutral();
        f.buttons = BTN_A | BTN_B;
        let bytes = encode_gamepad(&f, 0, 0.0);
        // buttons at o+1 = 15+1 = 16..18
        assert_eq!(u16::from_le_bytes([bytes[16], bytes[17]]), BTN_A | BTN_B);
    }

    #[test]
    fn triggers_encoded_at_26_and_28() {
        let mut f = GamepadFrame::neutral();
        f.left_trigger = 32768;
        f.right_trigger = 65535;
        let bytes = encode_gamepad(&f, 0, 0.0);
        // leftTrigger at o+11 = 26..28
        assert_eq!(u16::from_le_bytes([bytes[26], bytes[27]]), 32768);
        // rightTrigger at o+13 = 28..30
        assert_eq!(u16::from_le_bytes([bytes[28], bytes[29]]), 65535);
    }

    #[test]
    fn physicality_bytes_le_vs_be_differ() {
        // Both fields hold value 1, but in opposite byte orders.
        // LE 1 = [01 00 00 00]; BE 1 = [00 00 00 01]
        let f = GamepadFrame::neutral();
        let bytes = encode_gamepad(&f, 0, 0.0);
        // PhysicalPhysicality @30 LE: first byte = 1
        assert_eq!(bytes[30], 1);
        assert_eq!(bytes[31], 0);
        // VirtualPhysicality @34 BE: last byte = 1
        assert_eq!(bytes[34], 0);
        assert_eq!(bytes[37], 1);
    }

    #[test]
    fn client_metadata_length_and_layout() {
        let bytes = encode_client_metadata(3, 999.0);
        assert_eq!(bytes.len(), 15);
        // [0..2] reportType = 8 LE
        assert_eq!(u16::from_le_bytes([bytes[0], bytes[1]]), REPORT_TYPE_CLIENT_METADATA);
        // [2..6] sequence = 3 LE
        assert_eq!(u32::from_le_bytes([bytes[2], bytes[3], bytes[4], bytes[5]]), 3);
        // [6..14] timestamp = 999.0 LE
        let ts = f64::from_le_bytes([
            bytes[6], bytes[7], bytes[8], bytes[9],
            bytes[10], bytes[11], bytes[12], bytes[13],
        ]);
        assert_eq!(ts, 999.0);
        // [14] maxTouchpoints = 1
        assert_eq!(bytes[14], 1);
    }

    #[test]
    fn fully_pressed_frame_snapshot() {
        // All buttons set, sticks and triggers at extremes.
        // This frame is used for the insta snapshot below.
        let f = GamepadFrame {
            buttons: 0xFFFF,
            left_thumb_x: 32767,
            left_thumb_y: 32767,
            right_thumb_x: -32767,
            right_thumb_y: -32767,
            left_trigger: 65535,
            right_trigger: 65535,
        };
        let bytes = encode_gamepad(&f, 0xDEAD_BEEF, 9999.5);

        // Snapshot the full 38-byte encoding.
        insta::assert_debug_snapshot!(bytes);
    }
}
