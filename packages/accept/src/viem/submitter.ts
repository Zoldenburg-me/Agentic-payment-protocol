import { type Hex, type LocalAccount, keccak256 } from 'viem';
import { AcceptError, AcceptErrorCode as E } from '../errors.js';
import { ChainRevertError, type Submitter, type TransferCall } from '../ports.js';
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
   * Fee cap in wei: when the network asks more, nothing is sent. A transaction already sent is not
   * re-priced; if fees rise past it before inclusion it waits, and later sends queue behind its nonce.
   */
  readonly maxFeePerGas: bigint;
  /** Per submit (queueing included), default 30 000 ms; a send that takes longer is an unknown outcome. */
  readonly timeoutMs?: number;
}

const KNOWN = ['wallet', 'client', 'chainId', 'asset', 'payTo', 'maxGas', 'maxFeePerGas', 'timeoutMs'] as const;
const MIN_GAS = 50_000n;
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const authKey = (call: TransferCall): string => `${call.authorization.from}|${call.authorization.nonce}`.toLowerCase();

interface Signed {
  readonly raw: Hex;
  readonly hash: Hex;
  readonly nonce: number;
  readonly validBefore: bigint;
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

  /** Signed transactions whose authorization has expired can never execute: forget them. */
  const forgetExpired = (): void => {
    const nowS = BigInt(Math.floor(Date.now() / 1000));
    for (const [key, s] of signed) if (s.validBefore < nowS) signed.delete(key);
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
    const raw = await signer.signTransaction({
      type: 'eip1559', chainId, nonce, to: asset, data, gas: min((gas * 6n) / 5n, maxGas),
      maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: min(fees.maxPriorityFeePerGas, fees.maxFeePerGas),
    });
    return { raw, hash: keccak256(raw), nonce, validBefore: call.authorization.validBefore };
  }

  /** Sign once per authorization, then broadcast; a later attempt broadcasts the same bytes again. */
  async function send(key: string, call: TransferCall): Promise<Hex> {
    let tx = signed.get(key);
    if (tx === undefined) {
      tx = await sign(call);
      signed.set(key, tx);
    }
    await wallet.sendRawTransaction({ serializedTransaction: tx.raw });
    // Only an accepted broadcast moves the floor. After a failed one the next payment may take the same
    // nonce: at most one of the two can ever be mined, so an authorization never lands twice.
    nextNonce = Math.max(nextNonce, tx.nonce + 1);
    return tx.hash;
  }

  let tail: Promise<unknown> = Promise.resolve();
  return {
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
      const work = tail.then(() => {
        if (gaveUp) throw new ChainRevertError('refused before sending: the submit queue is busy');
        started = true;
        return send(key, call);
      });
      inFlight.set(key, work);
      // The queue moves on only when this send has really finished, never at the caller's deadline.
      tail = work.catch(() => undefined).finally(() => { inFlight.delete(key); });
      return withDeadline(work, timeoutMs, 'submit').catch((error: unknown) => {
        if (started) throw error;
        gaveUp = true; // still queued at the deadline: it will never start, so nothing was sent
        throw new ChainRevertError('refused before sending: the submit queue is busy');
      });
    },
  };
}
