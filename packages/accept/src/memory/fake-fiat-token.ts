import { randomBytes } from 'node:crypto';
import { type Hex, recoverTypedDataAddress } from 'viem';
import { type Eip712Domain, TRANSFER_WITH_AUTHORIZATION_TYPES } from 'agentpay-hub/protocol';
import { type ChainLog, type ChainPort, ChainRevertError, type Submitter, type TransferCall, type TxReceipt } from '../ports.js';

export interface FakeFiatTokenOptions {
  readonly chainId: number;
  readonly asset: string;
  readonly domain: Eip712Domain;
  readonly nowSec: () => number;
  /** Mine each submission at once (default true). */
  readonly autoMine?: boolean;
  /** Each blockNumber() read mines a block, so time passes while a caller polls (default: autoMine). */
  readonly advanceOnPoll?: boolean;
}

interface Tx {
  readonly hash: Hex;
  readonly call: TransferCall;
  readonly forceRevert: boolean;
}

interface Block {
  readonly number: bigint;
  readonly txs: readonly { readonly tx: Tx; readonly success: boolean }[];
}

const newHash = (): Hex => `0x${randomBytes(32).toString('hex')}`;
const key = (from: string, nonce: string): string => `${from.toLowerCase()}|${nonce.toLowerCase()}`;

/**
 * An in-memory USDC (FiatToken v2.2) for tests and local development: real EIP-712 signature
 * checks, FiatToken revert reasons, AuthorizationUsed + Transfer logs, blocks, reorgs and
 * hooks to front-run, revert or fail. It implements both the chain reads and the submitter.
 */
export class FakeFiatToken implements ChainPort, Submitter {
  rpcCalls = 0;
  failRpc = false;
  /** Only receipt reads fail (a flaky receipt endpoint behind a working one). */
  failReceipts = false;
  failNextSimulation: string | undefined;
  /** true: fail before anything is sent; 'after-broadcast': the transaction is out, then the call fails. */
  failNextSubmitTransport: boolean | 'after-broadcast' = false;
  /** A third party submits the authorization between our pre-check and our simulation. */
  frontRunBeforeSimulate = false;
  /** findAuthorizationUse misses (a lagging log index), though the nonce is used. */
  hideAuthorizationUseLogs = false;
  /** The next submit reverts before broadcast with this reason (e.g. the balance moved since the simulation). */
  failNextSubmitRevert: string | undefined;
  private simulationPause: { readonly reached: () => void; readonly gate: Promise<void> } | undefined;
  frontRunNextSubmit = false;
  revertNextSubmitOnChain: false | 'front-run' | 'plain' = false;
  /** Corrupt the logs of the next mined transfers (to exercise the Transfer measurement). */
  tamperLogs: false | 'value' | 'to' | 'drop-used' | 'extra-transfer' | 'bundled' = false;
  readonly submissions: Hex[] = [];
  readonly externalTxs: Hex[] = [];

  private readonly balances = new Map<string, bigint>();
  private readonly used = new Map<string, Hex | 'cancelled'>();
  private readonly receipts = new Map<Hex, TxReceipt>();
  private readonly blocks: Block[] = [];
  private pending: Tx[] = [];
  private head = 100n;
  private readonly waiters: Array<{ readonly n: number; readonly resolve: () => void }> = [];
  private readonly autoMine: boolean;
  private readonly advanceOnPoll: boolean;

  constructor(private readonly options: FakeFiatTokenOptions) {
    this.autoMine = options.autoMine ?? true;
    this.advanceOnPoll = options.advanceOnPoll ?? this.autoMine;
  }

  // ---- test controls ------------------------------------------------------

  mint(owner: string, amount: bigint): void {
    this.balances.set(owner.toLowerCase(), this.balanceOfSync(owner) + amount);
  }

  burn(owner: string): void {
    this.balances.set(owner.toLowerCase(), 0n);
  }

  balanceOfSync(owner: string): bigint {
    return this.balances.get(owner.toLowerCase()) ?? 0n;
  }

  cancelAuthorization(authorizer: string, nonce: string): void {
    this.used.set(key(authorizer, nonce), 'cancelled');
  }

  /** A third party (e.g. a front-runner) submits the buyer's authorization; mined in its own block now. */
  externalSubmit(call: TransferCall): Hex {
    this.checkSync(call);
    const tx: Tx = { hash: newHash(), call, forceRevert: false };
    this.externalTxs.push(tx.hash);
    this.mineBlock([tx]);
    return tx.hash;
  }

  /** The mempool forgets our pending transactions (dropped, replaced, underpriced): they never mine. */
  dropPending(): void {
    this.pending = [];
  }

  mine(blocks = 1): void {
    for (let i = 0; i < blocks; i++) this.mineBlock(this.pending.splice(0));
  }

  /** Drops the last `depth` blocks, undoing their effects; `remine` puts their transactions back in the mempool. */
  reorg(depth: number, opts: { readonly remine: boolean }): void {
    const dropped: Tx[] = [];
    for (let i = 0; i < depth; i++) {
      const block = this.blocks.pop();
      if (!block) break;
      this.head -= 1n;
      for (const { tx, success } of [...block.txs].reverse()) {
        if (success) this.undo(tx);
        this.receipts.delete(tx.hash);
        dropped.unshift(tx);
      }
    }
    if (opts.remine) this.pending = [...dropped, ...this.pending];
  }

  /** Holds the next simulation open until `release()`; `reached` resolves once it is waiting. */
  pauseNextSimulation(): { readonly reached: Promise<void>; readonly release: () => void } {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const reachedP = new Promise<void>((r) => { reached = r; });
    this.simulationPause = { reached, gate };
    return { reached: reachedP, release };
  }

  untilSubmitted(n: number): Promise<void> {
    if (this.submissions.length >= n) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ n, resolve }));
  }

  // ---- ChainPort ------------------------------------------------------------

  async getCode(): Promise<Hex> {
    this.rpc();
    return '0x';
  }

  async call(): Promise<Hex> {
    this.rpc();
    throw new Error('the fake chain has no contracts to call');
  }

  async blockNumber(): Promise<bigint> {
    this.rpc();
    if (this.advanceOnPoll) this.mine(1);
    return this.head;
  }

  async authorizationState(_asset: string, authorizer: string, nonce: Hex): Promise<boolean> {
    this.rpc();
    return this.used.has(key(authorizer, nonce));
  }

  async balanceOf(_asset: string, owner: string): Promise<bigint> {
    this.rpc();
    return this.balanceOfSync(owner);
  }

  async simulateTransfer(call: TransferCall): Promise<void> {
    this.rpc();
    const pause = this.simulationPause;
    if (pause) {
      this.simulationPause = undefined;
      pause.reached();
      await pause.gate;
    }
    if (this.frontRunBeforeSimulate) {
      this.frontRunBeforeSimulate = false;
      this.externalSubmit(call);
    }
    const reason = this.failNextSimulation;
    if (reason !== undefined) {
      this.failNextSimulation = undefined;
      throw new ChainRevertError(reason);
    }
    await this.check(call);
  }

  async getReceipt(txHash: Hex): Promise<TxReceipt | undefined> {
    this.rpc();
    if (this.failReceipts) throw new Error('receipt unavailable');
    return this.receipts.get(txHash);
  }

  async findAuthorizationUse(_asset: string, authorizer: string, nonce: Hex): Promise<Hex | undefined> {
    this.rpc();
    const use = this.used.get(key(authorizer, nonce));
    return use === 'cancelled' || this.hideAuthorizationUseLogs ? undefined : use;
  }

  // ---- Submitter --------------------------------------------------------------

  async submit(call: TransferCall): Promise<Hex> {
    this.rpc();
    const transportFailure = this.failNextSubmitTransport;
    this.failNextSubmitTransport = false;
    if (transportFailure === true) throw new Error('ECONNRESET');
    const revert = this.failNextSubmitRevert;
    this.failNextSubmitRevert = undefined;
    if (revert !== undefined) throw new ChainRevertError(revert);
    if (this.frontRunNextSubmit) {
      this.frontRunNextSubmit = false;
      this.externalSubmit(call);
    }
    await this.check(call);
    const tx: Tx = { hash: newHash(), call, forceRevert: this.revertNextSubmitOnChain === 'plain' };
    if (this.revertNextSubmitOnChain === 'front-run') this.externalSubmit(call);
    this.revertNextSubmitOnChain = false;
    this.submissions.push(tx.hash);
    this.pending.push(tx);
    if (this.autoMine) this.mine(1);
    for (const w of this.waiters.filter((x) => this.submissions.length >= x.n)) w.resolve();
    if (transportFailure === 'after-broadcast') throw new Error('ECONNRESET after broadcast');
    return tx.hash;
  }

  // ---- internals ------------------------------------------------------------

  private rpc(): void {
    this.rpcCalls += 1;
    if (this.failRpc) throw new Error('rpc unavailable');
  }

  /** FiatToken order: contract, validAfter, validBefore, nonce state, then (async) signature, then balance. */
  private checkSync(call: TransferCall, { balance = true } = {}): void {
    const a = call.authorization;
    const now = BigInt(this.options.nowSec());
    if (call.asset.toLowerCase() !== this.options.asset.toLowerCase()) throw new ChainRevertError('wrong token contract');
    if (now <= a.validAfter) throw new ChainRevertError('FiatTokenV2: authorization is not yet valid');
    if (now >= a.validBefore) throw new ChainRevertError('FiatTokenV2: authorization is expired');
    if (this.used.has(key(a.from, a.nonce))) throw new ChainRevertError('FiatTokenV2: authorization is used or canceled');
    if (balance && this.balanceOfSync(a.from) < a.value) throw new ChainRevertError('ERC20: transfer amount exceeds balance');
  }

  private async check(call: TransferCall): Promise<void> {
    this.checkSync(call, { balance: false });
    const signer = await recoverTypedDataAddress({
      domain: { ...this.options.domain, verifyingContract: this.options.domain.verifyingContract as Hex },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization',
      message: call.authorization, signature: call.signature,
    }).catch(() => undefined);
    if (signer?.toLowerCase() !== call.authorization.from.toLowerCase()) throw new ChainRevertError('FiatTokenV2: invalid signature');
    this.checkSync(call);
  }

  private mineBlock(txs: readonly Tx[]): void {
    this.head += 1n;
    const number = this.head;
    this.blocks.push({ number, txs: txs.map((tx) => ({ tx, success: this.apply(tx, number) })) });
  }

  private apply(tx: Tx, blockNumber: bigint): boolean {
    let success = !tx.forceRevert;
    if (success) {
      try {
        this.checkSync(tx.call);
      } catch {
        success = false;
      }
    }
    const a = tx.call.authorization;
    if (success) {
      this.balances.set(a.from.toLowerCase(), this.balanceOfSync(a.from) - a.value);
      this.balances.set(a.to.toLowerCase(), this.balanceOfSync(a.to) + a.value);
      this.used.set(key(a.from, a.nonce), tx.hash);
    }
    const logs: ChainLog[] = success ? this.logsFor(a) : [];
    this.receipts.set(tx.hash, { txHash: tx.hash, status: success ? 'success' : 'reverted', blockNumber, logs });
    return success;
  }

  private logsFor(a: TransferCall['authorization']): ChainLog[] {
    const asset = this.options.asset;
    const mode = this.tamperLogs;
    const used: ChainLog = { address: asset, event: 'AuthorizationUsed', args: { authorizer: a.from, nonce: a.nonce } };
    const transfer: ChainLog = {
      address: asset, event: 'Transfer',
      args: { from: a.from, to: mode === 'to' ? a.from : a.to, value: mode === 'value' ? a.value - 1n : a.value },
    };
    if (mode === 'drop-used') return [transfer];
    if (mode === 'extra-transfer') return [used, transfer, transfer];
    if (mode === 'bundled') {
      // A front-runner's transaction that also moves some other funds of the payer elsewhere.
      return [used, transfer, { address: asset, event: 'Transfer', args: { from: a.from, to: `0x${'0b'.repeat(20)}`, value: 1n } }];
    }
    return [used, transfer];
  }

  private undo(tx: Tx): void {
    const a = tx.call.authorization;
    this.balances.set(a.from.toLowerCase(), this.balanceOfSync(a.from) + a.value);
    this.balances.set(a.to.toLowerCase(), this.balanceOfSync(a.to) - a.value);
    this.used.delete(key(a.from, a.nonce));
  }
}
