import { describe, it, expect } from "vitest";
import { decidePollOutcome } from "./authFlowLogic.js";

describe("decidePollOutcome", () => {
  it("signals signedIn when the status check passes", () => {
    expect(
      decidePollOutcome({ signedIn: true, flowError: null, attempts: 1, maxAttempts: 10 }),
    ).toEqual({ kind: "signedIn" });
  });

  it("signals failed with the backend error when the flow reports one", () => {
    expect(
      decidePollOutcome({
        signedIn: false,
        flowError: "Token exchange failed: dns error",
        attempts: 2,
        maxAttempts: 10,
      }),
    ).toEqual({ kind: "failed", error: "Token exchange failed: dns error" });
  });

  it("prefers signedIn over a stale flow error", () => {
    expect(
      decidePollOutcome({ signedIn: true, flowError: "boom", attempts: 2, maxAttempts: 10 }),
    ).toEqual({ kind: "signedIn" });
  });

  it("continues while under the attempt cap with no result yet", () => {
    expect(
      decidePollOutcome({ signedIn: false, flowError: null, attempts: 3, maxAttempts: 10 }),
    ).toEqual({ kind: "continue" });
  });

  it("times out once attempts reach the cap", () => {
    const d = decidePollOutcome({
      signedIn: false,
      flowError: null,
      attempts: 10,
      maxAttempts: 10,
    });
    expect(d.kind).toBe("failed");
    if (d.kind === "failed") expect(d.error).toMatch(/timed out/i);
  });
});
