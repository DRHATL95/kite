// ui/src/lib/connection/streamQuality.test.ts
import { describe, it, expect } from "vitest";
import {
  QUALITY_PRESETS,
  paramsForQuality,
  isQualityPreset,
  buildDimensionsPayload,
} from "./streamQuality.js";

describe("streamQuality presets", () => {
  it("auto is uncapped 1080p (today's behavior)", () => {
    expect(QUALITY_PRESETS.auto).toEqual({ width: 1920, height: 1080, maxBitrateKbps: null });
  });
  it("lower presets drop resolution and cap bitrate", () => {
    expect(QUALITY_PRESETS.high).toEqual({ width: 1920, height: 1080, maxBitrateKbps: 15000 });
    expect(QUALITY_PRESETS.medium).toEqual({ width: 1280, height: 720, maxBitrateKbps: 8000 });
    expect(QUALITY_PRESETS.low).toEqual({ width: 1280, height: 720, maxBitrateKbps: 4000 });
  });
  it("paramsForQuality returns the preset params", () => {
    expect(paramsForQuality("medium")).toBe(QUALITY_PRESETS.medium);
  });
  it("isQualityPreset accepts known presets and rejects anything else", () => {
    expect(isQualityPreset("auto")).toBe(true);
    expect(isQualityPreset("low")).toBe(true);
    expect(isQualityPreset("ultra")).toBe(false);
    expect(isQualityPreset(null)).toBe(false);
    expect(isQualityPreset(720)).toBe(false);
  });
});

describe("buildDimensionsPayload", () => {
  it("maps width/height onto every dimension field", () => {
    expect(buildDimensionsPayload(1280, 720)).toEqual({
      horizontal: 1280, vertical: 720,
      preferredWidth: 1280, preferredHeight: 720,
      safeAreaLeft: 0, safeAreaTop: 0,
      safeAreaRight: 1280, safeAreaBottom: 720,
    });
  });
});
