import { AcceptError, AcceptErrorCode as E } from '@zold/accept';

export interface NonceClient {
  getTransactionCount(args: { address: `0x${string}`; blockTag: 'pending' | 'latest' }): Promise<number>;
}

/** A wallet client with the relay's local account: pass `createWalletClient({ account, chain, transport })`. */
export interface CancelWallet {
  sendTransaction(args: {
    to: `0x${string}`; value: bigint; nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint;
  }): Promise<`0x${string}`>;
}

export interface CancelOptions {
  readonly wallet: CancelWallet;
  /** How long pending nonces may clear by themselves before they are replaced. */
  readonly afterMs: number;
  /** Fee and tip of each replacement: above anything the submitter can have offered, so a node takes it. */
  readonly maxFeePerGas: bigint;
}

const TRANSFER_GAS = 21_000n;

/**
 * viemSubmitter keeps its sent transactions in memory, so after a restart it cannot re-price ones an
 * earlier run left pending, and an underpriced one would hold the nonce for every merchant. Before serving,
 * wait for the relay to have nothing pending. With `cancel`, nonces still pending after `cancel.afterMs`
 * are each replaced once by a zero-value self-transfer: only one transaction can fill a nonce, so this never
 * pays twice. A cancelled settlement is not resent: its row keeps judging the old hash and expires after
 * validBefore, so the payer is never charged and the merchant is not paid.
 * If the relay is still not idle after `timeoutMs`, refuse to start rather than queue payments behind it.
 */
export async function waitForIdleRelay(
  client: NonceClient, address: `0x${string}`,
  options: {
    readonly timeoutMs: number; readonly pollMs: number; readonly cancel?: CancelOptions;
    readonly sleep?: (ms: number) => Promise<void>; readonly now?: () => number;
  },
): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const started = now();
  const deadline = started + options.timeoutMs;
  const replaced = new Set<number>();
  let failure: unknown;
  for (;;) {
    const [pending, latest] = await Promise.all([
      client.getTransactionCount({ address, blockTag: 'pending' }),
      client.getTransactionCount({ address, blockTag: 'latest' }),
    ]);
    if (pending <= latest) return;
    if (now() >= deadline) {
      const what = `the relay has ${pending - latest} transaction(s) pending from an earlier run (nonces ${latest} to ${pending - 1})`;
      let unreplaced = false;
      for (let nonce = latest; nonce < pending; nonce += 1) unreplaced ||= !replaced.has(nonce);
      // A failure explains the refusal only while some pending nonce never got its replacement out.
      if (unreplaced && failure !== undefined) throw new AcceptError(E.CONFIG_INVALID, `${what} that could not be replaced (see cause): replace or cancel them, then start again`, { cause: failure });
      throw new AcceptError(E.CONFIG_INVALID, `${what}: replace or cancel them, then start again`);
    }
    const cancel = options.cancel;
    if (cancel && now() - started >= cancel.afterMs) {
      for (let nonce = latest; nonce < pending; nonce += 1) {
        if (replaced.has(nonce)) continue;
        try {
          await cancel.wallet.sendTransaction({
            to: address, value: 0n, nonce, gas: TRANSFER_GAS, maxFeePerGas: cancel.maxFeePerGas, maxPriorityFeePerGas: cancel.maxFeePerGas,
          });
          replaced.add(nonce);
        } catch (error) {
          failure = error; // tried again next poll; still pending at the deadline refuses to start
        }
      }
    }
    await sleep(options.pollMs);
  }
}
