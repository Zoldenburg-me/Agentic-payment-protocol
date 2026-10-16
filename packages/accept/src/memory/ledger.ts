import { AcceptError, AcceptErrorCode as E, type AcceptErrorCode } from '../errors.js';
import type { NewSellerPayment, SellerLedgerPort, SellerPayment, SellerPaymentStatus } from '../ports.js';

/** Which settlement states each transition may start from. Nothing moves backward. */
export const FROM: Readonly<Record<Exclude<SellerPaymentStatus, 'owed'>, readonly SellerPaymentStatus[]>> = {
  submitted: ['owed'],
  settled: ['owed', 'submitted'],
  refused: ['owed', 'submitted'],
};

export const freeze = (row: SellerPayment): SellerPayment => Object.freeze({ ...row, meta: Object.freeze({ ...row.meta }) });

/** Finished rows: nothing more will happen to them, so they may be pruned. */
const finished = (row: SellerPayment): boolean => row.status === 'refused' || (row.status === 'settled' && row.delivered);

export function checkCutoff(beforeUnixS: number): void {
  if (!Number.isSafeInteger(beforeUnixS) || beforeUnixS < 0) throw new AcceptError(E.CONFIG_INVALID, 'prune cutoff must be unix seconds');
}

/** Single-process ledger for tests and local dev. Every row handed out is a frozen snapshot. */
export class MemorySellerLedger implements SellerLedgerPort {
  private readonly rows = new Map<string, SellerPayment>();

  async get(claimKey: string): Promise<SellerPayment | undefined> {
    return this.rows.get(claimKey);
  }

  async list(): Promise<readonly SellerPayment[]> {
    return [...this.rows.values()];
  }

  async undelivered(): Promise<readonly SellerPayment[]> {
    return [...this.rows.values()].filter((r) => r.status === 'settled' && !r.delivered);
  }

  async prune(beforeUnixS: number): Promise<number> {
    checkCutoff(beforeUnixS);
    const old = [...this.rows.values()].filter((r) => finished(r) && BigInt(r.validBefore) < BigInt(beforeUnixS));
    for (const r of old) this.rows.delete(r.claimKey);
    return old.length;
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

  async recordRefused(claimKey: string, code: AcceptErrorCode, txHash?: string): Promise<SellerPayment> {
    return this.move(claimKey, 'refused', { refusal: code, ...(txHash !== undefined ? { txHash } : {}) });
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
