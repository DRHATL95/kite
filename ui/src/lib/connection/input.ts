/**
 * input.ts — Kite gamepad input encoder
 *
 * Pure, deterministic packet encoder for the Xbox xHome input channel.
 * All encoding is derived byte-for-byte from ui/public/app.js.
 *
 * Packet layout (38 bytes) — app.js:1597-1645 (buildGamepadPacket):
 *
 *   Header (14 bytes):
 *     [0..1]   reportType          u16 LE  = REPORT_TYPE_GAMEPAD (2)
 *     [2..5]   sequence            u32 LE  (caller-supplied)
 *     [6..13]  timestamp           f64 LE  (caller-supplied, ms)
 *
 *   Frame count (1 byte):
 *     [14]     frameCount          u8  = 1
 *
 *   Gamepad frame (23 bytes, starting at offset 15):
 *     [15]     gamepadIndex        u8  = 0
 *     [16..17] buttons             u16 LE  bitmask (BUTTON_BITS)
 *     [18..19] leftThumbX          i16 LE  (deadzone + normalizeAxis(axes[0]))
 *     [20..21] leftThumbY          i16 LE  (deadzone + normalizeAxis(-axes[1]))  ← Y negated
 *     [22..23] rightThumbX         i16 LE  (deadzone + normalizeAxis(axes[2]))
 *     [24..25] rightThumbY         i16 LE  (deadzone + normalizeAxis(-axes[3]))  ← Y negated
 *     [26..27] leftTrigger         u16 LE  (normalizeTrigger(buttons[6].value))
 *     [28..29] rightTrigger        u16 LE  (normalizeTrigger(buttons[7].value))
 *     [30..33] PhysicalPhysicality u32 LE = 1   app.js:1642
 *     [34..37] VirtualPhysicality  u32 BE = 1   app.js:1643  ← big-endian quirk
 *
 * ClientMetadata packet (15 bytes) — app.js:1586-1593 (sendClientMetadataPacket):
 *     [0..1]   reportType          u16 LE  = REPORT_TYPE_CLIENT_METADATA (8)
 *     [2..5]   sequence            u32 LE
 *     [6..13]  timestamp           f64 LE
 *     [14]     maxTouchpoints      u8  = 1
 */

import {
  REPORT_TYPE_GAMEPAD,
  REPORT_TYPE_CLIENT_METADATA,
  BUTTON_BITS,
  STICK_DEADZONE,
  GAMEPAD_POLL_MS,
  IDLE_FRAME_EVERY,
} from "./constants.js";
import { applyRemap, DEFAULT_MAPPING, type ControllerMapping } from "./controllerMapping.js";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal gamepad button state (mirrors Gamepad API GamepadButton). */
export interface GamepadButton {
  pressed: boolean;
  value: number;
}

/**
 * Virtual gamepad state — same shape as the Standard Gamepad API.
 * axes: [leftX, leftY, rightX, rightY]  (range −1..+1)
 * buttons: array of GamepadButton; indices match Standard Gamepad layout.
 */
export interface GamepadState {
  buttons: GamepadButton[];
  /** [leftX, leftY, rightX, rightY] in the range −1..+1 */
  axes: [number, number, number, number];
}

/**
 * Tagged input intent emitted by GamepadPoller.
 *
 * The poller emits intent; callers re-encode for their transport:
 *  - Browser path: re-encodes via encodeClientMetadata / encodeGamepadFrame
 *    with its own seq counter and performance.now() → byte-identical wire bytes.
 *  - Native path (6c.6): forwards gamepad state directly to Rust via
 *    rtcSendInput (seq/ts are assigned by the native engine, so they are not
 *    needed here).
 *
 * `metadata` is emitted exactly once on the first tick; `gamepad` is emitted
 * on every active or idle-cadence tick thereafter.
 */
export type InputEmit =
  | { kind: "metadata" }
  | { kind: "gamepad"; state: GamepadState };

// ─────────────────────────────────────────────────────────────────────────────
// Helper functions (exported for unit-testing)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply stick dead-zone: values whose absolute magnitude is strictly below
 * STICK_DEADZONE are clamped to 0.
 *
 * app.js:1571-1573
 */
export function applyDeadzone(value: number): number {
  return Math.abs(value) < STICK_DEADZONE ? 0.0 : value;
}

/**
 * Scale a −1..+1 axis value to the i16 range [−32767, +32767].
 *
 * app.js:1575-1578
 */
export function normalizeAxis(value: number): number {
  const scaled = Math.round(value * 32767);
  return Math.max(-32767, Math.min(32767, scaled));
}

/**
 * Scale a 0..1 trigger value to the u16 range [0, 65535].
 * Negative values clamp to 0.
 *
 * app.js:1580-1583
 */
export function normalizeTrigger(value: number): number {
  const scaled = Math.round(Math.max(0, value) * 65535);
  return Math.min(65535, scaled);
}

// ─────────────────────────────────────────────────────────────────────────────
// Packet encoders (pure — no side effects, no performance.now() calls)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encode a single gamepad frame into the 38-byte binary Xbox input packet.
 *
 * The caller is responsible for supplying `seq` (monotonically increasing
 * sequence number) and `timestampMs` (e.g. performance.now()) so that this
 * function remains pure and unit-testable.
 *
 * Byte layout mirrors app.js:1596-1645 (buildGamepadPacket) exactly.
 *
 * @param state       Gamepad state (buttons + axes)
 * @param seq         Packet sequence number (u32)
 * @param timestampMs Timestamp in milliseconds (f64)
 * @returns           38-byte Uint8Array
 */
export function encodeGamepadFrame(
  state: GamepadState,
  seq: number,
  timestampMs: number,
): Uint8Array {
  // 14-byte header + 1-byte frame count + 23-byte gamepad frame = 38 bytes
  const buffer = new ArrayBuffer(38);
  const v = new DataView(buffer);

  // ── Header (14 bytes) ────────────────────────────────────────────────────
  v.setUint16(0, REPORT_TYPE_GAMEPAD, true);  // reportType        app.js:1602
  v.setUint32(2, seq >>> 0, true);            // sequence          app.js:1603
  v.setFloat64(6, timestampMs, true);         // timestamp         app.js:1604

  // ── Frame count (1 byte) ─────────────────────────────────────────────────
  v.setUint8(14, 1);                          //                   app.js:1607

  // ── Gamepad frame (23 bytes), offset o=15 ───────────────────────────────
  const o = 15;

  v.setUint8(o, 0);                           // gamepadIndex      app.js:1612

  // Button bitmask
  let buttonMask = 0;
  for (const [btnIdx, bit] of Object.entries(BUTTON_BITS)) {
    const btn = state.buttons[parseInt(btnIdx)];
    if (btn && btn.pressed) buttonMask |= bit;
  }
  v.setUint16(o + 1, buttonMask, true);       // buttons           app.js:1622

  // Axes — apply dead-zone, negate Y axes per protocol
  const lx = applyDeadzone(state.axes[0] ?? 0);
  const ly = applyDeadzone(state.axes[1] ?? 0);
  const rx = applyDeadzone(state.axes[2] ?? 0);
  const ry = applyDeadzone(state.axes[3] ?? 0);

  v.setInt16(o + 3, normalizeAxis(lx), true);   // LeftThumbX       app.js:1630
  v.setInt16(o + 5, normalizeAxis(-ly), true);   // LeftThumbY ¬Y   app.js:1631
  v.setInt16(o + 7, normalizeAxis(rx), true);    // RightThumbX     app.js:1632
  v.setInt16(o + 9, normalizeAxis(-ry), true);   // RightThumbY ¬Y  app.js:1633

  // Triggers (buttons 6 & 7)
  const lt = state.buttons[6]?.value ?? 0;
  const rt = state.buttons[7]?.value ?? 0;
  v.setUint16(o + 11, normalizeTrigger(lt), true);  // LeftTrigger  app.js:1638
  v.setUint16(o + 13, normalizeTrigger(rt), true);  // RightTrigger app.js:1639

  // Physicality
  v.setUint32(o + 15, 1, true);   // PhysicalPhysicality LE        app.js:1642
  v.setUint32(o + 19, 1, false);  // VirtualPhysicality  BE        app.js:1643

  return new Uint8Array(buffer);
}

/**
 * Encode the 15-byte ClientMetadata initialisation packet.
 * Sent exactly once when the input channel first opens.
 *
 * app.js:1585-1593 (sendClientMetadataPacket)
 *
 * @param seq         Packet sequence number (u32)
 * @param timestampMs Timestamp in milliseconds (f64)
 * @returns           15-byte Uint8Array
 */
export function encodeClientMetadata(
  seq: number,
  timestampMs: number,
): Uint8Array {
  const buffer = new ArrayBuffer(15);
  const v = new DataView(buffer);
  v.setUint16(0, REPORT_TYPE_CLIENT_METADATA, true);  // reportType        app.js:1589
  v.setUint32(2, seq >>> 0, true);                    // sequence          app.js:1590
  v.setFloat64(6, timestampMs, true);                 // timestamp         app.js:1591
  v.setUint8(14, 1);                                  // maxTouchpoints=1  app.js:1592
  return new Uint8Array(buffer);
}

/**
 * Dispatch an `InputEmit` to the appropriate encoder.
 *
 * This is the single dispatch point used by the browser path in
 * `ConnectionManager._startGamepadPoller`.  Extracting it as a pure exported
 * function makes the dispatch logic directly unit-testable.
 *
 * @param emit        Tagged intent from `GamepadPoller`.
 * @param seq         Packet sequence number (u32), owned by the caller.
 * @param timestampMs Current timestamp in milliseconds (e.g. performance.now()).
 * @returns           Encoded packet bytes (15 bytes for metadata, 38 for gamepad).
 */
export function encodeInputEmit(
  emit: InputEmit,
  seq: number,
  timestampMs: number,
): Uint8Array {
  return emit.kind === "metadata"
    ? encodeClientMetadata(seq, timestampMs)
    : encodeGamepadFrame(emit.state, seq, timestampMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyboard → virtual gamepad mapping
// ─────────────────────────────────────────────────────────────────────────────

/** A single keyboard mapping entry. */
type KeyboardMapEntry =
  | { type: "button"; index: number }
  | { type: "axis"; axis: number; value: number };

/**
 * Keyboard code → Standard Gamepad API mapping.
 *
 * Taken verbatim from app.js:1751-1787 (KEYBOARD_MAP).
 */
const KEYBOARD_MAP: Record<string, KeyboardMapEntry> = {
  // Left Stick                              app.js:1752-1756
  KeyW:        { type: "axis",   axis: 1, value: -1 },
  KeyS:        { type: "axis",   axis: 1, value:  1 },
  KeyA:        { type: "axis",   axis: 0, value: -1 },
  KeyD:        { type: "axis",   axis: 0, value:  1 },
  // Right Stick                             app.js:1757-1761
  KeyI:        { type: "axis",   axis: 3, value: -1 },
  KeyK:        { type: "axis",   axis: 3, value:  1 },
  KeyJ:        { type: "axis",   axis: 2, value: -1 },
  KeyL:        { type: "axis",   axis: 2, value:  1 },
  // Face Buttons                            app.js:1762-1767
  Space:             { type: "button", index: 0  },  // A
  ControlLeft:       { type: "button", index: 1  },  // B
  ControlRight:      { type: "button", index: 1  },  // B (either ctrl)
  KeyE:              { type: "button", index: 2  },  // X
  KeyQ:              { type: "button", index: 3  },  // Y
  // Shoulders                               app.js:1768-1770
  KeyZ:              { type: "button", index: 4  },  // LB
  KeyC:              { type: "button", index: 5  },  // RB
  // Triggers                                app.js:1771-1773
  Digit1:            { type: "button", index: 6  },  // LT
  Digit3:            { type: "button", index: 7  },  // RT
  // System                                  app.js:1774-1776
  Backspace:         { type: "button", index: 8  },  // View/Back
  Enter:             { type: "button", index: 9  },  // Menu/Start
  // Stick Clicks                            app.js:1777-1779
  KeyR:              { type: "button", index: 10 },  // Left Thumb
  KeyT:              { type: "button", index: 11 },  // Right Thumb
  // DPad                                    app.js:1780-1784
  ArrowUp:           { type: "button", index: 12 },
  ArrowDown:         { type: "button", index: 13 },
  ArrowLeft:         { type: "button", index: 14 },
  ArrowRight:        { type: "button", index: 15 },
  // NB: Backquote (`) is intentionally NOT mapped to Guide/Nexus — it is the
  // DiagnosticsHud toggle key, and double-mapping it fired the Xbox Guide on
  // every HUD toggle. Guide stays available via a physical controller.
};

/**
 * True if `code` (a `KeyboardEvent.code`) maps to a gamepad button or axis.
 * Used by the keyboard tracker to capture (and preventDefault) only the keys
 * we actually translate, leaving every other key — F5, Ctrl+C, … — untouched.
 */
export function isMappedKey(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(KEYBOARD_MAP, code);
}

/**
 * Build a virtual GamepadState from the set of currently pressed keyboard
 * codes.  Mirrors the logic in app.js:1798-1822 (updateKeyboardAxes) but
 * as a pure function that takes the key-set rather than mutating globals.
 *
 * Axis key-pairs cancel out when both directions are held simultaneously,
 * matching app.js behaviour (lx = 0 when both KeyA and KeyD are held).
 *
 * @param keysPressed  Set of KeyboardEvent.code strings currently held down.
 * @returns            A GamepadState suitable for encodeGamepadFrame().
 */
export function mapKeyboardToGamepad(keysPressed: Set<string>): GamepadState {
  const buttons: GamepadButton[] = Array.from({ length: 17 }, () => ({
    pressed: false,
    value: 0,
  }));
  const axes: [number, number, number, number] = [0, 0, 0, 0];

  // Accumulate axis contributions per axis index
  const axisAccum: number[] = [0, 0, 0, 0];

  for (const code of keysPressed) {
    const entry = KEYBOARD_MAP[code];
    if (!entry) continue;

    if (entry.type === "button") {
      const btn = buttons[entry.index];
      if (btn) {
        btn.pressed = true;
        btn.value = 1;
      }
    } else {
      // axis — accumulate; opposing keys cancel to 0
      axisAccum[entry.axis] = (axisAccum[entry.axis] ?? 0) + entry.value;
    }
  }

  // Clamp net axis values to −1..+1
  for (let i = 0; i < 4; i++) {
    axes[i as 0 | 1 | 2 | 3] = Math.max(-1, Math.min(1, axisAccum[i] ?? 0));
  }

  return { buttons, axes };
}

// ─────────────────────────────────────────────────────────────────────────────
// GamepadPoller class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GamepadPoller — polls navigator.getGamepads() at GAMEPAD_POLL_MS intervals
 * and calls the provided `emit` callback with a tagged InputEmit intent.
 *
 * Behaviour mirrors app.js:1648-1688 (startGamepadPolling / stopGamepadPolling):
 *  - Emits {kind:"metadata"} exactly once on the first tick.
 *  - When no input is active (no physical gamepad, no keyboard input), emits
 *    {kind:"gamepad", state} with a neutral state every IDLE_FRAME_EVERY ticks.
 *  - When input IS active, emits {kind:"gamepad", state} every tick.
 *
 * The poller no longer owns seq or timestamp — those are the caller's
 * responsibility. This allows:
 *  - Browser path: the _startGamepadPoller callback holds its own seq counter,
 *    calls performance.now(), then re-encodes via encodeClientMetadata /
 *    encodeGamepadFrame — producing byte-identical wire packets.
 *  - Native path (6c.6): forwards gamepad state directly to Rust; the native
 *    engine assigns its own seq/ts, so they are not needed here.
 *
 * Keeps `navigator.getGamepads()` usage OUTSIDE the pure encoder so
 * encodeGamepadFrame remains deterministic and unit-testable.
 */
export class GamepadPoller {
  private readonly emit: (intent: InputEmit) => void;
  private readonly getKeyboardState: (() => Set<string>) | null;
  private readonly getMapping: () => ControllerMapping;

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private idleCounter = 0;
  private initialized = false;

  /**
   * @param emit              Callback invoked with each input intent.
   * @param getKeyboardState  Optional callback returning the set of currently
   *                          held keyboard codes (for keyboard-to-gamepad
   *                          mapping).  Pass null to disable keyboard input.
   * @param getMapping        Optional callback returning the current controller
   *                          remap. Defaults to DEFAULT_MAPPING (identity
   *                          no-op) so existing callers are unaffected.
   */
  constructor(
    emit: (intent: InputEmit) => void,
    getKeyboardState: (() => Set<string>) | null = null,
    getMapping: () => ControllerMapping = () => DEFAULT_MAPPING,
  ) {
    this.emit = emit;
    this.getKeyboardState = getKeyboardState;
    this.getMapping = getMapping;
  }

  /** Start polling. No-op if already running. */
  start(): void {
    if (this.intervalId !== null) return;

    this.intervalId = setInterval(() => {
      this.tick();
    }, GAMEPAD_POLL_MS);
  }

  /** Stop polling and reset internal state. */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.initialized = false;
    this.idleCounter = 0;
  }

  private tick(): void {
    // Emit ClientMetadata intent exactly once to initialise the input channel
    if (!this.initialized) {
      this.initialized = true;
      try {
        this.emit({ kind: "metadata" });
      } catch {
        this.initialized = false;
        return;
      }
    }

    // Determine active gamepad — physical first, then keyboard virtual
    const gamepads =
      typeof navigator !== "undefined" ? navigator.getGamepads() : null;
    const physicalGamepad =
      gamepads &&
      (gamepads[0] || gamepads[1] || gamepads[2] || gamepads[3]);

    let gamepadState: GamepadState | null = null;

    if (physicalGamepad) {
      // Convert Gamepad API object to our internal type
      const rawPhysical: GamepadState = {
        buttons: Array.from(physicalGamepad.buttons).map((b) => ({
          pressed: b.pressed,
          value: b.value,
        })),
        axes: [
          physicalGamepad.axes[0] ?? 0,
          physicalGamepad.axes[1] ?? 0,
          physicalGamepad.axes[2] ?? 0,
          physicalGamepad.axes[3] ?? 0,
        ],
      };
      gamepadState = applyRemap(rawPhysical, this.getMapping());
    } else if (this.getKeyboardState) {
      const keys = this.getKeyboardState();
      if (keys.size > 0) {
        const kbState = mapKeyboardToGamepad(keys);
        const hasInput =
          kbState.axes.some((a) => a !== 0) ||
          kbState.buttons.some((b) => b.pressed);
        if (hasInput) gamepadState = kbState;
      }
    }

    if (!gamepadState) {
      // No active input — emit idle frame every IDLE_FRAME_EVERY ticks
      this.idleCounter++;
      if (this.idleCounter < IDLE_FRAME_EVERY) return;
      this.idleCounter = 0;
    } else {
      this.idleCounter = 0;
    }

    try {
      // null gamepadState → emit neutral (all-zero) state
      const state: GamepadState = gamepadState ?? {
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
        axes: [0, 0, 0, 0],
      };
      this.emit({ kind: "gamepad", state });
    } catch {
      // Silently ignore emit errors during polling (matches app.js:1685-1687)
    }
  }
}
