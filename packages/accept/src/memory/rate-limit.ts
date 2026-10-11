import type { RateLimiter } from '../ports.js';

const WINDOW_MS = 60_000;
export const DEFAULT_MAX_RATE_KEYS = 100_000;

interface Window {
  readonly start: number;
  readonly count: number;
}

/** Fixed one-minute windows per key. When too many keys are live it refuses (fails closed). */
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly maxKeys: number;

  constructor(options: { readonly maxKeys?: number } = {}) {
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_RATE_KEYS;
  }

  take(key: string, limit: number, nowMs: number): boolean {
    const current = this.windows.get(key);
    const live = current !== undefined && nowMs - current.start < WINDOW_MS;
    if (!current && this.windows.size >= this.maxKeys) {
      this.evictExpired(nowMs);
      if (this.windows.size >= this.maxKeys) return false;
    }
    const next: Window = live ? { start: current.start, count: current.count + 1 } : { start: nowMs, count: 1 };
    if (next.count > limit) return false;
    this.windows.set(key, next);
    return true;
  }

  private evictExpired(nowMs: number): void {
    for (const [key, w] of this.windows) if (nowMs - w.start >= WINDOW_MS) this.windows.delete(key);
  }
}
