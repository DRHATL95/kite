/**
 * input.test.ts — byte-exact tests for the gamepad input encoder.
 *
 * Packet layout (38 bytes total) derived from ui/public/app.js lines 1597-1645:
 *
 *   Header (14 bytes):
 *     [0..1]  reportType  u16 LE  = REPORT_TYPE_GAMEPAD (2)
 *     [2..5]  sequence    u32 LE
 *     [6..13] timestamp   f64 LE  (performance.now() — injected for tests)
 *
 *   Frame count (1 byte):
 *     [14]    frameCount  u8  = 1
 *
 *   Gamepad frame (23 bytes, o=15):
 *     [15]    gamepadIndex  u8
 *     [16..17] buttons     u16 LE
 *     [18..19] leftThumbX  i16 LE
 *     [20..21] leftThumbY  i16 LE  (Y axis negated from Gamepad API value)
 *     [22..23] rightThumbX i16 LE
 *     [24..25] rightThumbY i16 LE  (Y axis negated)
 *     [26..27] leftTrigger  u16 LE
 *     [28..29] rightTrigger u16 LE
 *     [30..33] PhysicalPhysicality u32 LE = 1   (app.js:1642)
 *     [34..37] VirtualPhysicality  u32 BE = 1   (app.js:1643)
 *
 * ClientMetadata packet (15 bytes):
 *     [0..1]  reportType  u16 LE  = REPORT_TYPE_CLIENT_METADATA (8)
 *     [2..5]  sequence    u32 LE
 *     [6..13] timestamp   f64 LE
 *     [14]    maxTouchpoints u8  = 1
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  encodeGamepadFrame,
  encodeClientMetadata,
  encodeInputEmit,
  applyDeadzone,
  normalizeAxis,
  normalizeTrigger,
  mapKeyboardToGamepad,
  GamepadPoller,
  type GamepadState,
  type InputEmit,
} from "./input.js";
import {
  REPORT_TYPE_GAMEPAD,
  REPORT_TYPE_CLIENT_METADATA,
  BUTTON_BITS,
  STICK_DEADZONE,
  IDLE_FRAME_EVERY,
} from "./constants.js";
import { applyRemap } from "./controllerMapping.js"; // ensure import graph is exercised

// ── Helper: read a u16 LE at offset ──────────────────────────────────────────
function readU16LE(buf: Uint8Array, offset: number): number {
  return buf[offset]! | (buf[offset + 1]! << 8);
}

// ── Helper: read a u32 LE at offset ──────────────────────────────────────────
function readU32LE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset]! |
      (buf[offset + 1]! << 8) |
      (buf[offset + 2]! << 16) |
      (buf[offset + 3]! << 24)) >>>
    0
  );
}

// ── Helper: read a u32 BE at offset ──────────────────────────────────────────
function readU32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset]! << 24) |
      (buf[offset + 1]! << 16) |
      (buf[offset + 2]! << 8) |
      buf[offset + 3]!) >>>
    0
  );
}

// ── Helper: read an i16 LE at offset ─────────────────────────────────────────
function readI16LE(buf: Uint8Array, offset: number): number {
  const raw = buf[offset]! | (buf[offset + 1]! << 8);
  return raw >= 0x8000 ? raw - 0x10000 : raw;
}

// ── Helper: read a f64 LE at offset ──────────────────────────────────────────
function readF64LE(buf: Uint8Array, offset: number): number {
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return dv.getFloat64(offset, true);
}

// ── Neutral gamepad state (all zeros) ────────────────────────────────────────
function neutralState(): GamepadState {
  return {
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    axes: [0, 0, 0, 0],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// encodeGamepadFrame
// ─────────────────────────────────────────────────────────────────────────────

describe("encodeGamepadFrame — neutral frame", () => {
  const SEQ = 7;
  const TS = 12345.678;
  const state = neutralState();
  const buf = encodeGamepadFrame(state, SEQ, TS);

  it("total length is 38 bytes", () => {
    expect(buf.byteLength).toBe(38);
  });

  it("reportType is REPORT_TYPE_GAMEPAD (2) at bytes 0-1 LE", () => {
    expect(readU16LE(buf, 0)).toBe(REPORT_TYPE_GAMEPAD);
  });

  it("sequence at bytes 2-5 LE matches injected seq", () => {
    expect(readU32LE(buf, 2)).toBe(SEQ);
  });

  it("timestamp at bytes 6-13 LE matches injected timestamp", () => {
    expect(readF64LE(buf, 6)).toBeCloseTo(TS, 5);
  });

  it("frameCount at byte 14 is 1", () => {
    expect(buf[14]).toBe(1);
  });

  it("gamepadIndex at byte 15 is 0", () => {
    expect(buf[15]).toBe(0);
  });

  it("buttons at bytes 16-17 LE is 0 for neutral", () => {
    expect(readU16LE(buf, 16)).toBe(0);
  });

  it("all axes are 0 for neutral input", () => {
    expect(readI16LE(buf, 18)).toBe(0); // LeftThumbX
    expect(readI16LE(buf, 20)).toBe(0); // LeftThumbY
    expect(readI16LE(buf, 22)).toBe(0); // RightThumbX
    expect(readI16LE(buf, 24)).toBe(0); // RightThumbY
  });

  it("both triggers are 0 for neutral input", () => {
    expect(readU16LE(buf, 26)).toBe(0); // LeftTrigger
    expect(readU16LE(buf, 28)).toBe(0); // RightTrigger
  });

  it("PhysicalPhysicality at bytes 30-33 is 1 LE", () => {
    // app.js:1642 — view.setUint32(o + 14, 1, true)  (LE = 0x01 0x00 0x00 0x00)
    expect(readU32LE(buf, 30)).toBe(1);
    expect(buf[30]).toBe(1);
    expect(buf[31]).toBe(0);
    expect(buf[32]).toBe(0);
    expect(buf[33]).toBe(0);
  });

  it("VirtualPhysicality at bytes 34-37 is 1 BE", () => {
    // app.js:1643 — view.setUint32(o + 18, 1, false)  (BE = 0x00 0x00 0x00 0x01)
    expect(readU32BE(buf, 34)).toBe(1);
    expect(buf[34]).toBe(0);
    expect(buf[35]).toBe(0);
    expect(buf[36]).toBe(0);
    expect(buf[37]).toBe(1);
  });

  it("VirtualPhysicality byte order differs from LE encoding of 1", () => {
    // LE would be [1,0,0,0]; BE is [0,0,0,1] — verify they differ
    const physBytes = [buf[30], buf[31], buf[32], buf[33]]; // LE
    const virtBytes = [buf[34], buf[35], buf[36], buf[37]]; // BE
    expect(physBytes).toEqual([1, 0, 0, 0]);
    expect(virtBytes).toEqual([0, 0, 0, 1]);
    expect(physBytes).not.toEqual(virtBytes);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("encodeGamepadFrame — button A pressed", () => {
  const state = neutralState();
  // Button index 0 → BUTTON_BITS[0] = 16
  state.buttons[0] = { pressed: true, value: 1 };
  const buf = encodeGamepadFrame(state, 0, 0);

  it("buttons field has bit for A set (BUTTON_BITS[0] = 16)", () => {
    const buttons = readU16LE(buf, 16);
    expect(buttons & BUTTON_BITS[0]!).toBe(BUTTON_BITS[0]);
    expect(buttons).toBe(16);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("encodeGamepadFrame — button Y pressed", () => {
  const state = neutralState();
  // Button index 3 → BUTTON_BITS[3] = 128
  state.buttons[3] = { pressed: true, value: 1 };
  const buf = encodeGamepadFrame(state, 0, 0);

  it("buttons field has bit for Y set (BUTTON_BITS[3] = 128)", () => {
    const buttons = readU16LE(buf, 16);
    expect(buttons & BUTTON_BITS[3]!).toBe(BUTTON_BITS[3]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("encodeGamepadFrame — multiple buttons pressed", () => {
  const state = neutralState();
  // A (bit 16) + B (bit 32) = 48
  state.buttons[0] = { pressed: true, value: 1 };
  state.buttons[1] = { pressed: true, value: 1 };
  const buf = encodeGamepadFrame(state, 0, 0);

  it("buttons field ORs all pressed button bits", () => {
    expect(readU16LE(buf, 16)).toBe(16 | 32);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("encodeGamepadFrame — left-stick full-left (axes[0] = -1)", () => {
  const state = neutralState();
  state.axes[0] = -1;
  const buf = encodeGamepadFrame(state, 0, 0);

  it("LeftThumbX is -32767 (normalizeAxis(-1) = -32767)", () => {
    expect(readI16LE(buf, 18)).toBe(-32767);
  });

  it("LeftThumbY is 0 (axis[1] = 0)", () => {
    expect(readI16LE(buf, 20)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("encodeGamepadFrame — left-stick full-down (axes[1] = +1)", () => {
  const state = neutralState();
  state.axes[1] = 1; // gamepad Y=+1 means down; protocol Y is negated
  const buf = encodeGamepadFrame(state, 0, 0);

  it("LeftThumbY is -32767 due to Y-axis negation", () => {
    // app.js:1631 — normalizeAxis(-ly) where ly=1  → normalizeAxis(-1) = -32767
    expect(readI16LE(buf, 20)).toBe(-32767);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("encodeGamepadFrame — left-stick full-up (axes[1] = -1)", () => {
  const state = neutralState();
  state.axes[1] = -1; // gamepad Y=-1 means up; protocol Y is negated
  const buf = encodeGamepadFrame(state, 0, 0);

  it("LeftThumbY is +32767 due to Y-axis negation", () => {
    // app.js:1631 — normalizeAxis(-(-1)) = normalizeAxis(+1) = 32767
    expect(readI16LE(buf, 20)).toBe(32767);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("encodeGamepadFrame — right-stick Y-axis negation", () => {
  const state = neutralState();
  state.axes[3] = 0.5; // gamepad ry = 0.5 → normalizeAxis(-0.5) = -16383
  const buf = encodeGamepadFrame(state, 0, 0);

  it("RightThumbY is negated (axes[3]=0.5 → -16383 or -16384)", () => {
    const ry = readI16LE(buf, 24);
    // Math.round(-0.5 * 32767) = -16384 (rounds away from zero)
    expect(ry).toBe(Math.round(-0.5 * 32767));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("encodeGamepadFrame — triggers", () => {
  const state = neutralState();
  // Left trigger full pull (button index 6, value 1.0)
  state.buttons[6] = { pressed: true, value: 1.0 };
  // Right trigger half pull (button index 7, value 0.5)
  state.buttons[7] = { pressed: true, value: 0.5 };
  const buf = encodeGamepadFrame(state, 0, 0);

  it("LeftTrigger full = 65535", () => {
    expect(readU16LE(buf, 26)).toBe(65535);
  });

  it("RightTrigger half = 32767 or 32768", () => {
    // Math.round(0.5 * 65535) = 32768 (actually 32767.5 rounds up in JS)
    const rt = readU16LE(buf, 28);
    expect(rt).toBe(Math.round(0.5 * 65535));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("encodeGamepadFrame — deadzone", () => {
  const state = neutralState();
  // Stick value within deadzone threshold (0.09 < 0.1 = STICK_DEADZONE)
  state.axes[0] = STICK_DEADZONE - 0.01; // 0.09 — below deadzone
  const buf = encodeGamepadFrame(state, 0, 0);

  it("axis within deadzone clamps to 0", () => {
    expect(readI16LE(buf, 18)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("encodeGamepadFrame — sequence increments are reflected", () => {
  const state = neutralState();
  const buf1 = encodeGamepadFrame(state, 0, 0);
  const buf2 = encodeGamepadFrame(state, 1, 0);
  const buf3 = encodeGamepadFrame(state, 42, 0);

  it("seq=0 encodes as 0", () => {
    expect(readU32LE(buf1, 2)).toBe(0);
  });

  it("seq=1 encodes as 1", () => {
    expect(readU32LE(buf2, 2)).toBe(1);
  });

  it("seq=42 encodes as 42", () => {
    expect(readU32LE(buf3, 2)).toBe(42);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// encodeClientMetadata
// ─────────────────────────────────────────────────────────────────────────────

describe("encodeClientMetadata", () => {
  const SEQ = 3;
  const TS = 9999.0;
  const buf = encodeClientMetadata(SEQ, TS);

  it("total length is 15 bytes", () => {
    expect(buf.byteLength).toBe(15);
  });

  it("reportType is REPORT_TYPE_CLIENT_METADATA (8)", () => {
    expect(readU16LE(buf, 0)).toBe(REPORT_TYPE_CLIENT_METADATA);
  });

  it("sequence matches injected value", () => {
    expect(readU32LE(buf, 2)).toBe(SEQ);
  });

  it("timestamp matches injected value", () => {
    expect(readF64LE(buf, 6)).toBeCloseTo(TS, 5);
  });

  it("maxTouchpoints at byte 14 is 1", () => {
    expect(buf[14]).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper function unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("applyDeadzone", () => {
  it("value below threshold returns 0", () => {
    expect(applyDeadzone(0.05)).toBe(0);
    expect(applyDeadzone(-0.05)).toBe(0);
    expect(applyDeadzone(0.09)).toBe(0);
  });

  it("value exactly at threshold returns 0", () => {
    // Math.abs(0.1) < 0.1 is false, so value passes through — but boundary
    // app.js:1572: Math.abs(value) < STICK_DEADZONE — strictly less than
    expect(applyDeadzone(STICK_DEADZONE)).toBe(STICK_DEADZONE);
  });

  it("value above threshold passes through", () => {
    expect(applyDeadzone(0.11)).toBe(0.11);
    expect(applyDeadzone(-0.5)).toBe(-0.5);
    expect(applyDeadzone(1.0)).toBe(1.0);
  });
});

describe("normalizeAxis", () => {
  it("+1.0 normalizes to +32767", () => {
    expect(normalizeAxis(1.0)).toBe(32767);
  });

  it("-1.0 normalizes to -32767", () => {
    expect(normalizeAxis(-1.0)).toBe(-32767);
  });

  it("0.0 normalizes to 0", () => {
    expect(normalizeAxis(0.0)).toBe(0);
  });

  it("values are clamped to [-32767, +32767]", () => {
    expect(normalizeAxis(2.0)).toBe(32767);
    expect(normalizeAxis(-2.0)).toBe(-32767);
  });
});

describe("normalizeTrigger", () => {
  it("1.0 normalizes to 65535", () => {
    expect(normalizeTrigger(1.0)).toBe(65535);
  });

  it("0.0 normalizes to 0", () => {
    expect(normalizeTrigger(0.0)).toBe(0);
  });

  it("negative values clamp to 0", () => {
    expect(normalizeTrigger(-0.5)).toBe(0);
  });

  it("values above 1.0 clamp to 65535", () => {
    expect(normalizeTrigger(2.0)).toBe(65535);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mapKeyboardToGamepad
// ─────────────────────────────────────────────────────────────────────────────

describe("mapKeyboardToGamepad", () => {
  it("empty key set returns neutral gamepad state", () => {
    const state = mapKeyboardToGamepad(new Set());
    expect(state.buttons.every((b) => !b.pressed)).toBe(true);
    expect(state.axes.every((a) => a === 0)).toBe(true);
  });

  it("Space maps to button A (index 0)", () => {
    const state = mapKeyboardToGamepad(new Set(["Space"]));
    expect(state.buttons[0]?.pressed).toBe(true);
  });

  it("KeyW maps to left stick up (axes[1] = -1)", () => {
    const state = mapKeyboardToGamepad(new Set(["KeyW"]));
    expect(state.axes[1]).toBe(-1);
  });

  it("KeyS maps to left stick down (axes[1] = +1)", () => {
    const state = mapKeyboardToGamepad(new Set(["KeyS"]));
    expect(state.axes[1]).toBe(1);
  });

  it("KeyA + KeyD cancel out to 0 on X axis", () => {
    const state = mapKeyboardToGamepad(new Set(["KeyA", "KeyD"]));
    expect(state.axes[0]).toBe(0);
  });

  it("ArrowUp maps to DPad Up (button index 12)", () => {
    const state = mapKeyboardToGamepad(new Set(["ArrowUp"]));
    expect(state.buttons[12]?.pressed).toBe(true);
  });

  it("Enter maps to Menu/Start (button index 9)", () => {
    const state = mapKeyboardToGamepad(new Set(["Enter"]));
    expect(state.buttons[9]?.pressed).toBe(true);
  });

  it("Digit1 maps to LT (button index 6, value 1)", () => {
    const state = mapKeyboardToGamepad(new Set(["Digit1"]));
    expect(state.buttons[6]?.pressed).toBe(true);
    expect(state.buttons[6]?.value).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GamepadPoller — tagged InputEmit callback
// ─────────────────────────────────────────────────────────────────────────────

describe("GamepadPoller — tagged InputEmit callback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Stub navigator.getGamepads to return no physical gamepad
    vi.stubGlobal("navigator", {
      getGamepads: () => [null, null, null, null],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("first emit is {kind:'metadata'}, subsequent emits are {kind:'gamepad'}", () => {
    const emits: InputEmit[] = [];
    const poller = new GamepadPoller((emit) => emits.push(emit), null);

    poller.start();

    // First tick: should emit metadata
    vi.advanceTimersByTime(16);
    expect(emits).toHaveLength(1);
    expect(emits[0]?.kind).toBe("metadata");

    // Subsequent ticks with no gamepad → idle cadence; force enough ticks to
    // get past IDLE_FRAME_EVERY so the second emit (gamepad) fires.
    // IDLE_FRAME_EVERY is 62, so advance 62 more ticks.
    vi.advanceTimersByTime(16 * IDLE_FRAME_EVERY);
    const gamepadEmits = emits.filter((e) => e.kind === "gamepad");
    expect(gamepadEmits.length).toBeGreaterThanOrEqual(1);
    expect(gamepadEmits[0]?.kind).toBe("gamepad");

    poller.stop();
  });

  it("encodeInputEmit({kind:'metadata'}, 7, 1234) equals encodeClientMetadata(7, 1234) and is 15 bytes", () => {
    const via_dispatch = encodeInputEmit({ kind: "metadata" }, 7, 1234);
    const direct = encodeClientMetadata(7, 1234);

    expect(via_dispatch).toStrictEqual(direct);
    expect(via_dispatch.byteLength).toBe(15);
  });

  it("encodeInputEmit({kind:'gamepad', state}, 8, 5678) equals encodeGamepadFrame(state, 8, 5678) and is 38 bytes", () => {
    const state: GamepadState = {
      buttons: Array.from({ length: 17 }, (_: unknown, i: number) => ({
        pressed: i === 0,
        value: i === 0 ? 1 : 0,
      })),
      axes: [-1, 0.5, 0, -0.25],
    };

    const via_dispatch = encodeInputEmit({ kind: "gamepad", state }, 8, 5678);
    const direct = encodeGamepadFrame(state, 8, 5678);

    expect(via_dispatch).toStrictEqual(direct);
    expect(via_dispatch.byteLength).toBe(38);
  });

  it("gamepad emit carries the correct GamepadState shape", () => {
    // Stub a gamepad with button A pressed and left-stick full-left
    const pressedGamepad = {
      buttons: Array.from({ length: 17 }, (_: unknown, i: number) => ({
        pressed: i === 0,
        value: i === 0 ? 1 : 0,
      })),
      axes: [-1, 0, 0, 0],
    };
    vi.stubGlobal("navigator", {
      getGamepads: () => [pressedGamepad, null, null, null],
    });

    const emits: InputEmit[] = [];
    const poller = new GamepadPoller((emit) => emits.push(emit), null);

    poller.start();
    vi.advanceTimersByTime(16); // metadata
    vi.advanceTimersByTime(16); // gamepad
    poller.stop();

    const gamepadEmit = emits.find((e) => e.kind === "gamepad");
    if (gamepadEmit?.kind !== "gamepad") throw new Error("no gamepad emit");

    expect(gamepadEmit.state.buttons[0]?.pressed).toBe(true);
    expect(gamepadEmit.state.axes[0]).toBe(-1);

    // Verify encoding round-trip produces correct bytes
    const buf = encodeGamepadFrame(gamepadEmit.state, 0, 0);
    expect(buf.byteLength).toBe(38);
    // Button A (bit 16) should be set
    const buttons = buf[16]! | (buf[17]! << 8);
    expect(buttons & 16).toBe(16);
    // LeftThumbX should be -32767
    const lx = buf[18]! | (buf[19]! << 8);
    const lxSigned = lx >= 0x8000 ? lx - 0x10000 : lx;
    expect(lxSigned).toBe(-32767);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GamepadPoller — controller remap
// ─────────────────────────────────────────────────────────────────────────────

describe("GamepadPoller — controller remap", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  function padWithButton0Pressed(): Gamepad {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false }));
    buttons[0] = { pressed: true, value: 1, touched: true };
    return { buttons, axes: [0, 0, 0, 0], connected: true, id: "test", index: 0, mapping: "standard", timestamp: 0 } as unknown as Gamepad;
  }

  it("applies the mapping to physical input (B ← physical A, A ← none)", () => {
    vi.stubGlobal("navigator", { getGamepads: () => [padWithButton0Pressed(), null, null, null] });
    const emits: InputEmit[] = [];
    const mapping = { a: { kind: "none" as const }, b: { kind: "button" as const, index: 0 } };
    const poller = new GamepadPoller((e) => emits.push(e), null, () => mapping);
    poller.start();
    vi.advanceTimersByTime(16); // metadata
    vi.advanceTimersByTime(16); // gamepad
    poller.stop();
    const g = emits.find((e) => e.kind === "gamepad");
    if (g?.kind !== "gamepad") throw new Error("no gamepad emit");
    expect(g.state.buttons[0].pressed).toBe(false); // A now unbound
    expect(g.state.buttons[1].pressed).toBe(true);  // B driven by physical A
  });

  it("default mapping (2-arg construction) leaves physical input unchanged", () => {
    vi.stubGlobal("navigator", { getGamepads: () => [padWithButton0Pressed(), null, null, null] });
    const emits: InputEmit[] = [];
    const poller = new GamepadPoller((e) => emits.push(e), null); // no getMapping
    poller.start();
    vi.advanceTimersByTime(16);
    vi.advanceTimersByTime(16);
    poller.stop();
    const g = emits.find((e) => e.kind === "gamepad");
    if (g?.kind !== "gamepad") throw new Error("no gamepad emit");
    expect(g.state.buttons[0].pressed).toBe(true);
  });
});
