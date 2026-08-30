import { describe, it, expect } from "vitest";
import { mapFailureReason, serverDisconnectReason, SERVER_DISCONNECT_PREFIX } from "./failureReason.js";

const CONSOLE_DISCONNECTED =
  "Console disconnected — it may have been powered off, put in standby, or taken over by another user.";
const MEDIA =
  "Couldn't get video from the console. It may be unresponsive — try restarting the console.";
const GENERIC = "The connection failed. Please try again.";

describe("failureReason — mapFailureReason", () => {
  it("maps a server-disconnect marker (with or without a raw reason) to the console-disconnected notice", () => {
    expect(mapFailureReason("consoleDisconnected: Standby")).toBe(CONSOLE_DISCONNECTED);
    expect(mapFailureReason("consoleDisconnected")).toBe(CONSOLE_DISCONNECTED);
  });
  it("maps media reasons to the restart-console message", () => {
    expect(mapFailureReason("mediaNeverStarted")).toBe(MEDIA);
    expect(mapFailureReason("mediaStalled")).toBe(MEDIA);
  });
  it("maps null and unknown reasons to the generic failure", () => {
    expect(mapFailureReason(null)).toBe(GENERIC);
    expect(mapFailureReason("iceFailed")).toBe(GENERIC);
  });
});

describe("failureReason — serverDisconnectReason", () => {
  it("prefixes a raw reason", () => {
    expect(serverDisconnectReason("Standby")).toBe("consoleDisconnected: Standby");
  });
  it("returns just the prefix for an empty raw reason", () => {
    expect(serverDisconnectReason("")).toBe(SERVER_DISCONNECT_PREFIX);
    expect(SERVER_DISCONNECT_PREFIX).toBe("consoleDisconnected");
  });
  it("round-trips: a built marker maps to the notice", () => {
    expect(mapFailureReason(serverDisconnectReason("Anything"))).toBe(CONSOLE_DISCONNECTED);
  });
});
