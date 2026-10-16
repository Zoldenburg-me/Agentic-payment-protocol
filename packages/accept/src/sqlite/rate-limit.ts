import type { DatabaseSync } from 'node:sqlite';
import type { RateLimiter } from '../ports.js';
import { DEFAULT_MAX_RATE_KEYS, WINDOW_MS } from '../memory/rate-limit.js';

/**
 * Fixed one-minute windows per key, shared by every process on the file. Ended windows are deleted as it goes,
 * and past `maxKeys` the oldest windows go, so a flood of new keys resets old counts instead of filling the disk.
 */
export class SqliteRateLimiter implements RateLimiter {
  private readonly maxKeys: number;

  constructor(private readonly db: DatabaseSync, options: { readonly maxKeys?: number } = {}) {
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_RATE_KEYS;
    db.exec(`CREATE TABLE IF NOT EXISTS rate_windows (
      key TEXT PRIMARY KEY,
      start INTEGER NOT NULL,
      count INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rate_windows_start ON rate_windows (start)`);
  }

  take(key: string, limit: number, nowMs: number): boolean {
    // One upsert per call: an ended window restarts, and a key already over its limit is left untouched (no row returned).
    const taken = this.db.prepare(`INSERT INTO rate_windows (key, start, count) VALUES (:key, :now, 1)
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN :now - start >= :window THEN 1 ELSE count + 1 END,
        start = CASE WHEN :now - start >= :window THEN :now ELSE start END
      WHERE :now - start >= :window OR count <= :limit
      RETURNING count`).get({ key, now: nowMs, window: WINDOW_MS, limit }) as { count: number } | undefined;
    if (taken === undefined) return false;
    // Sweep only when a window starts, not on every (possibly unauthenticated) request.
    if (taken.count === 1) this.sweep(nowMs);
    return taken.count <= limit;
  }

  private sweep(nowMs: number): void {
    this.db.prepare('DELETE FROM rate_windows WHERE start <= ?').run(nowMs - WINDOW_MS);
    this.db.prepare(`DELETE FROM rate_windows WHERE key IN (
      SELECT key FROM rate_windows ORDER BY start LIMIT MAX(0, (SELECT COUNT(*) FROM rate_windows) - ?))`).run(this.maxKeys);
  }
}
