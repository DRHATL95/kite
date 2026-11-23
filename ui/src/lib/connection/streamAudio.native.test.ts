import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * streamAudio's native-output wiring (Windows): when nativeAudio hands back a
 * tap, the graph must run gain → tap (and NOT gain → destination, or the page
 * plays the audio too); when native output fails, gain → destination again.
 */
const native = vi.hoisted(() => ({
  node: null as null | { connects: unknown[]; port: { onmessage: unknown }; connect(t: unknown): void; disconnect(): void },
  onFailure: null as null | ((e: unknown) => void),
}));
const ipc = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));

vi.mock("./nativeAudio.js", () => ({
  NATIVE_SAMPLE_RATE: 48_000,
  startNativeAudio: async (_c: unknown, _d: string, onFailure: (e: unknown) => void) => {
    native.onFailure = onFailure;
    return native.node;
  },
}));
vi.mock("$lib/ipc/commands.js", () => ({
  audioOutStart: (...a: unknown[]) => (ipc.start(...a), Promise.resolve(true)),
  audioOutStop: () => (ipc.stop(), Promise.resolve()),
}));

import { streamAudio } from "./streamAudio.js";

let gainTargets: unknown[];
const destination = { name: "destination" };

function installAudioContext() {
  gainTargets = [];
  class FakeAudioContext {
    state = "running";
    destination = destination;
    createGain() {
      return {
        gain: { value: 1 },
        connect: (t: unknown) => gainTargets.push(t),
        disconnect: () => (gainTargets = []),
      };
    }
    createMediaStreamSource() {
      return { connect: () => {}, disconnect: () => {} };
    }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  (globalThis as Record<string, unknown>).AudioContext = FakeAudioContext;
}

function fakeNode() {
  const node = {
    connects: [] as unknown[],
    port: { onmessage: null as unknown },
    connect(t: unknown) { node.connects.push(t); },
    disconnect() { node.connects = []; },
  };
  return node;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const attach = () =>
  streamAudio.attach({ volume: 1, muted: false } as HTMLVideoElement, { id: "s" } as unknown as MediaStream);

beforeEach(() => {
  installAudioContext();
  ipc.start.mockClear();
  ipc.stop.mockClear();
});
afterEach(() => streamAudio.dispose());

describe("streamAudio — native output", () => {
  it("routes gain through the native tap instead of the speakers", async () => {
    native.node = fakeNode();
    attach();
    await flush();

    expect(gainTargets).toEqual([native.node]);
    expect(native.node.connects).toEqual([destination]);
  });

  it("falls back to the page's own output when native output fails", async () => {
    native.node = fakeNode();
    attach();
    await flush();

    native.onFailure!(new Error("stream failed"));

    expect(gainTargets).toEqual([destination]);
    expect(ipc.stop).toHaveBeenCalled();
  });

  it("stays on the page's output where there is no native path", async () => {
    native.node = null;
    attach();
    await flush();

    expect(gainTargets).toEqual([destination]);
  });

  it("reopens the native player only when the device actually changes", async () => {
    native.node = fakeNode();
    attach();
    await flush();

    await streamAudio.setSinkId(""); // still the default: no restart
    expect(ipc.start).not.toHaveBeenCalled();
  });
});
