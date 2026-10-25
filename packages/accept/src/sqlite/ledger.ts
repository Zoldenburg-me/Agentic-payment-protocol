import type { DatabaseSync } from 'node:sqlite';
import { AcceptError, AcceptErrorCode as E, type AcceptErrorCode } from '../errors.js';
import type { NewSellerPayment, SellerLedgerPort, SellerPayment, SellerPaymentStatus } from '../ports.js';
import { FROM, checkCutoff, freeze } from '../memory/ledger.js';

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
      row TEXT NOT NULL,
      settled_seq INTEGER
    );
    CREATE INDEX IF NOT EXISTS seller_payments_status ON seller_payments (status, delivered)`);
    // A file made before settled_seq existed gets the column, then its settled rows numbered in seq order. One
    // transaction: workers starting together migrate once, and a restart mid-way neither skips nor renumbers a row.
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!(db.prepare('PRAGMA table_info(seller_payments)').all() as { name: string }[]).some((c) => c.name === 'settled_seq')) {
        db.exec('ALTER TABLE seller_payments ADD COLUMN settled_seq INTEGER');
      }
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS seller_payments_settled_seq ON seller_payments (settled_seq);
        UPDATE seller_payments SET settled_seq = b.n FROM (
          SELECT seq, (SELECT COALESCE(MAX(settled_seq), 0) FROM seller_payments) + ROW_NUMBER() OVER (ORDER BY seq) AS n
          FROM seller_payments WHERE status = 'settled' AND settled_seq IS NULL
        ) AS b WHERE seller_payments.seq = b.seq`);
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK'); // never leave the handle inside a half-done migration
      throw error;
    }
  }

  async get(claimKey: string): Promise<SellerPayment | undefined> {
    const found = this.db.prepare('SELECT status, delivered, row FROM seller_payments WHERE claim_key = ?').get(claimKey);
    return found && read(found as unknown as Stored);
  }

  async list(): Promise<readonly SellerPayment[]> {
    return this.db.prepare('SELECT status, delivered, row FROM seller_payments ORDER BY seq').all()
      .map((s) => read(s as unknown as Stored));
  }

  async undelivered(): Promise<readonly SellerPayment[]> {
    return this.db.prepare("SELECT status, delivered, row FROM seller_payments WHERE status = 'settled' AND delivered = 0 ORDER BY seq").all()
      .map((s) => read(s as unknown as Stored));
  }

  /**
   * One seller's settled rows after `since`, in the order they settled, each with its `settledSeq` as a
   * paging cursor. Numbered when the row settles (in commit order), so a payment that settles late is
   * never behind a cursor that already passed it.
   */
  settledSince(sellerAccountId: string, since: number, limit: number): readonly (SellerPayment & { readonly settledSeq: number })[] {
    // shortcut: walks settled_seq > since and filters the seller in JSON; add a seller column and index when one hub serves many busy merchants.
    return (this.db.prepare(
      `SELECT settled_seq, status, delivered, row FROM seller_payments WHERE settled_seq > ?
        AND json_extract(row, '$.sellerAccountId') = ? ORDER BY settled_seq LIMIT ?`,
    ).all(since, sellerAccountId, limit) as unknown as (Stored & { settled_seq: number })[])
      .map((s) => ({ ...read(s), settledSeq: s.settled_seq }));
  }

  async prune(beforeUnixS: number): Promise<number> {
    checkCutoff(beforeUnixS);
    const { changes } = this.db.prepare(
      `DELETE FROM seller_payments WHERE (status = 'refused' OR (status = 'settled' AND delivered = 1))
        AND CAST(json_extract(row, '$.validBefore') AS INTEGER) < ?`,
    ).run(beforeUnixS);
    return Number(changes);
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

  async recordSettled(claimKey: string, txHash: string, logIndex?: number): Promise<SellerPayment> {
    return this.move(claimKey, 'settled', { txHash, ...(logIndex !== undefined ? { logIndex } : {}) });
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
      // One statement, so the next settled_seq is taken under SQLite's write lock: numbers follow commit order.
      // shortcut: MAX restarts if pruning ever deletes the newest settled row (none settled for the retention years); keep a counter row then.
      const { changes } = this.db.prepare(
        `UPDATE seller_payments SET status = ?, row = ?, settled_seq = CASE WHEN ? = 'settled'
          THEN (SELECT COALESCE(MAX(settled_seq), 0) + 1 FROM seller_payments) ELSE settled_seq END
          WHERE claim_key = ? AND status = ?`,
      ).run(to, JSON.stringify(rest), to, claimKey, current.status);
      if (changes === 1) return this.current(claimKey);
    }
  }

  private async current(claimKey: string): Promise<SellerPayment> {
    const row = await this.get(claimKey);
    if (!row) throw new AcceptError(E.LEDGER_TRANSITION, 'unknown seller payment');
    return row;
  }
}
