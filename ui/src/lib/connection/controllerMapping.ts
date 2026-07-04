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
  OUTPUTS.map((o) => [o.id, o]),
);

/** Field-order-independent structural equality for two Sources. */
export function sourcesEqual(a: Source, b: Source): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "button" && b.kind === "button") return a.index === b.index;
  if (a.kind === "axis" && b.kind === "axis") return a.axis === b.axis && a.sign === b.sign;
  return a.kind === "none" && b.kind === "none";
}
