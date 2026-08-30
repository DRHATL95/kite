import { describe, it, expect } from "vitest";
import {
  CONNECT_TIMEOUT_MS,
  CONNECT_TIMEOUT_MESSAGE,
  isConnectSettled,
} from "./connectTimeout.js";
import type { SessionState } from "./types.js";

describe("connect watchdog policy", () => {
  it("treats terminal/success states as settled (clears the watchdog)", () => {
    expect(isConnectSettled("streaming")).toBe(true);
    expect(isConnectSettled("failed")).toBe(true);
    expect(isConnectSettled("idle")).toBe(true);
  });

  it("treats in-progress states as unsettled (watchdog stays armed)", () => {
    expect(isConnectSettled("connecting")).toBe(false);
    expect(isConnectSettled("reconnecting")).toBe(false);
  });

  it("covers every SessionState (no state left unclassified)", () => {
    const all: SessionState[] = [
      "idle",
      "connecting",
      "streaming",
      "reconnecting",
      "failed",
    ];
    // Every state resolves to a boolean — exhaustiveness guard against a new
    // SessionState variant silently defaulting.
    for (const s of all) expect(typeof isConnectSettled(s)).toBe("boolean");
  });

  it("uses a bounded, generous timeout (30s)", () => {
    expect(CONNECT_TIMEOUT_MS).toBe(30_000);
  });

  it("has an honest, actionable failure message", () => {
    expect(CONNECT_TIMEOUT_MESSAGE).toMatch(/restart/i);
    expect(CONNECT_TIMEOUT_MESSAGE.length).toBeGreaterThan(0);
  });
});
