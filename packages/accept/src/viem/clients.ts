import type { Chain, Hex, LocalAccount, Log } from 'viem';

/**
 * The viem public-client methods the ports use, described structurally so a client for any chain
 * (with its own formatters, e.g. Base's) fits without casts. Pass `createPublicClient(...)`.
 */
export interface ReadClient {
  getChainId(): Promise<number>;
  getCode(args: { address: Hex }): Promise<Hex | undefined>;
  call(args: { to: Hex; data: Hex; gas?: bigint; account?: Hex }): Promise<{ data?: Hex }>;
  getBlockNumber(args?: { cacheTime?: number }): Promise<bigint>;
  getTransactionReceipt(args: { hash: Hex }): Promise<{
    transactionHash: Hex; status: 'success' | 'reverted'; blockNumber: bigint; logs: Log[];
  }>;
  request(args: { method: 'eth_getLogs'; params: [{ address: Hex; topics: (Hex | null)[]; fromBlock: Hex; toBlock: 'latest' }] }): Promise<unknown>;
}

/** What the submitter needs to estimate; usually the same public client. */
export interface EstimateClient {
  getChainId(): Promise<number>;
  getTransactionCount(args: { address: Hex; blockTag: 'pending' }): Promise<number>;
  estimateGas(args: { account: LocalAccount; to: Hex; data: Hex }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
}

/**
 * A viem wallet client with a local account (`privateKeyToAccount`): pass
 * `createWalletClient({ account, chain, transport })`. Transactions are signed here, so a hash is
 * known before it is broadcast and a retry can resend the very same transaction.
 */
export interface SendClient {
  readonly account?: { readonly type: string } | LocalAccount;
  readonly chain?: Chain;
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex>;
}
