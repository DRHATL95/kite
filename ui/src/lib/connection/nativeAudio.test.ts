import { describe, it, expect, vi } from "vitest";
import { createPcmPump } from "./nativeAudio.js";

const chunk = (...bytes: number[]) => new Uint8Array(bytes).buffer;
const bytesOf = (b: ArrayBuffer) => [...new Uint8Array(b)];

/** A push whose calls stay pending until the test resolves or rejects them. */
function controlledPush() {
  const calls: { pcm: number[]; resolve: () => void; reject: (e: unknown) => void }[] = [];
  const push = (pcm: ArrayBuffer) =>
    new Promise<void>((resolve, reject) => calls.push({ pcm: bytesOf(pcm), resolve, reject }));
  return { push, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createPcmPump", () => {
  it("keeps one call in flight and merges what queued behind it, in order", async () => {
    const { push, calls } = controlledPush();
    const pump = createPcmPump(push, () => {});

    pump.send(chunk(1));
    pump.send(chunk(2));
    pump.send(chunk(3));
    expect(calls.map((c) => c.pcm)).toEqual([[1]]);

    calls[0].resolve();
    await flush();
    expect(calls.map((c) => c.pcm)).toEqual([[1], [2, 3]]);

    calls[1].resolve();
    await flush();
    pump.send(chunk(4));
    expect(calls.map((c) => c.pcm)).toEqual([[1], [2, 3], [4]]);
  });

  it("stops at the first failure and reports it once", async () => {
    const { push, calls } = controlledPush();
    const onFailure = vi.fn();
    const pump = createPcmPump(push, onFailure);

    pump.send(chunk(1));
    pump.send(chunk(2));
    calls[0].reject(new Error("stream failed"));
    await flush();
    pump.send(chunk(3));
    await flush();

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1); // nothing sent after the failure
  });

  it("drops the oldest chunks when a call stalls, so latency stays bounded", async () => {
    const { push, calls } = controlledPush();
    const pump = createPcmPump(push, () => {});

    pump.send(chunk(0)); // in flight, stalled
    for (let i = 1; i <= 10; i++) pump.send(chunk(i));
    calls[0].resolve();
    await flush();

    expect(calls[1].pcm).toEqual([3, 4, 5, 6, 7, 8, 9, 10]); // newest 8 kept
  });
});
