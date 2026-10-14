import { BaseError, type Hex, type LocalAccount, keccak256 } from 'viem';
import { AcceptError, AcceptErrorCode as E } from '../errors.js';
import { ChainRevertError, type StuckReport, type Submitter, type TransferCall } from '../ports.js';
import { revertOf, transferData } from './abi.js';
import type { EstimateClient, SendClient } from './clients.js';
import { withDeadline } from './deadline.js';
import { address, bigintAtLeast, fail, onlyKnown, positiveInt, sameAddress } from './options.js';

export interface ViemSubmitterOptions {
  /** A wallet client with a local gas-only account (ETH for gas, nothing else) on `chainId`. */
  readonly wallet: SendClient;
  /** For the chain id, nonce, estimates and fees; usually on the same RPC as the wallet. */
  readonly client: EstimateClient;
  readonly chainId: number;
  /** The only token this account may call, and the only payee it may move funds to. */
  readonly asset: string;
  readonly payTo: string;
  /** Gas limit cap, at least 50 000. A contract-wallet payer that needs more is refused before sending. */
  readonly maxGas: bigint;
  /**
   * Fee cap in wei: when the network asks more, nothing is sent, and `replaceStuck` never re-prices
   * above it either (such a transaction waits, and later sends queue behind its nonce).
   */
  readonly maxFeePerGas: bigint;
  /** Per submit (queueing included), default 30 000 ms; a send that takes longer is an unknown outcome. */
  readonly timeoutMs?: number;
  /** How long a sent transaction may wait to be mined before `replaceStuck` re-prices it; default 60 000 ms. */
  readonly replaceAfterMs?: number;
  /** Milliseconds; for tests. Default Date.now. */
  readonly now?: () => number;
}

const KNOWN = ['wallet', 'client', 'chainId', 'asset', 'payTo', 'maxGas', 'maxFeePerGas', 'timeoutMs', 'replaceAfterMs', 'now'] as const;
const MIN_GAS = 50_000n;
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
/** Nodes take a replacement only when both fees rise by at least 10% (and strictly): the floor. */
const floorOf = (old: bigint): bigint => max((old * 11n + 9n) / 10n, old + 1n);
/** The target: 12.5% up (rounded up, at least 1 wei), or the market if that asks more. */
const bumped = (old: bigint, current: bigint): bigint => max(max((old * 9n + 7n) / 8n, old + 1n), current);
const textOf = (e: unknown): string => (e instanceof BaseError ? `${e.shortMessage} ${e.details}` : String((e as Error | undefined)?.message ?? e));
const alreadyKnown = (e: unknown): boolean => /already known|known transaction/i.test(textOf(e));
const nonceTooLow = (e: unknown): boolean => /nonce too low/i.test(textOf(e));
const authKey = (call: TransferCall): string => `${call.authorization.from}|${call.authorization.nonce}`.toLowerCase();

interface Signed {
  readonly raw: Hex;
  readonly hash: Hex;
  readonly nonce: number;
  readonly validBefore: bigint;
  readonly data: Hex;
  readonly gas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  /** When a node took this version (or when it was signed, until then): `replaceStuck` re-prices it once it has waited replaceAfterMs. */
  readonly signedAt: number;
  /** A node took it. Only such a transaction is ever re-priced: one whose broadcast failed was reported as failed. */
  readonly accepted: boolean;
}

/**
 * Broadcasts `transferWithAuthorization` on the pinned asset to the pinned payee, under gas and fee caps.
 * One authorization is signed into exactly one transaction: a retry rebroadcasts those same bytes, so a
 * late broadcast can never be joined by a second transaction for it. Sends go out one at a time, and the
 * next starts only once the previous has really finished, with a nonce that never goes backwards.
 * Refusals before sending throw ChainRevertError; anything that fails once a send was attempted is an
 * unknown outcome.
 */
export function viemSubmitter(options: ViemSubmitterOptions): Submitter {
  onlyKnown(options, KNOWN);
  const { wallet, client } = options;
  if (typeof wallet?.sendRawTransaction !== 'function') fail('wallet');
  const account = wallet.account;
  if (account?.type !== 'local' || typeof (account as LocalAccount).signTransaction !== 'function') fail('wallet (needs a local account)');
  const signer = account as LocalAccount;
  if (wallet.chain?.id !== options.chainId || !Number.isSafeInteger(options.chainId)) fail('chainId (the wallet is on another chain)');
  if (typeof client?.estimateGas !== 'function' || typeof client.getTransactionCount !== 'function') fail('client');
  const chainId = options.chainId;
  const asset = address(options.asset, 'asset');
  const payTo = address(options.payTo, 'payTo');
  const maxGas = bigintAtLeast(options.maxGas, MIN_GAS, 'maxGas');
  const maxFeePerGas = bigintAtLeast(options.maxFeePerGas, 1n, 'maxFeePerGas');
  const timeoutMs = positiveInt(options.timeoutMs, 30_000, 600_000, 'timeoutMs');
  const replaceAfterMs = positiveInt(options.replaceAfterMs, 60_000, 86_400_000, 'replaceAfterMs');
  if (options.now !== undefined && typeof options.now !== 'function') fail('now');
  const now = options.now ?? Date.now;

  const signed = new Map<string, Signed>();
  const inFlight = new Map<string, Promise<Hex>>();
  let nextNonce = 0;
  let checked: Promise<void> | undefined;

  const sameChain = (): Promise<void> => {
    checked ??= client.getChainId().then((id) => {
      if (id !== chainId) throw new AcceptError(E.CONFIG_INVALID, 'the estimate client is on another chain than chainId');
    }).catch((error: unknown) => {
      if (!(error instanceof AcceptError)) checked = undefined; // an outage: check again next time
      throw error;
    });
    return checked;
  };

  /**
   * A signed transaction no node took, whose authorization has expired, can never be sent: forget it.
   * One a node took is kept until its nonce is mined (`replaceStuck`), as it may still fill that nonce.
   */
  const forgetExpired = (): void => {
    const nowS = BigInt(Math.floor(now() / 1000));
    for (const [key, s] of signed) if (!s.accepted && s.validBefore < nowS) signed.delete(key);
  };

  async function sign(call: TransferCall): Promise<Signed> {
    await sameChain();
    const data = transferData(call);
    let gas: bigint;
    try {
      gas = await client.estimateGas({ account: signer, to: asset, data });
    } catch (error) {
      const reason = revertOf(error);
      if (reason !== undefined) throw new ChainRevertError(reason);
      throw error;
    }
    if (gas > maxGas) throw new ChainRevertError(`refused before sending: gas estimate ${gas} is above maxGas`);
    const fees = await client.estimateFeesPerGas();
    if (fees.maxFeePerGas > maxFeePerGas) throw new ChainRevertError(`refused before sending: fee ${fees.maxFeePerGas} is above maxFeePerGas`);
    const pending = await client.getTransactionCount({ address: signer.address, blockTag: 'pending' });
    const nonce = Math.max(pending, nextNonce); // a lagging RPC never takes the nonce backwards
    return signAt({
      nonce, data, gas: min((gas * 6n) / 5n, maxGas), validBefore: call.authorization.validBefore,
      maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: min(fees.maxPriorityFeePerGas, fees.maxFeePerGas),
    });
  }

  async function signAt(tx: Omit<Signed, 'raw' | 'hash' | 'signedAt' | 'accepted'>): Promise<Signed> {
    const raw = await signer.signTransaction({
      type: 'eip1559', chainId, nonce: tx.nonce, to: asset, data: tx.data, gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    });
    return { ...tx, raw, hash: keccak256(raw), signedAt: now(), accepted: false };
  }

  type Fees = { readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint };

  /**
   * The same nonce, data and gas at a higher price: `tx` itself while it still offers the market price
   * (it is only rebroadcast, never bumped blind), undefined when even a 10% bump would pass maxFeePerGas.
   */
  async function repriced(tx: Signed, market: Fees): Promise<Signed | undefined> {
    const marketTip = min(market.maxPriorityFeePerGas, market.maxFeePerGas);
    if (tx.maxFeePerGas >= market.maxFeePerGas && tx.maxPriorityFeePerGas >= marketTip) return tx;
    const fee = min(bumped(tx.maxFeePerGas, market.maxFeePerGas), maxFeePerGas);
    const tip = min(bumped(tx.maxPriorityFeePerGas, marketTip), fee);
    // The tip passes its floor whenever the fee does: the fee floor is at least the tip floor.
    if (fee < floorOf(tx.maxFeePerGas)) return undefined;
    return signAt({ ...tx, maxFeePerGas: fee, maxPriorityFeePerGas: tip });
  }

  /** Broadcasts; true if a node has it now, false if its nonce is already spent. Anything else throws. */
  async function broadcast(raw: Hex): Promise<boolean> {
    try {
      await wallet.sendRawTransaction({ serializedTransaction: raw });
      return true;
    } catch (error) {
      if (alreadyKnown(error)) return true;
      if (nonceTooLow(error)) return false;
      throw error;
    }
  }

  /** True if the node knows the transaction, pending or mined. An outage throws: never guess. */
  async function nodeHas(hash: Hex): Promise<boolean> {
    return (await client.request({ method: 'eth_getTransactionByHash', params: [hash] })) !== null;
  }

  /** Drops transactions whose nonce is spent; returns the accepted ones that have waited replaceAfterMs. */
  async function due(): Promise<[string, Signed][]> {
    const mined = await client.getTransactionCount({ address: signer.address, blockTag: 'latest' });
    for (const [key, tx] of signed) if (tx.nonce < mined) signed.delete(key);
    return [...signed].filter(([, tx]) => tx.accepted && now() - tx.signedAt >= replaceAfterMs);
  }

  /** One pass: fees read once, each transaction on its own, stopping at the time budget. */
  async function replace(): Promise<StuckReport> {
    let replaced = 0;
    let unreplaced = 0;
    let cause: unknown;
    if (signed.size === 0) return { replaced, unreplaced };
    await sameChain();
    const waiting = await due();
    if (waiting.length === 0) return { replaced, unreplaced };
    const market = await client.estimateFeesPerGas();
    const nowS = BigInt(Math.floor(now() / 1000));
    const highest = Math.max(...[...signed.values()].filter((tx) => tx.accepted).map((tx) => tx.nonce));
    const startedAt = now();
    for (const [key, tx] of waiting) {
      if (now() - startedAt > timeoutMs) {
        unreplaced += 1; // over budget: the next pass picks it up
        continue;
      }
      // An expired authorization only reverts: pay for that only when a later transaction waits on its nonce.
      if (tx.validBefore < nowS && tx.nonce >= highest) continue;
      try {
        const next = await repriced(tx, market);
        if (next === undefined) {
          unreplaced += 1;
          continue;
        }
        if (!(await broadcast(next.raw))) {
          signed.delete(key); // nonce too low: spent
          continue;
        }
        if (next !== tx) {
          signed.set(key, { ...next, accepted: true }); // a retry now resends this version; only one can land
          replaced += 1;
        }
      } catch (error) {
        unreplaced += 1; // the node kept the old one: try again next pass
        cause = error;
      }
    }
    return cause === undefined ? { replaced, unreplaced } : { replaced, unreplaced, cause };
  }

  /** Sign once per authorization, then broadcast; a later attempt broadcasts the same bytes again. */
  async function send(key: string, call: TransferCall): Promise<Hex> {
    let tx = signed.get(key);
    // A failed broadcast whose nonce another payment has since taken can never land: sign afresh. But a
    // transport error may hide a node that took it; then it can still land, and a second one would only revert.
    if (tx !== undefined && !tx.accepted && tx.nonce < nextNonce) {
      if (await nodeHas(tx.hash)) {
        signed.set(key, { ...tx, accepted: true, signedAt: now() });
        return tx.hash;
      }
      tx = undefined;
    }
    if (tx === undefined) {
      tx = await sign(call);
      signed.set(key, tx);
    }
    await wallet.sendRawTransaction({ serializedTransaction: tx.raw }).catch((error: unknown) => {
      if (!alreadyKnown(error)) throw error;
    });
    // The replaceAfterMs wait starts when a node first takes it, not when it was signed.
    signed.set(key, { ...tx, accepted: true, signedAt: tx.accepted ? tx.signedAt : now() });
    // Only an accepted broadcast moves the floor. After a failed one the next payment may take the same
    // nonce: at most one of the two can ever be mined, so an authorization never lands twice.
    nextNonce = Math.max(nextNonce, tx.nonce + 1);
    return tx.hash;
  }

  let tail: Promise<unknown> = Promise.resolve();
  let replacing: Promise<StuckReport> | undefined;
  /** One job at a time; the next starts only when this one has really finished. */
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const work = tail.then(job);
    tail = work.then(() => undefined, () => undefined);
    return work;
  };
  return {
    replaceStuck() {
      // Reconcile ticks never stack passes: a caller joins the pass already queued or running.
      replacing ??= enqueue(replace).finally(() => { replacing = undefined; });
      return withDeadline(replacing, timeoutMs, 'replaceStuck');
    },
    submit(call) {
      if (!sameAddress(call.asset, asset) || !sameAddress(call.authorization.to, payTo)) {
        return Promise.reject(new ChainRevertError('refused before sending: not the pinned asset and payee'));
      }
      forgetExpired();
      const key = authKey(call);
      const running = inFlight.get(key);
      if (running !== undefined) return withDeadline(running, timeoutMs, 'submit'); // the same authorization: wait for it
      let gaveUp = false;
      let started = false;
      const work = enqueue(() => {
        if (gaveUp) return Promise.reject(new ChainRevertError('refused before sending: the submit queue is busy'));
        started = true;
        return send(key, call);
      });
      inFlight.set(key, work);
      const done = (): void => { inFlight.delete(key); };
      work.then(done, done);
      return withDeadline(work, timeoutMs, 'submit').catch((error: unknown) => {
        if (started) throw error;
        gaveUp = true; // still queued at the deadline: it will never start, so nothing was sent
        throw new ChainRevertError('refused before sending: the submit queue is busy');
      });
    },
  };
}
