import { type Hex, createPublicClient, createWalletClient, custom, encodeAbiParameters, encodeEventTopics, numberToHex, parseAbi } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

export const EVENTS = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
]);

export interface RpcCall {
  readonly method: string;
  readonly params: readonly unknown[];
}

type Handler = (params: readonly unknown[]) => unknown;

/** A JSON-RPC error the way nodes send one (code 3 = execution reverted). */
export const rpcError = (message: string, code = -32603): Error => Object.assign(new Error(message), { code });
export const revertError = (reason = 'FiatTokenV2: authorization is used or canceled'): Error =>
  rpcError(`execution reverted: ${reason}`, 3);

/** An EIP-1193 provider that answers from scripted handlers and records every request. */
export class ScriptedRpc {
  readonly calls: RpcCall[] = [];
  private readonly handlers = new Map<string, Handler>();
  head = 1_000n;
  nonce = 0;
  chainId: number = baseSepolia.id;

  constructor() {
    this.on('eth_chainId', () => numberToHex(this.chainId));
    this.on('eth_blockNumber', () => numberToHex(this.head));
    this.on('eth_getTransactionCount', () => numberToHex(this.nonce));
    this.on('eth_maxPriorityFeePerGas', () => numberToHex(1_000_000n));
    this.on('eth_getBlockByNumber', () => block(this.head, 10_000_000n));
    this.on('eth_sendRawTransaction', () => {
      this.nonce += 1;
      return `0x${this.nonce.toString(16).padStart(64, 'a')}`;
    });
  }

  on(method: string, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  of(method: string): RpcCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  readonly request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    const list = (Array.isArray(params) ? params : []) as readonly unknown[];
    this.calls.push({ method, params: list });
    const handler = this.handlers.get(method);
    if (!handler) throw rpcError(`unscripted ${method}`);
    return handler(list);
  };

  publicClient() {
    return createPublicClient({ chain: baseSepolia, transport: custom({ request: this.request }, { retryCount: 0 }) });
  }

  walletClient(account: PrivateKeyAccount) {
    return createWalletClient({ account, chain: baseSepolia, transport: custom({ request: this.request }, { retryCount: 0 }) });
  }
}

export const hang = (): Promise<never> => new Promise(() => undefined);

export function block(number: bigint, baseFeePerGas: bigint) {
  const zero32 = `0x${'0'.repeat(64)}`;
  return {
    number: numberToHex(number), hash: `0x${'b'.repeat(64)}`, parentHash: `0x${'c'.repeat(64)}`, timestamp: '0x6553f100',
    baseFeePerGas: numberToHex(baseFeePerGas), gasLimit: '0x1c9c380', gasUsed: '0x0', miner: `0x${'0'.repeat(40)}`,
    nonce: '0x0000000000000000', difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', logsBloom: `0x${'0'.repeat(512)}`,
    receiptsRoot: zero32, sha3Uncles: zero32, size: '0x0', stateRoot: zero32, transactionsRoot: zero32,
    transactions: [], uncles: [], mixHash: zero32,
  };
}

export function log(address: string, txHash: Hex, event: 'Transfer' | 'AuthorizationUsed' | 'Approval', args: Record<string, unknown>) {
  const topics = encodeEventTopics({ abi: EVENTS, eventName: event, args: args as never });
  const data = event === 'AuthorizationUsed' ? '0x' : encodeAbiParameters([{ type: 'uint256' }], [args.value as bigint]);
  return {
    address, topics, data, blockNumber: '0x3e8', blockHash: `0x${'b'.repeat(64)}`, transactionHash: txHash,
    transactionIndex: '0x0', logIndex: '0x0', removed: false,
  };
}

export function receipt(txHash: Hex, blockNumber: bigint, status: 'success' | 'reverted', logs: unknown[]) {
  return {
    transactionHash: txHash, blockNumber: numberToHex(blockNumber), blockHash: `0x${'b'.repeat(64)}`, status: status === 'success' ? '0x1' : '0x0',
    logs, contractAddress: null, cumulativeGasUsed: '0x1', effectiveGasPrice: '0x1', from: `0x${'1'.repeat(40)}`, gasUsed: '0x1',
    logsBloom: `0x${'0'.repeat(512)}`, to: `0x${'2'.repeat(40)}`, transactionIndex: '0x0', type: '0x2',
  };
}
