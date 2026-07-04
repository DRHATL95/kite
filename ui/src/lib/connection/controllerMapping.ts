/**
 * controllerMapping.ts — pure controller-remap model + transform.
 *
 * Output-centric: for each Xbox output slot, a Source feeds it. applyRemap
 * re-indexes a physical GamepadState into a logical one BEFORE the encoder.
 * No Svelte, no DOM — unit-testable in plain Vitest.
 */
import type { GamepadState, GamepadButton } from "./input.js";
import { STICK_DEADZONE } from "./constants.js";
import type { StorageLike } from "../settings/clipSettings.js";

export const AXIS_ACTIVE_THRESHOLD = 0.5;

export type Source =
  | { kind: "none" }
  | { kind: "button"; index: number }
  | { kind: "axis"; axis: 0 | 1 | 2 | 3; sign: 1 | -1 };

export type Destination =
  | { kind: "digital"; buttonIndex: number }
  | { kind: "trigger"; buttonIndex: 6 | 7 }
  | { kind: "stick"; axis: 0 | 1 | 2 | 3; sign: 1 | -1 };

export interface OutputDef {
  id: string;
  label: string;
  group: string;
  destination: Destination;
  defaultSource: Source;
}

/** Sparse override map: absent id ⇒ use that output's defaultSource. */
export type ControllerMapping = Record<string, Source>;
export const DEFAULT_MAPPING: ControllerMapping = {};

/** UI group order. */
export const GROUPS = [
  "Face Buttons",
  "Bumpers & Triggers",
  "D-Pad",
  "Left Stick",
  "Right Stick",
  "System",
] as const;

function digital(id: string, label: string, group: string, i: number): OutputDef {
  return { id, label, group, destination: { kind: "digital", buttonIndex: i }, defaultSource: { kind: "button", index: i } };
}
function trigger(id: string, label: string, i: 6 | 7): OutputDef {
  return { id, label, group: "Bumpers & Triggers", destination: { kind: "trigger", buttonIndex: i }, defaultSource: { kind: "button", index: i } };
}
function stick(id: string, label: string, group: string, axis: 0 | 1 | 2 | 3, sign: 1 | -1): OutputDef {
  return { id, label, group, destination: { kind: "stick", axis, sign }, defaultSource: { kind: "axis", axis, sign } };
}

export const OUTPUTS: OutputDef[] = [
  // Face Buttons
  digital("a", "A", "Face Buttons", 0),
  digital("b", "B", "Face Buttons", 1),
  digital("x", "X", "Face Buttons", 2),
  digital("y", "Y", "Face Buttons", 3),
  // Bumpers & Triggers
  digital("lb", "Left Bumper (LB)", "Bumpers & Triggers", 4),
  digital("rb", "Right Bumper (RB)", "Bumpers & Triggers", 5),
  trigger("lt", "Left Trigger (LT)", 6),
  trigger("rt", "Right Trigger (RT)", 7),
  // D-Pad
  digital("dpadUp", "D-Pad Up", "D-Pad", 12),
  digital("dpadDown", "D-Pad Down", "D-Pad", 13),
  digital("dpadLeft", "D-Pad Left", "D-Pad", 14),
  digital("dpadRight", "D-Pad Right", "D-Pad", 15),
  // Left Stick
  stick("lsUp", "Left Stick ↑", "Left Stick", 1, -1),
  stick("lsDown", "Left Stick ↓", "Left Stick", 1, 1),
  stick("lsLeft", "Left Stick ←", "Left Stick", 0, -1),
  stick("lsRight", "Left Stick →", "Left Stick", 0, 1),
  digital("ls", "Left Stick (Click)", "Left Stick", 10),
  // Right Stick
  stick("rsUp", "Right Stick ↑", "Right Stick", 3, -1),
  stick("rsDown", "Right Stick ↓", "Right Stick", 3, 1),
  stick("rsLeft", "Right Stick ←", "Right Stick", 2, -1),
  stick("rsRight", "Right Stick →", "Right Stick", 2, 1),
  digital("rs", "Right Stick (Click)", "Right Stick", 11),
  // System
  digital("view", "View", "System", 8),
  digital("menu", "Menu", "System", 9),
  digital("guide", "Guide", "System", 16),
];

export const OUTPUTS_BY_ID: Record<string, OutputDef> = Object.fromEntries(
  OUTPUTS.map((o) => [o.id, o] as const),
);

/** Field-order-independent structural equality for two Sources. */
export function sourcesEqual(a: Source, b: Source): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "button" && b.kind === "button") return a.index === b.index;
  if (a.kind === "axis" && b.kind === "axis") return a.axis === b.axis && a.sign === b.sign;
  return a.kind === "none" && b.kind === "none";
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Physical source magnitude in [0,1].
 * - Digital buttons (all indices EXCEPT 6/7): pressed ? 1 : 0 (IGNORE value — the
 *   encoder keys the bitmask off .pressed; some drivers report pressed digital
 *   buttons with value 0).
 * - Trigger buttons (6, 7): clamp01(value) — genuine analog.
 * - Axis: max(0, sign*axis); zeroed below STICK_DEADZONE so a resting stick used
 *   as a source contributes no phantom signal.
 */
export function sourceMagnitude(state: GamepadState, src: Source): number {
  switch (src.kind) {
    case "none":
      return 0;
    case "button": {
      const b = state.buttons[src.index];
      if (!b) return 0;
      if (src.index === 6 || src.index === 7) return clamp01(b.value);
      return b.pressed ? 1 : 0;
    }
    case "axis": {
      const mag = Math.max(0, src.sign * (state.axes[src.axis] ?? 0));
      return mag < STICK_DEADZONE ? 0 : mag;
    }
  }
}

/** Re-index a physical GamepadState into a logical one per the mapping. Pure. */
export function applyRemap(state: GamepadState, mapping: ControllerMapping): GamepadState {
  const buttons: GamepadButton[] = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  const axisPlus: [number, number, number, number] = [0, 0, 0, 0];
  const axisMinus: [number, number, number, number] = [0, 0, 0, 0];

  for (const out of OUTPUTS) {
    const src = mapping[out.id] ?? out.defaultSource;
    const mag = sourceMagnitude(state, src);
    const dest = out.destination;
    if (dest.kind === "digital") {
      const on = mag >= AXIS_ACTIVE_THRESHOLD;
      buttons[dest.buttonIndex] = { pressed: on, value: on ? 1 : 0 };
    } else if (dest.kind === "trigger") {
      buttons[dest.buttonIndex] = { pressed: mag > 0, value: mag };
    } else {
      if (dest.sign > 0) axisPlus[dest.axis] = mag;
      else axisMinus[dest.axis] = mag;
    }
  }

  const axes: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    axes[i] = Math.max(-1, Math.min(1, axisPlus[i] - axisMinus[i]));
  }
  return { buttons, axes };
}
