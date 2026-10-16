import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { type ClaimResult, ProtocolError, ProtocolErrorCode, type SingleUseStore } from 'agentpay-hub/protocol';

/**
 * Single-use claims in SQLite: the primary key makes `claim` atomic across every process on the file.
 * An expired claim still blocks until `prune`, as in the memory store.
 * shortcut: no entry cap (the memory store has one); the disk is the bound, so rate-limit before claiming.
 */
export class SqliteSingleUseStore implements SingleUseStore {
  constructor(private readonly db: DatabaseSync) {
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
    const { changes } = this.db.prepare('INSERT INTO single_use_claims (key, token, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING')
      .run(key, token, expiresAtSec);
    return changes === 1 ? { ok: true, token } : { ok: false, code: ProtocolErrorCode.NONCE_REPLAY };
  }

  async release(key: string, token: string): Promise<boolean> {
    return this.db.prepare('DELETE FROM single_use_claims WHERE key = ? AND token = ?').run(key, token).changes === 1;
  }

  async prune(nowSec: number): Promise<number> {
    return Number(this.db.prepare('DELETE FROM single_use_claims WHERE expires_at <= ?').run(nowSec).changes);
  }
}
