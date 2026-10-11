import {
  BaseError, type Hex, TransactionReceiptNotFoundError, decodeFunctionResult, encodeEventTopics, encodeFunctionData, numberToHex, parseEventLogs,
} from 'viem';
import { viemRpc } from 'agentpay-hub/protocol';
import { AcceptError, AcceptErrorCode as E } from '../errors.js';
import { type ChainLog, type ChainPort, ChainRevertError, type TransferCall, type TxReceipt } from '../ports.js';
import { TOKEN_ABI, TOKEN_EVENTS, revertOf, transferData } from './abi.js';
import type { ReadClient } from './clients.js';
import { withDeadline } from './deadline.js';
import { bigintAtLeast, fail, onlyKnown, positiveInt } from './options.js';

export interface ViemChainOptions {
  /** A viem public client on your own RPC. Its URL may hold an API key: it never leaves this client. */
  readonly client: ReadClient;
  /** Checked against the RPC before the first read; another chain fails every call. */
  readonly chainId: number;
  /** Per call, default 10 000 ms. A call that takes longer is an outage, and the payment stays open. */
  readonly timeoutMs?: number;
  /**
   * How far back `findAuthorizationUse` searches, default 10 000 blocks (about 5.5 h on Base). Keep it
   * within your RPC's eth_getLogs range limit; a use older than this reads as not found.
   */
  readonly logLookbackBlocks?: bigint;
}

const KNOWN = ['client', 'chainId', 'timeoutMs', 'logLookbackBlocks'] as const;
const isNotFound = (e: unknown): boolean => e instanceof BaseError && e.walk((x) => x instanceof TransactionReceiptNotFoundError) !== null;

/** The ChainPort over viem: every call bounded by a deadline, reverts told apart from outages. */
export function viemChain(options: ViemChainOptions): ChainPort {
  onlyKnown(options, KNOWN);
  const { client } = options;
  if (typeof client?.getBlockNumber !== 'function') fail('client');
  if (!Number.isSafeInteger(options.chainId) || options.chainId <= 0) fail('chainId');
  const timeoutMs = positiveInt(options.timeoutMs, 10_000, 600_000, 'timeoutMs');
  const lookback = bigintAtLeast(options.logLookbackBlocks, 1n, 'logLookbackBlocks', 10_000n);

  const verifier = viemRpc(client);
  let checked: Promise<void> | undefined;
  const sameChain = (): Promise<void> => {
    checked ??= client.getChainId().then((id) => {
      if (id !== options.chainId) throw new AcceptError(E.CONFIG_INVALID, 'the RPC is on another chain than chainId');
    }).catch((error: unknown) => {
      if (!(error instanceof AcceptError)) checked = undefined; // an outage: check again next time
      throw error;
    });
    return checked;
  };
  const run = <T>(what: string, work: () => Promise<T>): Promise<T> =>
    withDeadline(sameChain().then(work), timeoutMs, what);
  const read = async <F extends 'authorizationState' | 'balanceOf'>(asset: string, functionName: F, args: readonly unknown[]) => {
    const data = encodeFunctionData({ abi: TOKEN_ABI, functionName, args } as never);
    const out = await client.call({ to: asset as Hex, data });
    return decodeFunctionResult({ abi: TOKEN_ABI, functionName, data: out.data ?? '0x' } as never) as unknown;
  };

  return {
    // The verifier's own adapter: a revert is RpcRevertError (an answer), anything else an outage.
    getCode: (address) => run('getCode', () => verifier.getCode(address)),
    call: (req) => run('call', () => verifier.call(req)),

    blockNumber: () => run('blockNumber', () => client.getBlockNumber({ cacheTime: 0 })),

    // Decoding yields the ABI type or throws (e.g. on empty return data), so the casts are exact.
    authorizationState: (asset, authorizer, nonce) => run('authorizationState', async () =>
      (await read(asset, 'authorizationState', [authorizer, nonce])) as boolean),

    balanceOf: (asset, owner) => run('balanceOf', async () => (await read(asset, 'balanceOf', [owner])) as bigint),

    simulateTransfer: (call: TransferCall) => run('simulateTransfer', async () => {
      try {
        await client.call({ to: call.asset as Hex, data: transferData(call) });
      } catch (error) {
        const reason = revertOf(error);
        if (reason !== undefined) throw new ChainRevertError(reason);
        throw error;
      }
    }),

    getReceipt: (txHash) => run('getReceipt', async (): Promise<TxReceipt | undefined> => {
      let r;
      try {
        r = await client.getTransactionReceipt({ hash: txHash });
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
      const logs: ChainLog[] = parseEventLogs({ abi: TOKEN_EVENTS, logs: r.logs, strict: true })
        .map((l) => ({ address: l.address, event: l.eventName, args: l.args as Readonly<Record<string, string | bigint>> }));
      return { txHash: r.transactionHash, status: r.status, blockNumber: r.blockNumber, logs };
    }),

    findAuthorizationUse: (asset, authorizer, nonce) => run('findAuthorizationUse', async () => {
      const head = await client.getBlockNumber({ cacheTime: 0 });
      const topics = encodeEventTopics({ abi: TOKEN_EVENTS, eventName: 'AuthorizationUsed', args: { authorizer: authorizer as Hex, nonce } });
      const found = await client.request({
        method: 'eth_getLogs',
        params: [{ address: asset as Hex, topics: topics as (Hex | null)[], fromBlock: numberToHex(head > lookback ? head - lookback : 0n), toBlock: numberToHex(head) }],
      });
      if (!Array.isArray(found)) throw new Error('eth_getLogs returned no list');
      const last = found[0] as { transactionHash?: unknown } | undefined; // a nonce is used at most once
      return typeof last?.transactionHash === 'string' ? (last.transactionHash as Hex) : undefined;
    }),
  };
}
