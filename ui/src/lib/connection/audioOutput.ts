// ui/src/lib/connection/audioOutput.ts
/**
 * audioOutput — pick + persist the audio output device for the browser path.
 *
 * Routing itself lives on streamAudio (AudioContext.setSinkId). This module is
 * only the *selection*: feature-detection, persistence, and presenting a picker.
 * Prefers navigator.mediaDevices.selectAudioOutput() (native picker, real
 * names, no permission prompt); falls back to enumerateDevices() (with a
 * one-time getUserMedia grant to unlock labels) for runtimes without it.
 */
import { persisted } from "$lib/persist/store.js";

const OUTPUT_KEY = "kite-audio-output-device";

type MediaDevicesWithPicker = MediaDevices & {
  selectAudioOutput?: () => Promise<MediaDeviceInfo>;
};

/** True only if the context can route output at all (AudioContext.setSinkId). */
export function isOutputSelectionSupported(): boolean {
  return typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;
}

/** True if the browser offers a native output-device picker (no mic prompt). */
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

export function saveOutputDeviceId(deviceId: string): void {
  persisted.setItem(OUTPUT_KEY, deviceId);
}

/** Native picker path: resolve to the chosen device, or null if cancelled. */
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

/** Fallback path: list audio outputs for a <select>. Requests a one-time media
 *  grant so labels are populated (Chromium hides them without one). */
export async function listOutputDevices(): Promise<{ deviceId: string; label: string }[]> {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch {
    // denied — ids still returned, labels may be blank
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "audiooutput")
    .map((d) => ({ deviceId: d.deviceId, label: d.label || "Audio output" }));
}
