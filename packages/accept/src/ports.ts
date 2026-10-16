import type { Hex } from 'viem';
import type { Eip3009Rpc } from 'agentpay-hub/protocol';
import type { AcceptErrorCode } from './errors.js';

/** The one call the submitter may make: `transferWithAuthorization` on the pinned asset. */
export interface TransferCall {
  readonly asset: string;
  readonly authorization: {
    readonly from: Hex;
    readonly to: Hex;
    readonly value: bigint;
    readonly validAfter: bigint;
    readonly validBefore: bigint;
    readonly nonce: Hex;
  };
  readonly signature: Hex;
}

export interface ChainLog {
  readonly address: string;
  readonly event: 'Transfer' | 'AuthorizationUsed';
  readonly args: Readonly<Record<string, string | bigint>>;
}

export interface TxReceipt {
  readonly txHash: Hex;
  readonly status: 'success' | 'reverted';
  readonly blockNumber: bigint;
  readonly logs: readonly ChainLog[];
}

/** Thrown when a call or submission executed and reverted. Any other error is an RPC failure. */
export class ChainRevertError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ChainRevertError';
  }
}

/** Chain reads. Every method throws on RPC failure; the middleware then fails closed. */
export interface ChainPort extends Eip3009Rpc {
  blockNumber(): Promise<bigint>;
  authorizationState(asset: string, authorizer: string, nonce: Hex): Promise<boolean>;
  balanceOf(asset: string, owner: string): Promise<bigint>;
  /** eth_call of the exact transfer; throws ChainRevertError if it would revert. */
  simulateTransfer(call: TransferCall): Promise<void>;
  getReceipt(txHash: Hex): Promise<TxReceipt | undefined>;
  /** The transaction that used this authorization (AuthorizationUsed log), if any. */
  findAuthorizationUse(asset: string, authorizer: string, nonce: Hex): Promise<Hex | undefined>;
}

/**
 * Broadcasts the pinned call from a gas-only account. Throws ChainRevertError when the
 * call reverts before broadcast (nothing sent); any other error means the outcome is unknown.
 */
export interface Submitter {
  submit(call: TransferCall): Promise<Hex>;
  /**
   * Optional: re-prices transactions a node accepted that have waited too long to be mined, keeping
   * their nonce (so at most one version can land). `unreplaced` counts those it could not re-price,
   * with the last `cause`.
   */
  replaceStuck?(): Promise<StuckReport>;
}

export interface StuckReport {
  readonly replaced: number;
  readonly unreplaced: number;
  readonly cause?: unknown;
}

export interface RateLimiter {
  /** Takes one unit for `key`; false when `limit` per minute is used up. */
  take(key: string, limit: number, nowMs: number): boolean;
}

/** Settlement moves forward only: owed → submitted → settled, or → refused. Delivery is a separate once-only flag. */
export type SellerPaymentStatus = 'owed' | 'submitted' | 'settled' | 'refused';

export interface NewSellerPayment {
  readonly claimKey: string;
  readonly sellerAccountId: string;
  readonly protocol: 'x402';
  readonly chainId: number;
  readonly asset: string;
  readonly payer: string;
  readonly nonce: string;
  readonly amount: string;
  /** The payee this payment was verified for; a later payTo change does not apply to it. */
  readonly payTo: string;
  readonly validBefore: string;
  readonly method: string;
  readonly path: string;
  /**
   * sha256 of the query string: a replay must match it, since sellers may serve by query. Only the
   * digest is stored, because query strings often carry personal data (e.g. `?email=`).
   */
  readonly queryDigest: string;
  /** sha256 of the PAYMENT-SIGNATURE header exactly as sent: a retry must resend it byte for byte. */
  readonly headerDigest: string;
  readonly meta: Readonly<Record<string, string>>;
}

export interface SellerPayment extends NewSellerPayment {
  readonly status: SellerPaymentStatus;
  readonly delivered: boolean;
  readonly txHash?: string;
  readonly refusal?: AcceptErrorCode;
}

/**
 * The seller's payment ledger. In a shared database every transition must be a compare-and-set on the
 * current status (and markDelivered on `delivered = false`), so two processes cannot both move a row.
 * Rows left `owed` or `submitted` with an untraceable on-chain use (reported as SETTLEMENT_UNKNOWN)
 * are for reconciliation; a retry never guesses their outcome.
 */
export interface SellerLedgerPort {
  get(claimKey: string): Promise<SellerPayment | undefined>;
  list(): Promise<readonly SellerPayment[]>;
  /** Writes the row as `owed`; never overwrites an existing row. */
  recordVerified(row: NewSellerPayment): Promise<{ readonly created: boolean; readonly row: SellerPayment }>;
  recordSubmitted(claimKey: string, txHash: string): Promise<SellerPayment>;
  recordSettled(claimKey: string, txHash: string): Promise<SellerPayment>;
  /** `txHash` is kept when a mined transaction was refused (e.g. TRANSFER_MISMATCH), for reconciliation. */
  recordRefused(claimKey: string, code: AcceptErrorCode, txHash?: string): Promise<SellerPayment>;
  /** Sets the delivery flag; `first` is false if it was already set. */
  markDelivered(claimKey: string): Promise<{ readonly first: boolean; readonly row: SellerPayment }>;
  /** Optional: settled rows not yet delivered (a failed or crashed delivery), oldest first. Deliver them, then markDelivered. */
  undelivered?(): Promise<readonly SellerPayment[]>;
  /**
   * Optional: deletes finished rows (refused, or settled and delivered) whose validBefore is before
   * `beforeUnixS`; returns how many. Open and settled-undelivered rows are kept. A pruned payment's
   * retry gets NONCE_REPLAY (or EXPIRED) instead of a replay, so keep rows as long as retries matter.
   */
  prune?(beforeUnixS: number): Promise<number>;
}
