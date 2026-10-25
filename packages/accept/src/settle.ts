import type { Hex } from 'viem';
import type { AcceptConfig } from './config.js';
import { AcceptErrorCode as E, type AcceptErrorCode, statusFor } from './errors.js';
import { type ChainPort, ChainRevertError, type Submitter, type TransferCall, type TxReceipt } from './ports.js';

export interface SettleEnv {
  readonly config: AcceptConfig;
  readonly chain: ChainPort;
  readonly submitter: Submitter;
  readonly sleep: (ms: number) => Promise<void>;
  /** Milliseconds; bounds a wait by elapsed time, not only by its number of polls. */
  readonly now: () => number;
}

export interface SettleFailure {
  readonly ok: false;
  readonly code: AcceptErrorCode;
  readonly status: number;
  /** True only when the authorization provably did not and cannot settle through us. */
  readonly release: boolean;
  /** False when the outcome is unknown and the ledger row must stay as it is for reconciliation. */
  readonly final: boolean;
  /** The transaction the failure is about, when one was mined (e.g. TRANSFER_MISMATCH). */
  readonly txHash?: Hex;
  /** The underlying error when the outcome is ambiguous because a call failed (transport, RPC). */
  readonly cause?: unknown;
}

/** What a settled payment must show on chain. Enough to re-check a payment from its ledger row alone. */
export interface Expected {
  readonly asset: string;
  readonly from: string;
  readonly to: string;
  readonly value: bigint;
  readonly nonce: Hex;
}

export type Precheck = { readonly ok: true; readonly existing?: Hex } | SettleFailure;
export type Submitted = { readonly ok: true; readonly txHash: Hex; readonly ours: boolean } | SettleFailure;
/** `logIndex` is the payment's one Transfer log in `txHash`. */
export type Settled = { readonly ok: true; readonly txHash: Hex; readonly logIndex: number } | SettleFailure;

const failure = (code: AcceptErrorCode, release: boolean, final = true, status = statusFor(code)): SettleFailure =>
  ({ ok: false, code, status, release, final });

const withCause = (f: SettleFailure, cause: unknown): SettleFailure => (cause === undefined ? f : { ...f, cause });

/** Transaction hashes are hex: compare them whatever case the RPC returned. */
const sameTx = (a: string | undefined, b: string): boolean => a !== undefined && a.toLowerCase() === b.toLowerCase();

export const expectedOf = (call: TransferCall): Expected => ({
  asset: call.asset, from: call.authorization.from, to: call.authorization.to,
  value: call.authorization.value, nonce: call.authorization.nonce,
});

/** The transaction that used the authorization, if the nonce is used; undefined if it is still free. */
async function usedBy(env: SettleEnv, e: Expected): Promise<{ used: boolean; txHash: Hex | undefined }> {
  if (!(await env.chain.authorizationState(e.asset, e.from, e.nonce))) return { used: false, txHash: undefined };
  return { used: true, txHash: await env.chain.findAuthorizationUse(e.asset, e.from, e.nonce) };
}

/**
 * Step 6, before anything is written or sent: nonce state, balance, simulation. A used
 * authorization with a known transaction is a front-run to settle from (`existing`).
 * Every failure here is pre-send, so the claim may be released. `reserved` is what the payer already
 * owes through payments still unsettled, so it cannot sign more than it holds.
 */
export async function precheck(env: SettleEnv, call: TransferCall, reserved = 0n): Promise<Precheck> {
  const e = expectedOf(call);
  try {
    const use = await usedBy(env, e);
    if (use.used) return use.txHash ? { ok: true, existing: use.txHash } : failure(E.AUTHORIZATION_USED, false);
    if ((await env.chain.balanceOf(call.asset, e.from)) < e.value + reserved) return failure(E.INSUFFICIENT_FUNDS, true);
  } catch {
    return failure(E.RPC_UNAVAILABLE, true);
  }
  try {
    await env.chain.simulateTransfer(call);
    return { ok: true };
  } catch (error) {
    if (!(error instanceof ChainRevertError)) return failure(E.RPC_UNAVAILABLE, true);
  }
  // The simulation reverted: a front-run between the pre-check and now looks exactly like this.
  try {
    const use = await usedBy(env, e);
    if (use.used) return use.txHash ? { ok: true, existing: use.txHash } : failure(E.AUTHORIZATION_USED, false);
  } catch {
    return failure(E.RPC_UNAVAILABLE, true);
  }
  return failure(E.SIMULATION_FAILED, true);
}

/** Step 7: broadcast. A revert before broadcast is re-checked for a front-run; any other error is an unknown outcome. */
export async function submit(env: SettleEnv, call: TransferCall): Promise<Submitted> {
  try {
    return { ok: true, txHash: await env.submitter.submit(call), ours: true };
  } catch (error) {
    if (!(error instanceof ChainRevertError)) return withCause(failure(E.SUBMIT_FAILED, false, false, 503), error);
  }
  try {
    const use = await usedBy(env, expectedOf(call));
    // Reverted before broadcast, nothing sent. Not final: the authorization stays valid until validBefore
    // and anyone holding it can still submit it, so the claim is kept and a retry re-checks the chain.
    if (!use.used) return failure(E.SUBMIT_FAILED, false, false);
    return use.txHash ? { ok: true, txHash: use.txHash, ours: false } : failure(E.SETTLEMENT_UNKNOWN, false, false);
  } catch {
    return failure(E.RPC_UNAVAILABLE, false, false);
  }
}

/** Polls until the receipt (success or revert) is `minConfirmations` deep, re-reading it so a reorg cannot slip through. */
async function waitForReceipt(env: SettleEnv, txHash: Hex): Promise<{ receipt?: TxReceipt; lastError?: unknown }> {
  const { pollIntervalMs, settlementTimeoutMs, minConfirmations } = env.config;
  const polls = Math.ceil(settlementTimeoutMs / pollIntervalMs);
  const deadline = env.now() + settlementTimeoutMs; // slow RPC calls count too, not just the sleeps
  let lastError: unknown;
  for (let i = 0; i < polls && env.now() < deadline; i++) {
    try {
      const receipt = await env.chain.getReceipt(txHash);
      lastError = undefined;
      if (receipt && (await env.chain.blockNumber()) - receipt.blockNumber + 1n >= BigInt(minConfirmations)) {
        const again = await env.chain.getReceipt(txHash);
        if (again && again.blockNumber === receipt.blockNumber) return { receipt: again };
      }
    } catch (error) {
      lastError = error; // retried until the deadline; the outcome stays unknown, never assumed
    }
    await env.sleep(pollIntervalMs);
  }
  return { lastError };
}

/**
 * The AuthorizationUsed for this nonce and exactly one Transfer of `value` from the payer to payTo, both
 * from the asset. Other transfers in the same transaction (e.g. a bundling front-runner's) are ignored.
 */
function measured(receipt: TxReceipt, e: Expected): number | undefined {
  const same = (x: unknown, y: string) => typeof x === 'string' && x.toLowerCase() === y.toLowerCase();
  const fromAsset = receipt.logs.filter((l) => same(l.address, e.asset));
  const payments = fromAsset.filter((l) =>
    l.event === 'Transfer' && same(l.args.from, e.from) && same(l.args.to, e.to) && l.args.value === e.value);
  const used = fromAsset.some((l) => l.event === 'AuthorizationUsed' && same(l.args.authorizer, e.from) && same(l.args.nonce, e.nonce));
  return used && payments.length === 1 ? payments[0]?.logIndex : undefined;
}

/**
 * Step 8: confirmations, then measure. A confirmed revert is followed to the transaction that
 * used the authorization (a mempool front-run); it is final only if the authorization is still unused.
 */
export async function confirm(env: SettleEnv, e: Expected, txHash: Hex, followed = false): Promise<Settled> {
  const { receipt, lastError } = await waitForReceipt(env, txHash);
  if (!receipt) {
    let use: { used: boolean; txHash: Hex | undefined };
    try {
      use = await usedBy(env, e);
    } catch (error) {
      return withCause(failure(E.SETTLEMENT_TIMEOUT, false, false), lastError ?? error); // unknown either way; the row stays open
    }
    // Ours may have been dropped or replaced while someone else used the authorization: follow theirs once.
    if (use.txHash && !sameTx(use.txHash, txHash) && !followed) return confirm(env, e, use.txHash, true);
    // Used, but not by a transaction we can see a receipt for: only reconciliation can tell.
    if (use.used) return failure(E.SETTLEMENT_UNKNOWN, false, false);
    return withCause(failure(E.SETTLEMENT_TIMEOUT, false, false), lastError);
  }
  if (receipt.status === 'success') {
    const logIndex = measured(receipt, e);
    return logIndex !== undefined ? { ok: true, txHash, logIndex } : { ...failure(E.TRANSFER_MISMATCH, false), txHash };
  }
  let use: { used: boolean; txHash: Hex | undefined };
  try {
    use = await usedBy(env, e);
  } catch (error) {
    return withCause(failure(E.RPC_UNAVAILABLE, false, false), error);
  }
  if (use.txHash && !sameTx(use.txHash, txHash) && !followed) return confirm(env, e, use.txHash, true);
  if (!use.used) return failure(E.SUBMIT_FAILED, false, false); // ours reverted; the authorization can still settle
  return failure(E.SETTLEMENT_UNKNOWN, false, false);
}
