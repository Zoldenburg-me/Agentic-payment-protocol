import type { DatabaseSync } from 'node:sqlite';
import { AcceptError, AcceptErrorCode as E, type AcceptErrorCode } from '../errors.js';
import type { NewSellerPayment, SellerLedgerPort, SellerPayment, SellerPaymentStatus } from '../ports.js';
import { FROM, freeze } from '../memory/ledger.js';

interface Stored {
  readonly status: SellerPaymentStatus;
  readonly delivered: number;
  readonly row: string;
}

/** Status and delivery live in their own columns, so each is compare-and-set alone and never overwritten by the other. */
const read = (s: Stored): SellerPayment => freeze({ ...(JSON.parse(s.row) as SellerPayment), status: s.status, delivered: s.delivered === 1 });

/**
 * The seller ledger in SQLite, shared by every process that opens the same file. A status move is a
 * compare-and-set on the status, and delivery on `delivered = 0`, so two processes cannot both move a row.
 */
export class SqliteSellerLedger implements SellerLedgerPort {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS seller_payments (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      delivered INTEGER NOT NULL,
      row TEXT NOT NULL
    )`);
  }

  async get(claimKey: string): Promise<SellerPayment | undefined> {
    const found = this.db.prepare('SELECT status, delivered, row FROM seller_payments WHERE claim_key = ?').get(claimKey);
    return found && read(found as unknown as Stored);
  }

  async list(): Promise<readonly SellerPayment[]> {
    return this.db.prepare('SELECT status, delivered, row FROM seller_payments ORDER BY seq').all()
      .map((s) => read(s as unknown as Stored));
  }

  async recordVerified(row: NewSellerPayment): Promise<{ created: boolean; row: SellerPayment }> {
    const { changes } = this.db.prepare(
      "INSERT INTO seller_payments (claim_key, status, delivered, row) VALUES (?, 'owed', 0, ?) ON CONFLICT (claim_key) DO NOTHING",
    ).run(row.claimKey, JSON.stringify(row));
    if (changes === 1) return { created: true, row: freeze({ ...row, status: 'owed', delivered: false }) };
    return { created: false, row: await this.current(row.claimKey) };
  }

  async recordSubmitted(claimKey: string, txHash: string): Promise<SellerPayment> {
    return this.move(claimKey, 'submitted', { txHash });
  }

  async recordSettled(claimKey: string, txHash: string): Promise<SellerPayment> {
    return this.move(claimKey, 'settled', { txHash });
  }

  async recordRefused(claimKey: string, code: AcceptErrorCode, txHash?: string): Promise<SellerPayment> {
    return this.move(claimKey, 'refused', { refusal: code, ...(txHash !== undefined ? { txHash } : {}) });
  }

  async markDelivered(claimKey: string): Promise<{ first: boolean; row: SellerPayment }> {
    const { changes } = this.db.prepare(
      "UPDATE seller_payments SET delivered = 1 WHERE claim_key = ? AND delivered = 0 AND status <> 'refused'",
    ).run(claimKey);
    const row = await this.current(claimKey);
    if (changes === 1) return { first: true, row };
    if (row.delivered) return { first: false, row };
    throw new AcceptError(E.LEDGER_TRANSITION, 'a refused payment is never delivered');
  }

  private async move(claimKey: string, to: Exclude<SellerPaymentStatus, 'owed'>, patch: Partial<SellerPayment>): Promise<SellerPayment> {
    // Status only moves forward, so a lost compare-and-set re-checks the newer status: this ends in a few rounds.
    for (;;) {
      const current = await this.current(claimKey);
      if (!FROM[to].includes(current.status)) {
        throw new AcceptError(E.LEDGER_TRANSITION, `seller payment cannot move from ${current.status} to ${to}`);
      }
      const { status: _status, delivered: _delivered, ...rest } = { ...current, ...patch };
      const { changes } = this.db.prepare('UPDATE seller_payments SET status = ?, row = ? WHERE claim_key = ? AND status = ?')
        .run(to, JSON.stringify(rest), claimKey, current.status);
      if (changes === 1) return this.current(claimKey);
    }
  }

  private async current(claimKey: string): Promise<SellerPayment> {
    const row = await this.get(claimKey);
    if (!row) throw new AcceptError(E.LEDGER_TRANSITION, 'unknown seller payment');
    return row;
  }
}
