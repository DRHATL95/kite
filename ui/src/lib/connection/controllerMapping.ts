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

const STORAGE_KEY = "kite:controller-mapping";

/** Structurally validate a single Source; null if malformed. */
function validateSource(raw: unknown): Source | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === "none") return { kind: "none" };
  if (r.kind === "button" && typeof r.index === "number" && r.index >= 0 && r.index <= 16 && Number.isInteger(r.index)) {
    return { kind: "button", index: r.index };
  }
  if (r.kind === "axis" && (r.axis === 0 || r.axis === 1 || r.axis === 2 || r.axis === 3) && (r.sign === 1 || r.sign === -1)) {
    return { kind: "axis", axis: r.axis, sign: r.sign };
  }
  return null;
}

/**
 * Keep every key whose value is a structurally valid Source — INCLUDING keys that
 * are not (yet) a known OutputDef.id (downgrade-safe: an older build round-trips a
 * newer build's binding instead of erasing it). applyRemap ignores unknown keys.
 */
export function validateMapping(raw: unknown): ControllerMapping {
  if (typeof raw !== "object" || raw === null) return {};
  const out: ControllerMapping = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const s = validateSource(v);
    if (s) out[k] = s;
  }
  return out;
}

export function loadMapping(storage: StorageLike): ControllerMapping {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return {};
  try {
    return validateMapping(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function saveMapping(storage: StorageLike, m: ControllerMapping): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(m));
}

/** Stable <select> option keys: "none" | "button:<i>" | "axis:<a>:<s>". */
export function sourceToOptionKey(src: Source): string {
  if (src.kind === "none") return "none";
  if (src.kind === "button") return `button:${src.index}`;
  return `axis:${src.axis}:${src.sign}`;
}

export function optionKeyToSource(key: string): Source {
  if (key === "none") return { kind: "none" };
  const parts = key.split(":");
  if (parts[0] === "button") {
    const i = Number(parts[1]);
    if (parts[1] !== "" && Number.isInteger(i) && i >= 0 && i <= 16) return { kind: "button", index: i };
  } else if (parts[0] === "axis") {
    const a = Number(parts[1]);
    const s = Number(parts[2]);
    if (parts[1] !== "" && parts[2] !== "" && (a === 0 || a === 1 || a === 2 || a === 3) && (s === 1 || s === -1)) {
      return { kind: "axis", axis: a as 0 | 1 | 2 | 3, sign: s as 1 | -1 };
    }
  }
  return { kind: "none" };
}

const BUTTON_LABELS: Record<number, string> = {
  0: "A", 1: "B", 2: "X", 3: "Y", 4: "Left Bumper", 5: "Right Bumper",
  6: "Left Trigger", 7: "Right Trigger", 8: "View", 9: "Menu",
  10: "Left Stick (Click)", 11: "Right Stick (Click)",
  12: "D-Pad Up", 13: "D-Pad Down", 14: "D-Pad Left", 15: "D-Pad Right", 16: "Guide",
};
const AXIS_LABELS: Record<string, string> = {
  "0:1": "Left Stick →", "0:-1": "Left Stick ←", "1:1": "Left Stick ↓", "1:-1": "Left Stick ↑",
  "2:1": "Right Stick →", "2:-1": "Right Stick ←", "3:1": "Right Stick ↓", "3:-1": "Right Stick ↑",
};

export function describeSource(src: Source): string {
  if (src.kind === "none") return "None";
  if (src.kind === "button") return BUTTON_LABELS[src.index] ?? `Button ${src.index}`;
  return AXIS_LABELS[`${src.axis}:${src.sign}`] ?? `Axis ${src.axis}${src.sign > 0 ? "+" : "-"}`;
}

/** Grouped source options for the <select>. */
export const SOURCE_OPTION_GROUPS: { label: string; sources: Source[] }[] = [
  { label: "None", sources: [{ kind: "none" }] },
  { label: "Buttons", sources: [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 16].map((i) => ({ kind: "button", index: i })) },
  { label: "Triggers", sources: [6, 7].map((i) => ({ kind: "button", index: i as number })) },
  { label: "Left Stick", sources: ([[0, 1], [0, -1], [1, 1], [1, -1]] as const).map(([axis, sign]) => ({ kind: "axis", axis, sign })) },
  { label: "Right Stick", sources: ([[2, 1], [2, -1], [3, 1], [3, -1]] as const).map(([axis, sign]) => ({ kind: "axis", axis, sign })) },
];
