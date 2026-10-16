import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { type ClaimResult, DEFAULT_MAX_CLAIMS, ProtocolError, ProtocolErrorCode, type SingleUseStore } from 'agentpay-hub/protocol';

/**
 * Single-use claims in SQLite: the primary key makes `claim` atomic across every process on the file.
 * As in the memory store, an expired claim still blocks until `prune`, and a full store refuses
 * new claims (fail closed) rather than evicting one: dropping a live claim would reopen a replay.
 */
export class SqliteSingleUseStore implements SingleUseStore {
  private readonly maxEntries: number;

  constructor(private readonly db: DatabaseSync, options: { readonly maxEntries?: number } = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_CLAIMS;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new ProtocolError(ProtocolErrorCode.CONFIG_INVALID, 'maxEntries must be a positive integer');
    this.maxEntries = maxEntries;
    db.exec(`CREATE TABLE IF NOT EXISTS single_use_claims (
      key TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS single_use_claims_expiry ON single_use_claims (expires_at)`);
  }

  async claim(key: string, expiresAtSec: number): Promise<ClaimResult> {
    if (!Number.isInteger(expiresAtSec)) throw new ProtocolError(ProtocolErrorCode.MALFORMED, 'claim expiry must be an integer');
    const token = randomUUID();
    // One statement, so the cap check and the insert are atomic across processes on the file.
    const { changes } = this.db.prepare(`INSERT INTO single_use_claims (key, token, expires_at)
      SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM single_use_claims) < ? ON CONFLICT (key) DO NOTHING`)
      .run(key, token, expiresAtSec, this.maxEntries);
    if (changes === 1) return { ok: true, token };
    const taken = this.db.prepare('SELECT 1 FROM single_use_claims WHERE key = ?').get(key) !== undefined;
    return { ok: false, code: taken ? ProtocolErrorCode.NONCE_REPLAY : ProtocolErrorCode.STORE_FULL };
  }

  async release(key: string, token: string): Promise<boolean> {
    return this.db.prepare('DELETE FROM single_use_claims WHERE key = ? AND token = ?').run(key, token).changes === 1;
  }

  async prune(nowSec: number): Promise<number> {
    return Number(this.db.prepare('DELETE FROM single_use_claims WHERE expires_at <= ?').run(nowSec).changes);
  }
}
