/**
 * backend.ts — the connection backend contract.
 *
 * `ConnectionBackend` is the surface the `connectionStore` drives, implemented by
 * BOTH the browser `ConnectionManager` (WebRTC in the webview) and the native
 * `NativeConnection` (Rust str0m engine, Phase 6). Extracting it lets the store
 * hold one `_impl: ConnectionBackend` and swap implementations based on
 * `rtcNativeAvailable()` without the rest of the UI caring which path is active.
 *
 * Both backends take a `ConnectionManagerCallbacks` in their constructor;
 * interfaces can't constrain constructors, so the callbacks contract lives in
 * ConnectionManager.ts and both classes accept it directly.
 */

import type { EncodedTap } from "../clip/EncodedTap.js";
import type { XHomeConsole } from "../ipc/types.js";
import type { DiagnosticsSnapshot, SessionState } from "./types.js";
import type { QualityParams } from "./streamQuality.js";

export interface ConnectionBackend {
  /** Begin connecting to the given console. Does not throw; failures surface via
   * the `onStateChange("failed")` callback. */
  connect(xboxConsole: XHomeConsole, opts?: { audioOnly?: boolean; quality?: QualityParams }): Promise<void>;
  /** Tear down the session and return to idle. */
  disconnect(): Promise<void>;
  /** Request a keyframe (IDR) from the console ("Fix Video"). */
  requestKeyframe(): void;
  /** Attach/detach the encoded-frame clip tap (browser only; a no-op natively). */
  setEncodedTap(tap: EncodedTap | null): void;
  /** Whether Insertable Streams clip tapping is available (false natively). */
  readonly encodedStreamsAvailable: boolean;
  /** The latest diagnostics snapshot, or null before the first sample. */
  readonly lastSnapshot: DiagnosticsSnapshot | null;
  /** Human-readable reason for the last failure/drop, or null. */
  readonly lastTriggerReason: string | null;
  /** Current session lifecycle state. */
  readonly state: SessionState;
}
