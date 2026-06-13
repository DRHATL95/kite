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
  private armedAt = 0;
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
    this.armedAt = nowMs;
    this.lastProgressAt = nowMs;
    this.startNudgesSent = 0;
    this.stallNudgeSent = false;
  }

  /** Stop & reset all internal state (called from _cleanupConnection). */
  reset(): void {
    this.phase = "idle";
    this.lastFrames = null;
    this.startNudgesSent = 0;
    this.stallNudgeSent = false;
  }

  /** Drive the state machine. Called once per ConnectionManager tick. */
  tick(framesDecoded: number | null, nowMs: number): void {
    if (this.phase === "awaitingFirstFrame") {
      if (framesDecoded != null && framesDecoded > 0) {
        this.phase = "flowing";
        this.lastFrames = framesDecoded;
        this.lastProgressAt = nowMs;
        this.cb.onMediaStart();
      }
      return;
    }
  }
}
