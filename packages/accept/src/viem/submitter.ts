import type { Account, Hex } from 'viem';
import { ChainRevertError, type Submitter, type TransferCall } from '../ports.js';
import { revertOf, transferData } from './abi.js';
import type { EstimateClient, SendClient } from './clients.js';
import { withDeadline } from './deadline.js';
import { address, bigintAtLeast, fail, onlyKnown, positiveInt, sameAddress } from './options.js';

export interface ViemSubmitterOptions {
  /** A wallet client with a gas-only account (ETH for gas, nothing else) on `chainId`. */
  readonly wallet: SendClient;
  /** For estimates and fees; usually on the same RPC as the wallet. */
  readonly client: EstimateClient;
  readonly chainId: number;
  /** The only token this account may call, and the only payee it may move funds to. */
  readonly asset: string;
  readonly payTo: string;
  /** Gas limit cap, at least 50 000. A contract-wallet payer that needs more is refused before sending. */
  readonly maxGas: bigint;
  /** Fee cap in wei. When the network asks more, nothing is sent (so no transaction is left stuck). */
  readonly maxFeePerGas: bigint;
  /** Per submit, default 30 000 ms; a send that takes longer is an unknown outcome. */
  readonly timeoutMs?: number;
}

const KNOWN = ['wallet', 'client', 'chainId', 'asset', 'payTo', 'maxGas', 'maxFeePerGas', 'timeoutMs'] as const;
const MIN_GAS = 50_000n;
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/**
 * Broadcasts `transferWithAuthorization` on the pinned asset to the pinned payee, under gas and fee caps,
 * one transaction at a time (so concurrent payments never race for a nonce). Refusals before sending
 * throw ChainRevertError; anything that fails once a send was attempted is an unknown outcome.
 */
export function viemSubmitter(options: ViemSubmitterOptions): Submitter {
  onlyKnown(options, KNOWN);
  const { wallet, client } = options;
  if (typeof wallet?.sendTransaction !== 'function') fail('wallet');
  const account: Account = wallet.account ?? fail('wallet (needs an account)');
  if (wallet.chain?.id !== options.chainId || !Number.isSafeInteger(options.chainId)) fail('chainId (the wallet is on another chain)');
  if (typeof client?.estimateGas !== 'function') fail('client');
  const asset = address(options.asset, 'asset');
  const payTo = address(options.payTo, 'payTo');
  const maxGas = bigintAtLeast(options.maxGas, MIN_GAS, 'maxGas');
  const maxFeePerGas = bigintAtLeast(options.maxFeePerGas, 1n, 'maxFeePerGas');
  const timeoutMs = positiveInt(options.timeoutMs, 30_000, 600_000, 'timeoutMs');

  async function send(call: TransferCall): Promise<Hex> {
    const data = transferData(call);
    let gas: bigint;
    try {
      gas = await client.estimateGas({ account, to: asset, data });
    } catch (error) {
      const reason = revertOf(error);
      if (reason !== undefined) throw new ChainRevertError(reason);
      throw error;
    }
    if (gas > maxGas) throw new ChainRevertError(`refused before sending: gas estimate ${gas} is above maxGas`);
    const fees = await client.estimateFeesPerGas();
    if (fees.maxFeePerGas > maxFeePerGas) throw new ChainRevertError(`refused before sending: fee ${fees.maxFeePerGas} is above maxFeePerGas`);
    return wallet.sendTransaction({
      account, chain: wallet.chain, to: asset, data, gas: min((gas * 6n) / 5n, maxGas),
      maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: min(fees.maxPriorityFeePerGas, fees.maxFeePerGas),
    });
  }

  let tail: Promise<unknown> = Promise.resolve();
  return {
    submit(call) {
      if (!sameAddress(call.asset, asset) || !sameAddress(call.authorization.to, payTo)) {
        return Promise.reject(new ChainRevertError('refused before sending: not the pinned asset and payee'));
      }
      const next = tail.then(() => withDeadline(send(call), timeoutMs, 'submit'));
      tail = next.catch(() => undefined);
      return next;
    },
  };
}
