// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KeyboardTracker, isTypingTarget } from "./keyboardTracker.js";

describe("isTypingTarget", () => {
  it("is true for text-entry elements", () => {
    for (const tag of ["input", "textarea", "select"]) {
      expect(isTypingTarget(document.createElement(tag))).toBe(true);
    }
    const ce = document.createElement("div");
    ce.setAttribute("contenteditable", "true");
    expect(isTypingTarget(ce)).toBe(true);
  });

  it("is false for non-text elements, window, and null", () => {
    expect(isTypingTarget(document.createElement("div"))).toBe(false);
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(isTypingTarget(window)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("KeyboardTracker", () => {
  let tracker: KeyboardTracker;

  beforeEach(() => {
    tracker = new KeyboardTracker();
    tracker.attach();
  });
  afterEach(() => tracker.detach());

  const down = (code: string, target: EventTarget = window) => {
    const e = new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
  };
  const up = (code: string) =>
    window.dispatchEvent(new KeyboardEvent("keyup", { code, bubbles: true }));

  it("tracks a held mapped key and releases it on keyup", () => {
    down("KeyW");
    expect(tracker.pressed.has("KeyW")).toBe(true);
    up("KeyW");
    expect(tracker.pressed.has("KeyW")).toBe(false);
  });

  it("ignores unmapped keys", () => {
    down("KeyP"); // not in KEYBOARD_MAP
    expect(tracker.pressed.has("KeyP")).toBe(false);
    expect(tracker.pressed.size).toBe(0);
  });

  it("preventDefaults mapped keys but not unmapped keys", () => {
    expect(down("Space").defaultPrevented).toBe(true); // mapped (A)
    expect(down("F5").defaultPrevented).toBe(false); // unmapped
  });

  it("ignores keys while a text field is focused", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    down("KeyW", input);
    expect(tracker.pressed.has("KeyW")).toBe(false);
    input.remove();
  });

  it("releases all keys on window blur (no stuck keys after alt-tab)", () => {
    down("KeyW");
    down("KeyA");
    expect(tracker.pressed.size).toBe(2);
    window.dispatchEvent(new Event("blur"));
    expect(tracker.pressed.size).toBe(0);
  });

  it("stops tracking after detach", () => {
    tracker.detach();
    down("KeyW");
    expect(tracker.pressed.size).toBe(0);
  });
});
