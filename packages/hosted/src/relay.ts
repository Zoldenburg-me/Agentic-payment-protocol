import { AcceptError, AcceptErrorCode as E } from '@zold/accept';

export interface NonceClient {
  getTransactionCount(args: { address: `0x${string}`; blockTag: 'pending' | 'latest' }): Promise<number>;
}

/**
 * viemSubmitter keeps its sent transactions in memory, so after a restart it cannot re-price ones an
 * earlier run left pending, and an underpriced one would hold the nonce for every merchant. Before serving,
 * wait for the relay to have nothing pending; if it still does after `timeoutMs`, refuse to start, so the
 * operator replaces or cancels those nonces instead of the hub silently queueing payments behind them.
 */
export async function waitForIdleRelay(
  client: NonceClient, address: `0x${string}`,
  options: { readonly timeoutMs: number; readonly pollMs: number; readonly sleep?: (ms: number) => Promise<void>; readonly now?: () => number },
): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  for (;;) {
    const [pending, latest] = await Promise.all([
      client.getTransactionCount({ address, blockTag: 'pending' }),
      client.getTransactionCount({ address, blockTag: 'latest' }),
    ]);
    if (pending <= latest) return;
    if (now() >= deadline) {
      throw new AcceptError(E.CONFIG_INVALID, `the relay has ${pending - latest} transaction(s) pending from an earlier run (nonces ${latest} to ${pending - 1}): replace or cancel them, then start again`);
    }
    await sleep(options.pollMs);
  }
}
