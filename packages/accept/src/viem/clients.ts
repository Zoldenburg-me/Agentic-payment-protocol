import type { Account, Chain, Hex, Log } from 'viem';

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
  request(args: { method: 'eth_getLogs'; params: [{ address: Hex; topics: (Hex | null)[]; fromBlock: Hex; toBlock: Hex }] }): Promise<unknown>;
}

/** What the submitter needs to estimate; usually the same public client. */
export interface EstimateClient {
  estimateGas(args: { account: Account; to: Hex; data: Hex }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
}

/** A viem wallet client with an account: pass `createWalletClient({ account, chain, transport })`. */
export interface SendClient {
  readonly account?: Account;
  readonly chain?: Chain;
  sendTransaction(args: {
    account: Account; chain: Chain | undefined; to: Hex; data: Hex; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint;
  }): Promise<Hex>;
}
