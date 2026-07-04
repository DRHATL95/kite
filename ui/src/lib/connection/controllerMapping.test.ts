import { describe, it, expect } from "vitest";
import { BUTTON_BITS } from "./constants.js";
import {
  OUTPUTS, OUTPUTS_BY_ID, GROUPS, DEFAULT_MAPPING, AXIS_ACTIVE_THRESHOLD, sourcesEqual,
} from "./controllerMapping.js";

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
