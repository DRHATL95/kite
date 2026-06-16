/**
 * rtpTime.ts — convert a stream's uint32 RTP timestamps to monotonic seconds.
 *
 * RTP timestamps tick at a codec-specific rate (video 90 kHz, audio = sample
 * rate, e.g. 48 kHz) and wrap at 2³². The first timestamp seen becomes the
 * origin (t = 0); each subsequent timestamp advances an unwrapped 64-bit
 * accumulator by the forward delta, so the result is monotonic across wraps.
 * muxide requires monotonic PTS, and A/V sync needs both streams referenced to
 * their own first-frame origin.
 */
export class RtpClock {
  private readonly rate: number;
  private lastRaw = 0;
  private unwrapped = 0;
  private initialized = false;

  /** @param rate ticks per second (e.g. 90000 for H.264 video, 48000 for Opus). */
  constructor(rate: number) {
    if (!(rate > 0)) throw new Error(`RtpClock rate must be > 0, got ${rate}`);
    this.rate = rate;
  }

  /**
   * Seconds elapsed since the first timestamp. The first call returns 0 and
   * sets the origin. Forward deltas are computed modulo 2³², so a wrap from
   * near-max back to a small value advances time correctly.
   */
  toSeconds(ts: number): number {
    const raw = ts >>> 0; // normalize to uint32
    if (!this.initialized) {
      this.initialized = true;
      this.lastRaw = raw;
      this.unwrapped = 0;
      return 0;
    }
    const delta = (raw - this.lastRaw) >>> 0; // unsigned 32-bit forward delta
    this.unwrapped += delta;
    this.lastRaw = raw;
    return this.unwrapped / this.rate;
  }
}
