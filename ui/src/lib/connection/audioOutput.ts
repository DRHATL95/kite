// ui/src/lib/connection/audioOutput.ts
/**
 * audioOutput — pick + persist the audio output device for the browser path.
 *
 * Routing itself lives on streamAudio (AudioContext.setSinkId). This module is
 * only the *selection*: feature-detection, persistence, and presenting a picker.
 *
 * Selection uses ONLY navigator.mediaDevices.selectAudioOutput() — the native
 * picker, which returns the chosen device (id + real name) with NO permission
 * prompt. We deliberately do NOT fall back to enumerateDevices(): that path
 * needs a getUserMedia() microphone grant to reveal output-device names/ids (a
 * Chromium privacy gate), and a mic prompt to choose speakers is unacceptable
 * for an app that never records. Where selectAudioOutput() is unavailable the
 * picker is simply hidden (see hasNativeOutputPicker) and boost still works.
 */
import { persisted } from "$lib/persist/store.js";

const OUTPUT_KEY = "kite-audio-output-device";
const LABEL_KEY = "kite-audio-output-label";

type MediaDevicesWithPicker = MediaDevices & {
  selectAudioOutput?: () => Promise<MediaDeviceInfo>;
};

/** True only if the context can route output at all (AudioContext.setSinkId). */
export function isOutputSelectionSupported(): boolean {
  return typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;
}

/** True if the browser offers the native, no-prompt output-device picker. */
export function hasNativeOutputPicker(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof (navigator.mediaDevices as MediaDevicesWithPicker | undefined)?.selectAudioOutput ===
      "function"
  );
}

/** Persisted chosen device id ("" = system default). */
export function savedOutputDeviceId(): string {
  return persisted.getItem(OUTPUT_KEY) ?? "";
}

/** Persisted chosen device label, for display ("" = none saved). */
export function savedOutputLabel(): string {
  return persisted.getItem(LABEL_KEY) ?? "";
}

export function saveOutputDeviceId(deviceId: string): void {
  persisted.setItem(OUTPUT_KEY, deviceId);
}

export function saveOutputLabel(label: string): void {
  persisted.setItem(LABEL_KEY, label);
}

/** Present the native output picker; resolve to the chosen device, or null if
 *  it's unavailable or the user cancelled. Never prompts for a media grant. */
export async function pickOutputDevice(): Promise<{ deviceId: string; label: string } | null> {
  const md = navigator.mediaDevices as MediaDevicesWithPicker;
  if (typeof md.selectAudioOutput !== "function") return null;
  try {
    const info = await md.selectAudioOutput();
    return { deviceId: info.deviceId, label: info.label || "Selected device" };
  } catch {
    return null; // user cancelled
  }
}
