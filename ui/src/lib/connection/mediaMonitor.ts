/**
 * mediaMonitor.ts — media-flow watchdog state machine.
 *
 * Pure decision logic: no timers, no DOM, no getStats. ConnectionManager owns a
 * setInterval and calls tick(framesDecoded, nowMs) once per MEDIA_MONITOR_TICK_MS,
 * passing the latest decoded-frame counter and Date.now(). The monitor decides
 * when media has started, when to nudge the encoder, and when to escalate to a
 * reconnect — firing callbacks for each. All thresholds are injectable so the
 * machine is deterministically unit-testable with a fake clock.
 *
 * See docs/superpowers/specs/2026-06-13-media-flow-watchdog-design.md
 */

import {
  MEDIA_START_NUDGE_1_MS,
  MEDIA_START_NUDGE_2_MS,
  MEDIA_START_TIMEOUT_MS,
  MEDIA_STALL_NUDGE_MS,
  MEDIA_STALL_TIMEOUT_MS,
} from "./constants.js";

export interface MediaMonitorCallbacks {
  /** First decoded frame seen — caller transitions to "streaming". */
  onMediaStart: () => void;
  /** Encoder kick — caller sends a keyframe request on the control channel. */
  onNudge: (context: "starting" | "stalled") => void;
  /** Recovery escalation — caller triggers a full reconnect with this reason. */
  onRecover: (reason: "mediaNeverStarted" | "mediaStalled") => void;
}

export interface MediaMonitorConfig {
  startNudge1Ms: number;
  startNudge2Ms: number;
  startTimeoutMs: number;
  stallNudgeMs: number;
  stallTimeoutMs: number;
}

const DEFAULT_CONFIG: MediaMonitorConfig = {
  startNudge1Ms: MEDIA_START_NUDGE_1_MS,
  startNudge2Ms: MEDIA_START_NUDGE_2_MS,
  startTimeoutMs: MEDIA_START_TIMEOUT_MS,
  stallNudgeMs: MEDIA_STALL_NUDGE_MS,
  stallTimeoutMs: MEDIA_STALL_TIMEOUT_MS,
};

type Phase = "idle" | "awaitingFirstFrame" | "flowing";

export class MediaMonitor {
  private readonly cb: MediaMonitorCallbacks;
  private readonly cfg: MediaMonitorConfig;

  private phase: Phase = "idle";
  private lastFrames: number | null = null;
  /** Start-of-budget timestamp, stamped lazily on the first tick (not at arm()). */
  private armedAt: number | null = null;
  private lastProgressAt = 0;
  private startNudgesSent = 0;
  private stallNudgeSent = false;

  constructor(cb: MediaMonitorCallbacks, cfg?: Partial<MediaMonitorConfig>) {
    this.cb = cb;
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
  }

  /** Arm in awaiting-first-frame phase (called from the dual-track gate). */
  arm(nowMs: number): void {
    this.phase = "awaitingFirstFrame";
    this.lastFrames = null;
    // Defer the start-of-budget to the first tick — see tick() for why.
    this.armedAt = null;
    this.lastProgressAt = nowMs;
    this.startNudgesSent = 0;
    this.stallNudgeSent = false;
  }

  /** Stop & reset all internal state (called from _cleanupConnection). */
  reset(): void {
    this.phase = "idle";
    this.lastFrames = null;
    this.armedAt = null;
    this.lastProgressAt = 0;
    this.startNudgesSent = 0;
    this.stallNudgeSent = false;
  }

  /** Drive the state machine. Called once per ConnectionManager tick. */
  tick(framesDecoded: number | null, nowMs: number): void {
    if (this.phase === "awaitingFirstFrame") {
      // Stamp the start-of-budget on the FIRST tick, not at arm() time. The tick
      // timer that drives this isn't started until the stats sampler runs (after
      // ICE polling), so measuring from arm() would let a slow ICE phase silently
      // eat the nudge/timeout budget and fire a premature reconnect.
      const armedAt = this.armedAt ?? nowMs;
      this.armedAt = armedAt;

      if (framesDecoded != null && framesDecoded > 0) {
        this.phase = "flowing";
        this.lastFrames = framesDecoded;
        this.lastProgressAt = nowMs;
        this.cb.onMediaStart();
        return;
      }

      const elapsed = nowMs - armedAt;
      if (elapsed >= this.cfg.startTimeoutMs) {
        this.phase = "idle";
        this.cb.onRecover("mediaNeverStarted");
        return;
      }
      if (this.startNudgesSent === 0 && elapsed >= this.cfg.startNudge1Ms) {
        this.startNudgesSent = 1;
        this.cb.onNudge("starting");
        return;
      }
      if (this.startNudgesSent === 1 && elapsed >= this.cfg.startNudge2Ms) {
        this.startNudgesSent = 2;
        this.cb.onNudge("starting");
      }
      return;
    }

    if (this.phase === "flowing") {
      if (framesDecoded != null && this.lastFrames != null && framesDecoded > this.lastFrames) {
        this.lastFrames = framesDecoded;
        this.lastProgressAt = nowMs;
        this.stallNudgeSent = false;
        return;
      }
      // Keep lastFrames current even when not progressing, so the next advance is detected.
      if (framesDecoded != null) {
        this.lastFrames = framesDecoded;
      }

      const stalled = nowMs - this.lastProgressAt;
      if (stalled >= this.cfg.stallTimeoutMs) {
        this.phase = "idle";
        this.cb.onRecover("mediaStalled");
        return;
      }
      if (!this.stallNudgeSent && stalled >= this.cfg.stallNudgeMs) {
        this.stallNudgeSent = true;
        this.cb.onNudge("stalled");
      }
      return;
    }
  }
}
