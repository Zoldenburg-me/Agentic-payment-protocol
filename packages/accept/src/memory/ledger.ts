import { AcceptError, AcceptErrorCode as E, type AcceptErrorCode } from '../errors.js';
import type { NewSellerPayment, SellerLedgerPort, SellerPayment, SellerPaymentStatus } from '../ports.js';

/** Which settlement states each transition may start from. Nothing moves backward. */
const FROM: Readonly<Record<Exclude<SellerPaymentStatus, 'owed'>, readonly SellerPaymentStatus[]>> = {
  submitted: ['owed'],
  settled: ['owed', 'submitted'],
  refused: ['owed', 'submitted'],
};

const freeze = (row: SellerPayment): SellerPayment => Object.freeze({ ...row, meta: Object.freeze({ ...row.meta }) });

/** Single-process ledger for tests and local dev. Every row handed out is a frozen snapshot. */
export class MemorySellerLedger implements SellerLedgerPort {
  private readonly rows = new Map<string, SellerPayment>();

  async get(claimKey: string): Promise<SellerPayment | undefined> {
    return this.rows.get(claimKey);
  }

  async list(): Promise<readonly SellerPayment[]> {
    return [...this.rows.values()];
  }

  async recordVerified(row: NewSellerPayment): Promise<{ created: boolean; row: SellerPayment }> {
    const existing = this.rows.get(row.claimKey);
    if (existing) return { created: false, row: existing };
    return { created: true, row: this.put(freeze({ ...row, status: 'owed', delivered: false })) };
  }

  async recordSubmitted(claimKey: string, txHash: string): Promise<SellerPayment> {
    return this.move(claimKey, 'submitted', { txHash });
  }

  async recordSettled(claimKey: string, txHash: string): Promise<SellerPayment> {
    return this.move(claimKey, 'settled', { txHash });
  }

  async recordRefused(claimKey: string, code: AcceptErrorCode): Promise<SellerPayment> {
    return this.move(claimKey, 'refused', { refusal: code });
  }

  async markDelivered(claimKey: string): Promise<{ first: boolean; row: SellerPayment }> {
    const current = this.current(claimKey);
    if (current.delivered) return { first: false, row: current };
    if (current.status === 'refused') throw new AcceptError(E.LEDGER_TRANSITION, 'a refused payment is never delivered');
    return { first: true, row: this.put(freeze({ ...current, delivered: true })) };
  }

  private move(claimKey: string, to: Exclude<SellerPaymentStatus, 'owed'>, patch: Partial<SellerPayment>): SellerPayment {
    const current = this.current(claimKey);
    if (!FROM[to].includes(current.status)) {
      throw new AcceptError(E.LEDGER_TRANSITION, `seller payment cannot move from ${current.status} to ${to}`);
    }
    return this.put(freeze({ ...current, ...patch, status: to }));
  }

  private current(claimKey: string): SellerPayment {
    const row = this.rows.get(claimKey);
    if (!row) throw new AcceptError(E.LEDGER_TRANSITION, 'unknown seller payment');
    return row;
  }

  private put(row: SellerPayment): SellerPayment {
    this.rows.set(row.claimKey, row);
    return row;
  }
}
