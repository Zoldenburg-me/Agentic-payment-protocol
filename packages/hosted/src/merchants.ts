import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getAddress, isAddress } from 'viem';
import { AcceptError, AcceptErrorCode as E } from '@zold/accept';

export interface Merchant {
  /** Also the seller account id in the ledger. */
  readonly id: string;
  /** Where its payments land. */
  readonly payTo: string;
}

const MERCHANT_ID = /^[A-Za-z0-9._:@-]{1,128}$/; // the same as accept's sellerAccountId
const ZERO_ADDRESS = /^0x0{40}$/;
/** `zsk_<key id>_<secret>`: looked up by the id, the secret compared by its hash. */
const KEY = /^zsk_([0-9a-f]{16})_([0-9a-f]{64})$/;
const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();
const fail = (what: string): never => {
  throw new AcceptError(E.CONFIG_INVALID, what);
};

/** Checksummed; a mixed-case address with a wrong checksum is a typo, so it is refused. */
function payeeOf(value: string): string {
  if (!isAddress(value)) return fail('payTo is not an address');
  return ZERO_ADDRESS.test(value) ? fail('payTo is the zero address') : getAddress(value);
}

function newKey(): { keyId: string; secret: string; key: string } {
  const keyId = randomBytes(8).toString('hex');
  const secret = randomBytes(32).toString('hex');
  return { keyId, secret, key: `zsk_${keyId}_${secret}` };
}

/**
 * Merchants and their one `zsk_` key each. A key is shown once, when it is made; only the sha256 of its
 * secret is stored (the secret is 256 random bits, so a fast hash is enough).
 */
export class MerchantStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS merchants (
      id TEXT PRIMARY KEY,
      pay_to TEXT NOT NULL,
      key_id TEXT NOT NULL UNIQUE,
      key_hash BLOB NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`);
  }

  /** Returns the merchant's key. */
  add(id: string, payTo: string, nowMs: number = Date.now()): string {
    if (!MERCHANT_ID.test(id)) fail('the merchant id is invalid');
    const payee = payeeOf(payTo);
    if (this.db.prepare('SELECT 1 FROM merchants WHERE id = ?').get(id) !== undefined) fail('that merchant exists');
    const { keyId, secret, key } = newKey();
    this.db.prepare('INSERT INTO merchants (id, pay_to, key_id, key_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, payee, keyId, sha256(secret), nowMs);
    return key;
  }

  /** A new key for the merchant; the old one stops working at once. */
  rotate(id: string): string {
    const { keyId, secret, key } = newKey();
    const { changes } = this.db.prepare('UPDATE merchants SET key_id = ?, key_hash = ? WHERE id = ? AND revoked = 0')
      .run(keyId, sha256(secret), id);
    return changes === 1 ? key : fail('no such active merchant');
  }

  revoke(id: string): void {
    if (this.db.prepare('UPDATE merchants SET revoked = 1 WHERE id = ?').run(id).changes !== 1) fail('no such merchant');
  }

  /** The active merchant this key belongs to; undefined for anything else. */
  verify(key: string): Merchant | undefined {
    const parts = KEY.exec(key);
    if (parts === null) return undefined;
    const row = this.db.prepare('SELECT id, pay_to, key_hash FROM merchants WHERE key_id = ? AND revoked = 0').get(parts[1] ?? '') as
      { id: string; pay_to: string; key_hash: Uint8Array } | undefined;
    if (row === undefined || !timingSafeEqual(Buffer.from(row.key_hash), sha256(parts[2] ?? ''))) return undefined;
    return { id: row.id, payTo: row.pay_to };
  }

  /** Revoked merchants count: payments they took before revocation still settle to them. */
  isPayee(address: string): boolean {
    return this.db.prepare('SELECT 1 FROM merchants WHERE pay_to = ? COLLATE NOCASE').get(address) !== undefined;
  }

  all(): readonly (Merchant & { readonly revoked: boolean })[] {
    return (this.db.prepare('SELECT id, pay_to, revoked FROM merchants ORDER BY created_at, id').all() as { id: string; pay_to: string; revoked: number }[])
      .map((r) => ({ id: r.id, payTo: r.pay_to, revoked: r.revoked === 1 }));
  }
}
