import { config } from '../config/index.js';

export interface RateLimiterOptions {
  max: number;
  windowMs: number;
  maxKeys?: number;
  now?: () => number;
}

/**
 * In-memory sliding-window limiter with bounded key capacity (docs/02 §4.2.A).
 */

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private checksSincePrune = 0;

  constructor(options: RateLimiterOptions) {
    this.max = options.max;
    this.windowMs = options.windowMs;
    this.maxKeys = Math.max(1, options.maxKeys ?? config.RATE_LIMIT_MAX_KEYS);
    this.now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.hits.size;
  }

  private pruneExpired(cutoff: number): void {
    for (const [entryKey, timestamps] of this.hits) {
      const latest = timestamps[timestamps.length - 1];
      if (latest === undefined || latest <= cutoff) {
        this.hits.delete(entryKey);
      }
    }
  }

  /** Record an attempt and report whether it is within the limit. */
  check(key: string): boolean {
    const normalizedKey = key || 'unknown';
    const timestamp = this.now();
    const cutoff = timestamp - this.windowMs;

    this.checksSincePrune += 1;
    if (this.checksSincePrune >= 256 || this.hits.size >= this.maxKeys) {
      this.checksSincePrune = 0;
      this.pruneExpired(cutoff);
    }

    const existing = this.hits.get(normalizedKey);
    if (!existing && this.hits.size >= this.maxKeys) {
      const oldestKey = this.hits.keys().next().value;
      if (oldestKey !== undefined) {
        this.hits.delete(oldestKey);
      }
    }

    const recent = (existing ?? []).filter((entry) => entry > cutoff);
    if (existing) {
      this.hits.delete(normalizedKey);
    }

    if (recent.length >= this.max) {
      this.hits.set(normalizedKey, recent);
      return false;
    }

    recent.push(timestamp);
    this.hits.set(normalizedKey, recent);
    return true;
  }

  reset(): void {
    this.hits.clear();
    this.checksSincePrune = 0;
  }
}
