import { describe, it, expect } from "vitest";
import { BUTTON_BITS } from "./constants.js";
import {
  OUTPUTS, OUTPUTS_BY_ID, GROUPS, DEFAULT_MAPPING, AXIS_ACTIVE_THRESHOLD, sourcesEqual,
} from "./controllerMapping.js";
import { encodeGamepadFrame, type GamepadState } from "./input.js";
import { sourceMagnitude, applyRemap } from "./controllerMapping.js";

describe("controllerMapping — model", () => {
  it("has 25 outputs: 15 digital + 2 trigger + 8 stick", () => {
    expect(OUTPUTS).toHaveLength(25);
    const digital = OUTPUTS.filter((o) => o.destination.kind === "digital");
    const trigger = OUTPUTS.filter((o) => o.destination.kind === "trigger");
    const stick = OUTPUTS.filter((o) => o.destination.kind === "stick");
    expect(digital).toHaveLength(15);
    expect(trigger).toHaveLength(2);
    expect(stick).toHaveLength(8);
  });

  it("digital output destinations are exactly the BUTTON_BITS indices", () => {
    const digitalIdx = OUTPUTS
      .filter((o) => o.destination.kind === "digital")
      .map((o) => (o.destination as { buttonIndex: number }).buttonIndex)
      .sort((a, b) => a - b);
    const bitsIdx = Object.keys(BUTTON_BITS).map(Number).sort((a, b) => a - b);
    expect(digitalIdx).toEqual(bitsIdx);
  });

  it("every default source round-trips to its own destination (identity table)", () => {
    for (const o of OUTPUTS) {
      if (o.destination.kind === "digital" || o.destination.kind === "trigger") {
        expect(o.defaultSource).toEqual({ kind: "button", index: o.destination.buttonIndex });
      } else {
        expect(o.defaultSource).toEqual({ kind: "axis", axis: o.destination.axis, sign: o.destination.sign });
      }
    }
  });

  it("OUTPUTS_BY_ID indexes every output; GROUPS covers every output's group", () => {
    for (const o of OUTPUTS) expect(OUTPUTS_BY_ID[o.id]).toBe(o);
    for (const o of OUTPUTS) expect(GROUPS).toContain(o.group);
  });

  it("DEFAULT_MAPPING is empty and AXIS_ACTIVE_THRESHOLD is 0.5", () => {
    expect(DEFAULT_MAPPING).toEqual({});
    expect(AXIS_ACTIVE_THRESHOLD).toBe(0.5);
  });

  it("sourcesEqual is field-order-independent and distinguishes kinds", () => {
    expect(sourcesEqual({ kind: "axis", axis: 0, sign: 1 }, { kind: "axis", sign: 1, axis: 0 } as never)).toBe(true);
    expect(sourcesEqual({ kind: "button", index: 4 }, { kind: "button", index: 4 })).toBe(true);
    expect(sourcesEqual({ kind: "button", index: 4 }, { kind: "button", index: 5 })).toBe(false);
    expect(sourcesEqual({ kind: "none" }, { kind: "button", index: 0 })).toBe(false);
    expect(sourcesEqual({ kind: "axis", axis: 0, sign: 1 }, { kind: "axis", axis: 0, sign: -1 })).toBe(false);
  });
});

/** Build a GamepadState with 17 neutral buttons + given overrides. */
function gp(over: Partial<{ buttons: Record<number, { pressed: boolean; value: number }>; axes: [number, number, number, number] }> = {}): GamepadState {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  for (const [i, b] of Object.entries(over.buttons ?? {})) buttons[Number(i)] = b;
  return { buttons, axes: over.axes ?? [0, 0, 0, 0] };
}

describe("controllerMapping — applyRemap identity (keystone)", () => {
  const cases: [string, GamepadState][] = [
    ["neutral", gp()],
    ["A pressed value1", gp({ buttons: { 0: { pressed: true, value: 1 } } })],
    ["A pressed value0 (buggy driver)", gp({ buttons: { 0: { pressed: true, value: 0 } } })],
    ["Guide pressed value0.4", gp({ buttons: { 16: { pressed: true, value: 0.4 } } })],
    ["partial LT", gp({ buttons: { 6: { pressed: true, value: 0.37 } } })],
    ["sticks", gp({ axes: [0.5, -0.8, -0.2, 0.9] })],
    ["sub-deadzone drift", gp({ axes: [0.03, -0.05, 0.0, 0.07] })],
  ];
  for (const [name, state] of cases) {
    it(`identity remap reproduces the full 38-byte frame: ${name}`, () => {
      const remapped = applyRemap(state, {});
      expect(Array.from(encodeGamepadFrame(remapped, 7, 123.5)))
        .toEqual(Array.from(encodeGamepadFrame(state, 7, 123.5)));
    });
  }

  it("identity holds for a short (<17) physical buttons array", () => {
    const short: GamepadState = { buttons: Array.from({ length: 11 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0] };
    const r = applyRemap(short, {});
    expect(r.buttons).toHaveLength(17);
    expect(Array.from(encodeGamepadFrame(r, 1, 0))).toEqual(Array.from(encodeGamepadFrame(short, 1, 0)));
  });
});

describe("controllerMapping — sourceMagnitude", () => {
  it("digital button uses pressed, ignoring value", () => {
    expect(sourceMagnitude(gp({ buttons: { 0: { pressed: true, value: 0 } } }), { kind: "button", index: 0 })).toBe(1);
    expect(sourceMagnitude(gp({ buttons: { 0: { pressed: false, value: 0.9 } } }), { kind: "button", index: 0 })).toBe(0);
  });
  it("trigger button (6/7) uses analog value", () => {
    expect(sourceMagnitude(gp({ buttons: { 6: { pressed: true, value: 0.4 } } }), { kind: "button", index: 6 })).toBeCloseTo(0.4);
  });
  it("axis source is deadzoned below STICK_DEADZONE", () => {
    expect(sourceMagnitude(gp({ axes: [0.05, 0, 0, 0] }), { kind: "axis", axis: 0, sign: 1 })).toBe(0);
    expect(sourceMagnitude(gp({ axes: [0.6, 0, 0, 0] }), { kind: "axis", axis: 0, sign: 1 })).toBeCloseTo(0.6);
    expect(sourceMagnitude(gp({ axes: [0.6, 0, 0, 0] }), { kind: "axis", axis: 0, sign: -1 })).toBe(0);
  });
  it("none and missing index are 0", () => {
    expect(sourceMagnitude(gp(), { kind: "none" })).toBe(0);
    expect(sourceMagnitude(gp(), { kind: "button", index: 99 })).toBe(0);
  });
});

describe("controllerMapping — applyRemap cross-type", () => {
  it("swaps A and B", () => {
    const r = applyRemap(gp({ buttons: { 0: { pressed: true, value: 1 } } }), { a: { kind: "button", index: 1 }, b: { kind: "button", index: 0 } });
    expect(r.buttons[0].pressed).toBe(false); // A driven by physical B (not pressed)
    expect(r.buttons[1].pressed).toBe(true);  // B driven by physical A (pressed)
  });
  it("button → trigger emits full deflection", () => {
    const r = applyRemap(gp({ buttons: { 0: { pressed: true, value: 1 } } }), { lt: { kind: "button", index: 0 } });
    expect(r.buttons[6].value).toBe(1);
  });
  it("stick deflection → button fires at threshold", () => {
    const r = applyRemap(gp({ axes: [0.9, 0, 0, 0] }), { a: { kind: "axis", axis: 0, sign: 1 } });
    expect(r.buttons[0].pressed).toBe(true);
    const r2 = applyRemap(gp({ axes: [0.3, 0, 0, 0] }), { a: { kind: "axis", axis: 0, sign: 1 } });
    expect(r2.buttons[0].pressed).toBe(false);
  });
  it("opposing half-axes combine and clamp", () => {
    // lsLeft ← axis0+ , lsRight ← axis0+ (both driven by same +axis) → subtract to 0
    const r = applyRemap(gp({ axes: [0.7, 0, 0, 0] }), { lsLeft: { kind: "axis", axis: 0, sign: 1 } });
    // lsLeft(dest axis0 sign-1) now driven by +0.7 → axisMinus[0]=0.7; lsRight default axis0+ → axisPlus[0]=0.7; net 0
    expect(r.axes[0]).toBeCloseTo(0);
  });
  it("resting stick source to a trigger yields 0 (deadzone)", () => {
    const r = applyRemap(gp({ axes: [0.05, 0, 0, 0] }), { lt: { kind: "axis", axis: 0, sign: 1 } });
    expect(r.buttons[6].value).toBe(0);
  });
});

import {
  validateMapping, loadMapping, saveMapping,
  sourceToOptionKey, optionKeyToSource, describeSource, SOURCE_OPTION_GROUPS,
} from "./controllerMapping.js";

function mem(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => void m.set(k, v), _m: m };
}

describe("controllerMapping — persistence", () => {
  it("round-trips a valid override map", () => {
    const s = mem();
    saveMapping(s, { a: { kind: "button", index: 1 }, lsUp: { kind: "axis", axis: 1, sign: -1 } });
    expect(loadMapping(s)).toEqual({ a: { kind: "button", index: 1 }, lsUp: { kind: "axis", axis: 1, sign: -1 } });
  });
  it("returns a FRESH empty object when nothing stored (not the shared singleton)", () => {
    const a = loadMapping(mem());
    const b = loadMapping(mem());
    expect(a).toEqual({});
    a.x = { kind: "none" };
    expect(b).toEqual({}); // not aliased
  });
  it("corrupt JSON → fresh {}", () => {
    expect(loadMapping(mem({ "kite:controller-mapping": "{not json" }))).toEqual({});
  });
  it("PRESERVES unknown-but-valid keys (downgrade-safe) and drops malformed entries", () => {
    const raw = JSON.stringify({
      a: { kind: "button", index: 1 },
      futureThing: { kind: "button", index: 3 }, // unknown output id, valid Source
      bad1: { kind: "button" },                   // malformed
      bad2: { kind: "axis", axis: 9, sign: 2 },   // out of range
      bad3: "nope",
    });
    expect(validateMapping(JSON.parse(raw))).toEqual({
      a: { kind: "button", index: 1 },
      futureThing: { kind: "button", index: 3 },
    });
  });
  it("validateMapping tolerates non-objects", () => {
    expect(validateMapping(null)).toEqual({});
    expect(validateMapping(42)).toEqual({});
  });
});

describe("controllerMapping — option keys + describe", () => {
  it("option keys are reversible", () => {
    const srcs = [{ kind: "none" }, { kind: "button", index: 6 }, { kind: "axis", axis: 0, sign: -1 }] as const;
    for (const s of srcs) expect(optionKeyToSource(sourceToOptionKey(s))).toEqual(s);
  });
  it("optionKeyToSource rejects junk → none", () => {
    expect(optionKeyToSource("garbage")).toEqual({ kind: "none" });
    expect(optionKeyToSource("axis:9:2")).toEqual({ kind: "none" });
  });
  it("optionKeyToSource rejects empty numeric segments → none", () => {
    expect(optionKeyToSource("button:")).toEqual({ kind: "none" });
    expect(optionKeyToSource("axis:0:")).toEqual({ kind: "none" });
  });
  it("describeSource labels", () => {
    expect(describeSource({ kind: "none" })).toBe("None");
    expect(describeSource({ kind: "button", index: 0 })).toBe("A");
    expect(describeSource({ kind: "button", index: 6 })).toBe("Left Trigger");
    expect(describeSource({ kind: "axis", axis: 0, sign: 1 })).toBe("Left Stick →");
  });
  it("SOURCE_OPTION_GROUPS covers none + 17 buttons + 8 axis dirs", () => {
    const all = SOURCE_OPTION_GROUPS.flatMap((g) => g.sources);
    expect(all.filter((s) => s.kind === "none")).toHaveLength(1);
    expect(all.filter((s) => s.kind === "button")).toHaveLength(17);
    expect(all.filter((s) => s.kind === "axis")).toHaveLength(8);
  });
});
