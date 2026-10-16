import type { RateLimiter } from '../ports.js';

export const WINDOW_MS = 60_000;
export const DEFAULT_MAX_RATE_KEYS = 100_000;

interface Window {
  readonly start: number;
  readonly count: number;
}

/**
 * Fixed one-minute windows per key, for one process. When it tracks too many keys it forgets the
 * least recently used one, so a flood of new keys resets old counts instead of locking everyone out.
 * Run several processes and you need a shared limiter.
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly maxKeys: number;

  constructor(options: { readonly maxKeys?: number } = {}) {
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_RATE_KEYS;
  }

  take(key: string, limit: number, nowMs: number): boolean {
    const current = this.windows.get(key);
    const live = current !== undefined && nowMs - current.start < WINDOW_MS;
    const next: Window = live ? { start: current.start, count: current.count + 1 } : { start: nowMs, count: 1 };
    this.windows.delete(key); // re-inserted below, so Map order is least recently used first
    if (next.count > limit) {
      this.windows.set(key, current ?? next);
      return false;
    }
    if (this.windows.size >= this.maxKeys) this.evictOldest();
    this.windows.set(key, next);
    return true;
  }

  private evictOldest(): void {
    const oldest = this.windows.keys().next();
    if (!oldest.done) this.windows.delete(oldest.value);
  }
}
