import type { DatabaseSync } from 'node:sqlite';

/**
 * Fixed-window counters with a window per key (a minute, a day), shared by every process on the file.
 * accept's SqliteRateLimiter has one fixed minute for every key, so the longer windows live here.
 */
export class Counters {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS hosted_counters (
      key TEXT PRIMARY KEY,
      ends INTEGER NOT NULL,
      count INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS hosted_counters_ends ON hosted_counters (ends)`);
  }

  /** Takes one unit for `key`; false once `limit` is used up in its window. */
  take(key: string, limit: number, windowMs: number, nowMs: number): boolean {
    // One upsert: an ended window restarts, and a key at its limit is left untouched (no row returned).
    return this.db.prepare(`INSERT INTO hosted_counters (key, ends, count) VALUES (:key, :now + :window, 1)
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN :now >= ends THEN 1 ELSE count + 1 END,
        ends = CASE WHEN :now >= ends THEN :now + :window ELSE ends END
      WHERE :now >= ends OR count < :limit
      RETURNING count`).get({ key, now: nowMs, window: windowMs, limit }) !== undefined;
  }

  /** True when `key` has used up `limit` in its current window; takes nothing. */
  spent(key: string, limit: number, nowMs: number): boolean {
    const row = this.db.prepare('SELECT count FROM hosted_counters WHERE key = ? AND ends > ?').get(key, nowMs) as { count: number } | undefined;
    return row !== undefined && row.count >= limit;
  }

  /** Drops ended windows. */
  sweep(nowMs: number): void {
    this.db.prepare('DELETE FROM hosted_counters WHERE ends <= ?').run(nowMs);
  }
}
