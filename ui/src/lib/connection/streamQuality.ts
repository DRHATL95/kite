/**
 * streamQuality.ts — pure stream-quality preset model + the dimensions payload
 * derived from a resolution. Kite is the WebRTC receiver, so a preset signals the
 * Xbox encoder what to do: `maxBitrateKbps` becomes a b=AS cap on the SDP offer,
 * and width/height feed the `dimensionschanged` config message. Auto = no cap +
 * 1080p = today's behavior.
 */
export type QualityPreset = "auto" | "high" | "medium" | "low";

export interface QualityParams {
  width: number;
  height: number;
  /** Max video bitrate in kbps; null = no cap (Auto). */
  maxBitrateKbps: number | null;
}

export const QUALITY_PRESETS: Record<QualityPreset, QualityParams> = {
  auto:   { width: 1920, height: 1080, maxBitrateKbps: null },
  high:   { width: 1920, height: 1080, maxBitrateKbps: 15000 },
  medium: { width: 1280, height: 720,  maxBitrateKbps: 8000 },
  low:    { width: 1280, height: 720,  maxBitrateKbps: 4000 },
};

const PRESET_IDS = new Set<string>(Object.keys(QUALITY_PRESETS));

export function isQualityPreset(v: unknown): v is QualityPreset {
  return typeof v === "string" && PRESET_IDS.has(v);
}

export function paramsForQuality(preset: QualityPreset): QualityParams {
  return QUALITY_PRESETS[preset] ?? QUALITY_PRESETS.auto;
}

export interface DimensionsPayload {
  horizontal: number;
  vertical: number;
  preferredWidth: number;
  preferredHeight: number;
  safeAreaLeft: number;
  safeAreaTop: number;
  safeAreaRight: number;
  safeAreaBottom: number;
}

/** The `/streaming/characteristics/dimensionschanged` payload for a resolution. */
export function buildDimensionsPayload(width: number, height: number): DimensionsPayload {
  return {
    horizontal: width,
    vertical: height,
    preferredWidth: width,
    preferredHeight: height,
    safeAreaLeft: 0,
    safeAreaTop: 0,
    safeAreaRight: width,
    safeAreaBottom: height,
  };
}
