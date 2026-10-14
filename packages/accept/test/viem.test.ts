import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type Hex, decodeFunctionData, encodeAbiParameters, keccak256, numberToHex, pad, parseAbi, parseTransaction, toFunctionSelector,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { RpcRevertError } from 'agentpay-hub/protocol';
import { AcceptError, AcceptErrorCode as E, ChainRevertError, type TransferCall, viemChain, viemSubmitter } from '../src/index.js';
import { PAY_TO, USDC } from './helpers.js';
import { ScriptedRpc, block, hang, log, receipt, revertError, rpcError } from './scripted-rpc.js';

const CHAIN = 84532;
const PAYER = '0x00000000000000000000000000000000000000a1' as const;
const NONCE = `0x${'11'.repeat(32)}` as const;
const TX = `0x${'ab'.repeat(32)}` as const;
const SIG65 = `0x${'12'.repeat(32)}${'34'.repeat(32)}1b` as const;
const TOKEN_ABI = parseAbi([
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
]);

const call = (over: { signature?: Hex; asset?: string; to?: Hex } = {}): TransferCall => ({
  asset: over.asset ?? USDC,
  signature: over.signature ?? SIG65,
  authorization: {
    from: PAYER, to: over.to ?? PAY_TO, value: 10_000n, validAfter: 0n, validBefore: 2_000_000_000n, nonce: NONCE,
  },
});

const ethCalls = (rpc: ScriptedRpc) => rpc.of('eth_call').map((c) => c.params[0] as { to: string; data: Hex });
const bool = (b: boolean): Hex => encodeAbiParameters([{ type: 'bool' }], [b]);
const chainOf = (rpc: ScriptedRpc, over: Record<string, unknown> = {}) =>
  viemChain({ client: rpc.publicClient(), chainId: CHAIN, timeoutMs: 200, ...over });
const isConfig = (e: unknown) => e instanceof AcceptError && e.code === E.CONFIG_INVALID;

describe('viemChain', () => {
  it('refuses to read from an RPC on another chain', async () => {
    const rpc = new ScriptedRpc();
    rpc.chainId = 8453;
    const chain = chainOf(rpc);
    await assert.rejects(chain.blockNumber(), isConfig);
    await assert.rejects(chain.balanceOf(USDC, PAYER), isConfig);
    assert.equal(rpc.of('eth_call').length, 0);
  });

  it('checks the chain id once, and again after an outage; block numbers are never cached', async () => {
    const rpc = new ScriptedRpc();
    let down = true;
    rpc.on('eth_chainId', () => {
      if (down) throw rpcError('fetch failed');
      return numberToHex(CHAIN);
    });
    const chain = chainOf(rpc);
    await assert.rejects(chain.blockNumber(), (e: unknown) => !isConfig(e));
    down = false;
    assert.equal(await chain.blockNumber(), 1_000n);
    rpc.head = 1_001n;
    assert.equal(await chain.blockNumber(), 1_001n);
    assert.equal(rpc.of('eth_chainId').length, 2);
  });

  it('getCode: empty code reads as 0x', async () => {
    const rpc = new ScriptedRpc().on('eth_getCode', () => '0x');
    assert.equal(await chainOf(rpc).getCode(PAYER), '0x');
  });

  it('call: a revert is RpcRevertError, an outage is not; from and gas are passed through', async () => {
    const rpc = new ScriptedRpc().on('eth_call', () => { throw revertError('bad sig'); });
    const chain = chainOf(rpc);
    await assert.rejects(chain.call({ to: PAYER, data: '0x1626ba7e', gas: 300_000n, from: USDC }), RpcRevertError);
    const req = rpc.of('eth_call')[0]?.params[0] as { from: string; gas: Hex };
    assert.equal(req.from.toLowerCase(), USDC.toLowerCase());
    assert.equal(BigInt(req.gas), 300_000n);
    rpc.on('eth_call', () => { throw rpcError('fetch failed'); });
    await assert.rejects(chain.call({ to: PAYER, data: '0x1626ba7e' }), (e: unknown) => !(e instanceof RpcRevertError));
    const word = `0x1626ba7e${'0'.repeat(56)}` as const;
    rpc.on('eth_call', () => word);
    assert.equal(await chain.call({ to: PAYER, data: '0x1626ba7e' }), word);
  });

  it('authorizationState and balanceOf read the asset', async () => {
    const rpc = new ScriptedRpc().on('eth_call', ([req]) => {
      const { data } = req as { data: Hex };
      return data.startsWith(toFunctionSelector('authorizationState(address,bytes32)')) ? bool(true) : pad(numberToHex(42n));
    });
    const chain = chainOf(rpc);
    assert.equal(await chain.authorizationState(USDC, PAYER, NONCE), true);
    assert.equal(await chain.balanceOf(USDC, PAYER), 42n);
    assert.deepEqual(ethCalls(rpc).map((c) => c.to.toLowerCase()), [USDC.toLowerCase(), USDC.toLowerCase()]);
  });

  it('simulateTransfer: a 65-byte signature uses (v, r, s), anything longer the bytes overload', async () => {
    const rpc = new ScriptedRpc().on('eth_call', () => '0x');
    const chain = chainOf(rpc);
    await chain.simulateTransfer(call());
    await chain.simulateTransfer(call({ signature: `0x${'ee'.repeat(100)}` }));
    const [eoa, contract] = ethCalls(rpc);
    const a = decodeFunctionData({ abi: TOKEN_ABI, data: eoa?.data ?? '0x' });
    assert.equal(a.args.length, 9);
    assert.equal(a.args[6], 27);
    assert.equal(decodeFunctionData({ abi: TOKEN_ABI, data: contract?.data ?? '0x' }).args.length, 7);
  });

  it('simulateTransfer: a signature with v as 0/1 (y-parity) is sent as 27/28', async () => {
    const rpc = new ScriptedRpc().on('eth_call', () => '0x');
    await chainOf(rpc).simulateTransfer(call({ signature: `0x${'12'.repeat(32)}${'34'.repeat(32)}01` }));
    assert.equal(decodeFunctionData({ abi: TOKEN_ABI, data: ethCalls(rpc)[0]?.data ?? '0x' }).args[6], 28);
  });

  it('authorizationState and balanceOf fail (as an outage) on empty return data', async () => {
    const rpc = new ScriptedRpc().on('eth_call', () => '0x');
    const chain = chainOf(rpc);
    await assert.rejects(chain.authorizationState(USDC, PAYER, NONCE), (e: unknown) => !(e instanceof ChainRevertError));
    await assert.rejects(chain.balanceOf(USDC, PAYER), (e: unknown) => !(e instanceof ChainRevertError));
  });

  it('simulateTransfer: a revert is ChainRevertError with the reason; an outage is not', async () => {
    const rpc = new ScriptedRpc().on('eth_call', () => { throw revertError('FiatTokenV2: authorization is expired'); });
    const chain = chainOf(rpc);
    await assert.rejects(chain.simulateTransfer(call()), (e: unknown) => e instanceof ChainRevertError && /expired/.test(e.message));
    rpc.on('eth_call', () => { throw rpcError('fetch failed'); });
    await assert.rejects(chain.simulateTransfer(call()), (e: unknown) => !(e instanceof ChainRevertError));
  });

  it('getReceipt: none yet is undefined; logs are decoded with their address, unknown events dropped', async () => {
    const rpc = new ScriptedRpc().on('eth_getTransactionReceipt', () => null);
    const chain = chainOf(rpc);
    assert.equal(await chain.getReceipt(TX), undefined);
    rpc.on('eth_getTransactionReceipt', () => receipt(TX, 990n, 'success', [
      log(USDC, TX, 'AuthorizationUsed', { authorizer: PAYER, nonce: NONCE }),
      log(USDC, TX, 'Transfer', { from: PAYER, to: PAY_TO, value: 10_000n }),
      log(USDC, TX, 'Approval', { owner: PAYER, spender: PAY_TO, value: 1n }),
      log(PAYER, TX, 'Transfer', { from: PAYER, to: PAY_TO, value: 5n }),
    ]));
    const r = await chain.getReceipt(TX);
    assert.equal(r?.status, 'success');
    assert.equal(r?.blockNumber, 990n);
    assert.deepEqual(r?.logs.map((l) => [l.event, l.address.toLowerCase()]), [
      ['AuthorizationUsed', USDC.toLowerCase()], ['Transfer', USDC.toLowerCase()], ['Transfer', PAYER],
    ]);
    assert.equal(r?.logs[1]?.args.value, 10_000n);
    assert.equal(r?.logs[0]?.args.nonce, NONCE);
    rpc.on('eth_getTransactionReceipt', () => receipt(TX, 990n, 'reverted', []));
    assert.equal((await chain.getReceipt(TX))?.status, 'reverted');
  });

  it('findAuthorizationUse: filters by asset, authorizer and nonce over the lookback window', async () => {
    const rpc = new ScriptedRpc().on('eth_getLogs', () => [log(USDC, TX, 'AuthorizationUsed', { authorizer: PAYER, nonce: NONCE })]);
    rpc.head = 50_000n;
    const chain = chainOf(rpc, { logLookbackBlocks: 5_000n });
    assert.equal(await chain.findAuthorizationUse(USDC, PAYER, NONCE), TX);
    const filter = rpc.of('eth_getLogs')[0]?.params[0] as { address: string; topics: (Hex | null)[]; fromBlock: Hex };
    assert.equal(filter.address.toLowerCase(), USDC.toLowerCase());
    assert.equal(filter.topics[0], keccak256(new TextEncoder().encode('AuthorizationUsed(address,bytes32)')));
    assert.equal(filter.topics[1], pad(PAYER));
    assert.equal(filter.topics[2], NONCE);
    assert.equal(BigInt(filter.fromBlock), 45_000n);
    rpc.on('eth_getLogs', () => []);
    assert.equal(await chain.findAuthorizationUse(USDC, PAYER, NONCE), undefined);
  });

  it('findAuthorizationUse never asks for a block before genesis', async () => {
    const rpc = new ScriptedRpc().on('eth_getLogs', () => []);
    rpc.head = 10n;
    await chainOf(rpc).findAuthorizationUse(USDC, PAYER, NONCE);
    assert.equal(BigInt((rpc.of('eth_getLogs')[0]?.params[0] as { fromBlock: Hex }).fromBlock), 0n);
  });

  it('a call that hangs fails after timeoutMs as an outage, not a revert', async () => {
    const rpc = new ScriptedRpc().on('eth_call', hang);
    const started = Date.now();
    await assert.rejects(chainOf(rpc, { timeoutMs: 50 }).authorizationState(USDC, PAYER, NONCE),
      (e: unknown) => e instanceof Error && !(e instanceof ChainRevertError) && /timed out/.test(e.message));
    assert.ok(Date.now() - started < 1_000);
  });

  it('options are parsed strictly', () => {
    const rpc = new ScriptedRpc();
    const bad = (over: Record<string, unknown>) =>
      assert.throws(() => viemChain({ client: rpc.publicClient(), chainId: CHAIN, ...over } as never), isConfig);
    bad({ timeoutMs: 0 });
    bad({ logLookbackBlocks: 0n });
    bad({ logLookbackBlocks: 5 });
    bad({ chainId: 0 });
    bad({ surprise: true });
    bad({ client: undefined });
  });
});

describe('viemSubmitter', () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const submitterOf = (rpc: ScriptedRpc, over: Record<string, unknown> = {}) => viemSubmitter({
    wallet: rpc.walletClient(account), client: rpc.publicClient(), chainId: CHAIN, asset: USDC, payTo: PAY_TO,
    maxGas: 150_000n, maxFeePerGas: 100_000_000n, timeoutMs: 200, ...over,
  } as never);
  const sent = (rpc: ScriptedRpc) => rpc.of('eth_sendRawTransaction').map((c) => parseTransaction(c.params[0] as Hex));
  const estimating = (gas: bigint) => new ScriptedRpc().on('eth_estimateGas', () => numberToHex(gas));

  it('sends exactly the pinned call, under the gas and fee caps', async () => {
    const rpc = estimating(80_000n);
    assert.match(await submitterOf(rpc).submit(call()), /^0x[0-9a-f]{64}$/);
    const [tx] = sent(rpc);
    assert.equal(tx?.to?.toLowerCase(), USDC.toLowerCase());
    assert.equal(tx?.chainId, CHAIN);
    assert.equal(tx?.gas, 96_000n, 'estimate + 20%');
    assert.ok((tx?.maxFeePerGas ?? 0n) <= 100_000_000n);
    assert.ok((tx?.maxPriorityFeePerGas ?? 0n) <= (tx?.maxFeePerGas ?? 0n));
    const decoded = decodeFunctionData({ abi: TOKEN_ABI, data: tx?.data ?? '0x' });
    assert.equal(decoded.functionName, 'transferWithAuthorization');
    assert.equal(decoded.args[2], 10_000n);
  });

  it('the gas limit never exceeds maxGas', async () => {
    const rpc = estimating(140_000n);
    await submitterOf(rpc).submit(call());
    assert.equal(sent(rpc)[0]?.gas, 150_000n);
  });

  it('refuses, before any RPC, a call to another asset or payee', async () => {
    const rpc = estimating(80_000n);
    const s = submitterOf(rpc);
    await assert.rejects(s.submit(call({ asset: PAYER })), ChainRevertError);
    await assert.rejects(s.submit(call({ to: PAYER })), ChainRevertError);
    assert.equal(rpc.calls.length, 0);
  });

  it('a gas estimate above maxGas is refused before sending (a hostile contract wallet)', async () => {
    const rpc = estimating(2_000_000n);
    await assert.rejects(submitterOf(rpc).submit(call()), (e: unknown) => e instanceof ChainRevertError && /gas/.test(e.message));
    assert.equal(sent(rpc).length, 0);
  });

  it('a fee above maxFeePerGas is refused before sending, so no transaction is left stuck', async () => {
    const rpc = estimating(80_000n).on('eth_getBlockByNumber', () => block(1_000n, 1_000_000_000n));
    await assert.rejects(submitterOf(rpc).submit(call()), (e: unknown) => e instanceof ChainRevertError && /fee/.test(e.message));
    assert.equal(sent(rpc).length, 0);
  });

  it('an estimate that reverts is ChainRevertError (nothing sent); an outage is not', async () => {
    const rpc = new ScriptedRpc().on('eth_estimateGas', () => { throw revertError(); });
    const s = submitterOf(rpc);
    await assert.rejects(s.submit(call()), ChainRevertError);
    rpc.on('eth_estimateGas', () => { throw rpcError('fetch failed'); });
    await assert.rejects(s.submit(call()), (e: unknown) => !(e instanceof ChainRevertError));
    assert.equal(sent(rpc).length, 0);
  });

  it('a send that fails or hangs is an unknown outcome, never a revert', async () => {
    const rpc = estimating(80_000n).on('eth_sendRawTransaction', () => { throw rpcError('nonce too low'); });
    const s = submitterOf(rpc);
    await assert.rejects(s.submit(call()), (e: unknown) => !(e instanceof ChainRevertError));
    rpc.on('eth_sendRawTransaction', hang);
    await assert.rejects(s.submit(call()), (e: unknown) => !(e instanceof ChainRevertError) && /timed out/.test(String(e)));
  });

  it('concurrent submits for different authorizations go out one at a time, each with its own nonce', async () => {
    const rpc = estimating(80_000n);
    const s = submitterOf(rpc);
    const withNonce = (n: number): TransferCall => ({ ...call(), authorization: { ...call().authorization, nonce: pad(numberToHex(n), { size: 32 }) } });
    await Promise.all([s.submit(withNonce(1)), s.submit(withNonce(2)), s.submit(withNonce(3))]);
    assert.deepEqual(sent(rpc).map((t) => t.nonce), [0, 1, 2]);
  });

  it('one failed submit does not block the next', async () => {
    const rpc = new ScriptedRpc().on('eth_estimateGas', () => { throw revertError(); });
    const s = submitterOf(rpc);
    await assert.rejects(s.submit(call()), ChainRevertError);
    rpc.on('eth_estimateGas', () => numberToHex(80_000n));
    assert.match(await s.submit(call()), /^0x/);
  });

  it('options are parsed strictly: a wallet on another chain, missing caps, unknown keys', () => {
    const rpc = new ScriptedRpc();
    const bad = (over: Record<string, unknown>) => assert.throws(() => submitterOf(rpc, over), isConfig);
    bad({ chainId: 8453 });
    bad({ maxGas: undefined });
    bad({ maxGas: 10_000n });
    bad({ maxFeePerGas: 0n });
    bad({ maxFeePerGas: 1 });
    bad({ payTo: 'nope' });
    bad({ asset: '0x0000000000000000000000000000000000000000' });
    bad({ surprise: 1 });
    bad({ wallet: rpc.publicClient() });
  });
});

describe('viemSubmitter: one transaction per authorization, whatever the timing', () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const submitterOf = (rpc: ScriptedRpc, over: Record<string, unknown> = {}) => viemSubmitter({
    wallet: rpc.walletClient(account), client: rpc.publicClient(), chainId: CHAIN, asset: USDC, payTo: PAY_TO,
    maxGas: 150_000n, maxFeePerGas: 100_000_000n, timeoutMs: 100, ...over,
  } as never);
  const raws = (rpc: ScriptedRpc) => rpc.of('eth_sendRawTransaction').map((c) => c.params[0] as Hex);
  const nth = (n: number, validBefore = 2_000_000_000n): TransferCall => {
    const c = call();
    return { ...c, authorization: { ...c.authorization, nonce: pad(numberToHex(n), { size: 32 }), validBefore } };
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** A node that accepts a raw transaction only after `ms`: a broadcast that outlives the submit deadline. */
  const slowNode = (ms: number) => {
    const rpc = new ScriptedRpc().on('eth_estimateGas', () => numberToHex(80_000n));
    const done: boolean[] = [];
    rpc.on('eth_sendRawTransaction', (params) => new Promise((resolve) => setTimeout(() => {
      rpc.nonce += 1;
      done.push(true);
      resolve(keccak256(params[0] as Hex));
    }, ms)));
    return { rpc, done };
  };

  it('the returned hash is the hash of the signed transaction', async () => {
    const rpc = new ScriptedRpc().on('eth_estimateGas', () => numberToHex(80_000n));
    const hash = await submitterOf(rpc).submit(call());
    assert.equal(hash, keccak256(raws(rpc)[0] ?? '0x'));
  });

  it('a retry while a timed-out send is still going waits for it, and never signs a second transaction', async () => {
    const { rpc } = slowNode(250);
    const s = submitterOf(rpc);
    await assert.rejects(s.submit(call()), /timed out/);
    const again = await s.submit(call()).catch(() => s.submit(call()));
    assert.equal(new Set(raws(rpc)).size, 1, 'one signed transaction, however often it is broadcast');
    assert.equal(again, keccak256(raws(rpc)[0] ?? '0x'));
  });

  it('a retry after a failed broadcast rebroadcasts the same signed transaction', async () => {
    const rpc = new ScriptedRpc().on('eth_estimateGas', () => numberToHex(80_000n));
    rpc.on('eth_sendRawTransaction', () => { throw rpcError('fetch failed'); });
    const s = submitterOf(rpc);
    await assert.rejects(s.submit(call()), (e: unknown) => !(e instanceof ChainRevertError));
    rpc.on('eth_sendRawTransaction', (params) => keccak256(params[0] as Hex));
    const hash = await s.submit(call());
    const [first, second] = raws(rpc);
    assert.equal(first, second);
    assert.equal(hash, keccak256(first ?? '0x'));
    assert.equal(rpc.of('eth_estimateGas').length, 1, 'nothing re-estimated or re-signed');
  });

  it('the next payment does not start until a timed-out send has really finished', async () => {
    const { rpc, done } = slowNode(250);
    const short = submitterOf(rpc);
    let startedWhileSending = false;
    rpc.on('eth_estimateGas', () => {
      if (rpc.of('eth_sendRawTransaction').length > done.length) startedWhileSending = true;
      return numberToHex(80_000n);
    });
    await assert.rejects(short.submit(nth(1)), /timed out/);
    await short.submit(nth(2)).catch(() => undefined);
    await wait(400);
    await short.submit(nth(3)).catch(() => undefined);
    await wait(400);
    assert.equal(startedWhileSending, false);
    assert.deepEqual(rpc.of('eth_sendRawTransaction').map((c) => parseTransaction(c.params[0] as Hex).nonce), [0, 1]);
  });

  it('a queued submit whose deadline passes before it starts is refused before sending', async () => {
    const rpc = new ScriptedRpc().on('eth_estimateGas', () => numberToHex(80_000n)).on('eth_sendRawTransaction', hang);
    const s = submitterOf(rpc);
    const first = assert.rejects(s.submit(nth(1)), /timed out/);
    await assert.rejects(s.submit(nth(2)), (e: unknown) => e instanceof ChainRevertError && /busy/.test(e.message));
    await first;
    assert.equal(rpc.of('eth_estimateGas').length, 1);
  });

  it('the nonce never goes backwards when the RPC pending count lags', async () => {
    const rpc = new ScriptedRpc().on('eth_estimateGas', () => numberToHex(80_000n)).on('eth_getTransactionCount', () => numberToHex(0));
    const s = submitterOf(rpc);
    await s.submit(nth(1));
    await s.submit(nth(2));
    assert.deepEqual(raws(rpc).map((r) => parseTransaction(r).nonce), [0, 1]);
  });

  it('an expired authorization is forgotten: it is never rebroadcast', async () => {
    const rpc = new ScriptedRpc().on('eth_estimateGas', () => numberToHex(80_000n));
    rpc.on('eth_sendRawTransaction', () => { throw rpcError('fetch failed'); });
    const s = submitterOf(rpc);
    await assert.rejects(s.submit(nth(1, 1n)));
    await assert.rejects(s.submit(nth(1, 1n)));
    assert.equal(rpc.of('eth_estimateGas').length, 2, 'signed afresh, not replayed');
  });

  it('refuses to estimate on a client for another chain, and sends nothing', async () => {
    const rpc = new ScriptedRpc().on('eth_estimateGas', () => numberToHex(80_000n));
    const other = new ScriptedRpc();
    other.chainId = 8453;
    const s = submitterOf(rpc, { client: other.publicClient() });
    await assert.rejects(s.submit(call()), isConfig);
    assert.equal(raws(rpc).length, 0);
  });

  it('options are parsed strictly: the wallet needs a local account', () => {
    const rpc = new ScriptedRpc();
    const jsonRpc = { ...rpc.walletClient(account), account: { address: account.address, type: 'json-rpc' } };
    assert.throws(() => submitterOf(rpc, { wallet: jsonRpc }), isConfig);
  });
});

describe('viemChain: reading the newest block', () => {
  it('findAuthorizationUse searches up to the latest block, not a head read earlier', async () => {
    const rpc = new ScriptedRpc().on('eth_getLogs', () => []);
    await chainOf(rpc).findAuthorizationUse(USDC, PAYER, NONCE);
    assert.equal((rpc.of('eth_getLogs')[0]?.params[0] as { toBlock: string }).toBlock, 'latest');
  });
});

describe('viemSubmitter.replaceStuck: re-pricing a transaction that waits too long', () => {
  const account = privateKeyToAccount(generatePrivateKey());
  /** A node that accepts every broadcast but mines only what the test says. Base fee 10 gwei-ish units; tip 1e6. */
  const node = () => {
    const rpc = new ScriptedRpc().on('eth_estimateGas', () => numberToHex(80_000n));
    const state = { mined: 0, pending: 0, known: new Set<Hex>() };
    rpc.on('eth_getTransactionCount', (p) => numberToHex(p[1] === 'latest' ? state.mined : state.pending));
    rpc.on('eth_getTransactionByHash', (p) => (state.known.has(p[0] as Hex) ? { hash: p[0] } : null));
    rpc.on('eth_sendRawTransaction', (p) => {
      state.pending = Math.max(state.pending, (parseTransaction(p[0] as Hex).nonce ?? 0) + 1);
      state.known.add(keccak256(p[0] as Hex));
      return keccak256(p[0] as Hex);
    });
    return { rpc, state };
  };
  const setupBump = (over: Record<string, unknown> = {}) => {
    const { rpc, state } = node();
    let t = 1_000_000;
    const s = viemSubmitter({
      wallet: rpc.walletClient(account), client: rpc.publicClient(), chainId: CHAIN, asset: USDC, payTo: PAY_TO,
      maxGas: 150_000n, maxFeePerGas: 100_000_000n, timeoutMs: 200, replaceAfterMs: 60_000, now: () => t, ...over,
    } as never);
    return { rpc, state, s, advance: (ms: number) => { t += ms; } };
  };
  const txs = (rpc: ScriptedRpc) => rpc.of('eth_sendRawTransaction').map((c) => parseTransaction(c.params[0] as Hex));
  /** The network now asks more than the transaction offers: base fee 10 000 000 -> `base`. */
  const feesRise = (rpc: ScriptedRpc, base = 11_000_000n) => rpc.on('eth_getBlockByNumber', () => block(1_000n, base));
  const withValidBefore = (n: number, validBefore: bigint): TransferCall => {
    const c = nthCall(n);
    return { ...c, authorization: { ...c.authorization, validBefore } };
  };

  it('leaves a transaction alone until it has waited replaceAfterMs', async () => {
    const { rpc, s, advance } = setupBump();
    await s.submit(call());
    feesRise(rpc);
    advance(59_000);
    assert.deepEqual(await s.replaceStuck?.(), { replaced: 0, unreplaced: 0 });
    assert.equal(txs(rpc).length, 1);
  });

  it('a transaction still priced at market is rebroadcast as it is, never bumped', async () => {
    const { rpc, s, advance } = setupBump();
    await s.submit(call());
    advance(60_000);
    assert.deepEqual(await s.replaceStuck?.(), { replaced: 0, unreplaced: 0 });
    const [first, second] = rpc.of('eth_sendRawTransaction').map((c) => c.params[0]);
    assert.equal(second, first);
  });

  it('re-signs the same nonce, data and gas at least 12.5% dearer, and a retry sends the replacement', async () => {
    const { rpc, s, advance } = setupBump();
    const first = await s.submit(call());
    feesRise(rpc);
    advance(60_000);
    assert.deepEqual(await s.replaceStuck?.(), { replaced: 1, unreplaced: 0 });
    const [old, bumped] = txs(rpc);
    assert.equal(bumped?.nonce, old?.nonce);
    assert.equal(bumped?.data, old?.data);
    assert.equal(bumped?.gas, old?.gas);
    assert.equal(bumped?.to, old?.to);
    assert.ok((bumped?.maxFeePerGas ?? 0n) * 8n >= (old?.maxFeePerGas ?? 0n) * 9n);
    assert.ok((bumped?.maxPriorityFeePerGas ?? 0n) * 8n >= (old?.maxPriorityFeePerGas ?? 0n) * 9n);
    const again = await s.submit(call());
    assert.notEqual(again, first);
    assert.equal(again, keccak256(rpc.of('eth_sendRawTransaction')[1]?.params[0] as Hex));
    assert.equal(rpc.of('eth_sendRawTransaction')[2]?.params[0], rpc.of('eth_sendRawTransaction')[1]?.params[0]);
  });

  it('takes the current fee when the network asks more than the 12.5% bump', async () => {
    const { rpc, s, advance } = setupBump();
    await s.submit(call());
    feesRise(rpc, 50_000_000n);
    advance(60_000);
    await s.replaceStuck?.();
    const [old, bumped] = txs(rpc);
    assert.ok((bumped?.maxFeePerGas ?? 0n) > ((old?.maxFeePerGas ?? 0n) * 9n) / 8n + 1n);
  });

  it('a zero tip is still raised, so a node takes the replacement', async () => {
    const { rpc, s, advance } = setupBump();
    rpc.on('eth_maxPriorityFeePerGas', () => '0x0');
    await s.submit(call());
    feesRise(rpc);
    advance(60_000);
    await s.replaceStuck?.();
    const [old, bumped] = txs(rpc);
    assert.equal(old?.maxPriorityFeePerGas ?? 0n, 0n, 'viem leaves a zero field undefined');
    assert.ok((bumped?.maxPriorityFeePerGas ?? 0n) > 0n);
  });

  it('at the cap: clamps to maxFeePerGas while that is still a 10% bump', async () => {
    const { rpc, s, advance } = setupBump({ maxFeePerGas: 15_000_000n });
    await s.submit(call());
    feesRise(rpc, 30_000_000n);
    advance(60_000);
    assert.deepEqual(await s.replaceStuck?.(), { replaced: 1, unreplaced: 0 });
    assert.equal(txs(rpc)[1]?.maxFeePerGas, 15_000_000n);
  });

  it('never re-prices above maxFeePerGas: below a 10% bump it is left as it is and counted', async () => {
    const { rpc, s, advance } = setupBump({ maxFeePerGas: 14_000_000n });
    await s.submit(call());
    feesRise(rpc, 30_000_000n);
    advance(60_000);
    const out = await s.replaceStuck?.();
    assert.equal(out?.replaced, 0);
    assert.equal(out?.unreplaced, 1);
    assert.equal(txs(rpc).length, 1);
  });

  it('a replacement the node refuses is counted with its cause, and the next pass tries again', async () => {
    const { rpc, s, advance } = setupBump();
    await s.submit(call());
    feesRise(rpc);
    rpc.on('eth_sendRawTransaction', () => { throw rpcError('replacement transaction underpriced'); });
    advance(60_000);
    const out = await s.replaceStuck?.();
    assert.equal(out?.unreplaced, 1);
    assert.match(String((out?.cause as Error | undefined)?.message), /underpriced/);
    rpc.on('eth_sendRawTransaction', (p) => keccak256(p[0] as Hex));
    assert.deepEqual(await s.replaceStuck?.(), { replaced: 1, unreplaced: 0 });
  });

  it('"already known" means the node has the replacement: it counts as replaced', async () => {
    const { rpc, s, advance } = setupBump();
    await s.submit(call());
    feesRise(rpc);
    rpc.on('eth_sendRawTransaction', () => { throw rpcError('already known'); });
    advance(60_000);
    assert.deepEqual(await s.replaceStuck?.(), { replaced: 1, unreplaced: 0 });
  });

  it('"nonce too low" means the nonce is spent: the entry is forgotten and a retry signs afresh', async () => {
    const { rpc, s, advance } = setupBump();
    await s.submit(call());
    feesRise(rpc);
    rpc.on('eth_sendRawTransaction', () => { throw rpcError('nonce too low'); });
    advance(60_000);
    assert.deepEqual(await s.replaceStuck?.(), { replaced: 0, unreplaced: 0 });
    rpc.on('eth_sendRawTransaction', (p) => keccak256(p[0] as Hex));
    await s.submit(call());
    assert.equal(rpc.of('eth_estimateGas').length, 2);
  });

  it('forgets a transaction whose nonce is mined, so a retry signs afresh instead of resending it', async () => {
    const { rpc, state, s, advance } = setupBump();
    await s.submit(call());
    state.mined = 1;
    advance(60_000);
    assert.deepEqual(await s.replaceStuck?.(), { replaced: 0, unreplaced: 0 });
    assert.equal(txs(rpc).length, 1);
    await s.submit(call());
    assert.equal(rpc.of('eth_estimateGas').length, 2);
  });

  it('never sends a transaction whose own broadcast failed, even after another payment took its nonce', async () => {
    const { rpc, state, s, advance } = setupBump();
    rpc.on('eth_sendRawTransaction', () => { throw rpcError('fetch failed'); });
    await assert.rejects(s.submit(nthCall(1)));
    const failed = rpc.of('eth_sendRawTransaction')[0]?.params[0] as Hex;
    rpc.on('eth_sendRawTransaction', (p) => {
      state.pending = Math.max(state.pending, (parseTransaction(p[0] as Hex).nonce ?? 0) + 1);
      return keccak256(p[0] as Hex);
    });
    await s.submit(nthCall(2));
    feesRise(rpc);
    advance(60_000);
    assert.deepEqual(await s.replaceStuck?.(), { replaced: 1, unreplaced: 0 });
    const dataOf = (raw: Hex) => parseTransaction(raw).data;
    const sentFailed = rpc.of('eth_sendRawTransaction').filter((c) => dataOf(c.params[0] as Hex) === dataOf(failed));
    assert.equal(sentFailed.length, 1, 'only its own failed attempt');
    await s.submit(nthCall(1));
    assert.equal(txs(rpc).at(-1)?.nonce, 1, 'its nonce went to another payment: signed afresh on the next one');
  });

  it('a broadcast the node took despite a transport error is never signed a second time', async () => {
    const { rpc, state, s } = setupBump();
    rpc.on('eth_sendRawTransaction', (p) => {
      state.pending = Math.max(state.pending, (parseTransaction(p[0] as Hex).nonce ?? 0) + 1);
      state.known.add(keccak256(p[0] as Hex));
      throw rpcError('fetch failed');
    });
    await assert.rejects(s.submit(nthCall(1)));
    const first = rpc.of('eth_sendRawTransaction')[0]?.params[0] as Hex;
    rpc.on('eth_sendRawTransaction', (p) => {
      state.pending = Math.max(state.pending, (parseTransaction(p[0] as Hex).nonce ?? 0) + 1);
      state.known.add(keccak256(p[0] as Hex));
      return keccak256(p[0] as Hex);
    });
    await s.submit(nthCall(2)); // takes the next nonce, past the first
    assert.equal(await s.submit(nthCall(1)), keccak256(first));
    assert.equal(rpc.of('eth_estimateGas').length, 2, 'payment 1 was not signed again');
  });

  it('a retried broadcast waits a full replaceAfterMs from its acceptance before any bump', async () => {
    const { rpc, s, advance } = setupBump();
    rpc.on('eth_sendRawTransaction', () => { throw rpcError('fetch failed'); });
    await assert.rejects(s.submit(call()));
    advance(60_000);
    rpc.on('eth_sendRawTransaction', (p) => keccak256(p[0] as Hex));
    await s.submit(call()); // accepted only now
    feesRise(rpc);
    assert.deepEqual(await s.replaceStuck?.(), { replaced: 0, unreplaced: 0 });
    advance(60_000);
    assert.deepEqual(await s.replaceStuck?.(), { replaced: 1, unreplaced: 0 });
  });

  it('never sends a transaction whose own broadcast failed, even when nothing else took its nonce', async () => {
    const { rpc, s, advance } = setupBump();
    rpc.on('eth_sendRawTransaction', () => { throw rpcError('fetch failed'); });
    await assert.rejects(s.submit(call()));
    rpc.on('eth_sendRawTransaction', (p) => keccak256(p[0] as Hex));
    feesRise(rpc);
    advance(60_000);
    assert.deepEqual(await s.replaceStuck?.(), { replaced: 0, unreplaced: 0 });
    assert.equal(txs(rpc).length, 1, 'only its own failed attempt');
  });

  it('a submit the node answers "already known" for has gone out: it returns the hash', async () => {
    const { rpc, s } = setupBump();
    rpc.on('eth_sendRawTransaction', () => { throw rpcError('already known'); });
    assert.equal(await s.submit(call()), keccak256(rpc.of('eth_sendRawTransaction')[0]?.params[0] as Hex));
  });

  it('an expired authorization is re-priced only when a later transaction waits behind its nonce', async () => {
    const { rpc, s, advance } = setupBump();
    await s.submit(withValidBefore(1, 1_500n));
    feesRise(rpc);
    advance(600_000);
    assert.deepEqual(await s.replaceStuck?.(), { replaced: 0, unreplaced: 0 });
    assert.equal(txs(rpc).length, 1, 'nothing waits behind it: not bumped');
    await s.submit(nthCall(2)); // signed at today's fees: it is at market, so only rebroadcast
    advance(60_000);
    assert.deepEqual(await s.replaceStuck?.(), { replaced: 1, unreplaced: 0 });
    const atNonce0 = txs(rpc).filter((t) => (t.nonce ?? 0) === 0);
    assert.equal(atNonce0.length, 2, 'the expired one was re-priced, since nonce 1 waits behind it');
    assert.ok((atNonce0[1]?.maxFeePerGas ?? 0n) > (atNonce0[0]?.maxFeePerGas ?? 0n));
  });

  it('one pass reads fees once, and a failure on one transaction does not stop the others', async () => {
    const { rpc, s, advance } = setupBump();
    await s.submit(nthCall(1));
    await s.submit(nthCall(2));
    feesRise(rpc);
    advance(60_000);
    let broadcasts = 0;
    rpc.on('eth_sendRawTransaction', (p) => {
      broadcasts += 1;
      if (broadcasts === 1) throw rpcError('fetch failed');
      return keccak256(p[0] as Hex);
    });
    const tips = rpc.of('eth_maxPriorityFeePerGas').length;
    const out = await s.replaceStuck?.();
    assert.equal(out?.replaced, 1);
    assert.equal(out?.unreplaced, 1);
    assert.equal(rpc.of('eth_maxPriorityFeePerGas').length, tips + 1);
  });

  it('a pass stops at its time budget; the rest wait for the next pass', async () => {
    const { rpc, s, advance } = setupBump({ timeoutMs: 1_000 });
    await s.submit(nthCall(1));
    await s.submit(nthCall(2));
    feesRise(rpc);
    advance(60_000);
    rpc.on('eth_sendRawTransaction', (p) => { advance(1_001); return keccak256(p[0] as Hex); });
    const out = await s.replaceStuck?.();
    assert.equal(out?.replaced, 1);
    assert.equal(out?.unreplaced, 1);
  });

  it('concurrent calls share one pass', async () => {
    const { rpc, s, advance } = setupBump();
    await s.submit(call());
    advance(60_000);
    await Promise.all([s.replaceStuck?.(), s.replaceStuck?.()]);
    assert.equal(rpc.of('eth_getTransactionCount').filter((c) => c.params[1] === 'latest').length, 1);
  });

  it('runs in the submit queue: never at the same time as a send', async () => {
    const { rpc, s, advance } = setupBump();
    await s.submit(nthCall(1));
    feesRise(rpc);
    advance(60_000);
    let overlapping = false;
    let sending = 0;
    rpc.on('eth_sendRawTransaction', async (p) => {
      sending += 1;
      if (sending > 1) overlapping = true;
      await new Promise((r) => setTimeout(r, 20));
      sending -= 1;
      return keccak256(p[0] as Hex);
    });
    await Promise.all([s.replaceStuck?.(), s.submit(nthCall(2))]);
    assert.equal(overlapping, false);
  });

  it('options are parsed strictly: replaceAfterMs and now', () => {
    const bad = (over: Record<string, unknown>) => assert.throws(() => setupBump(over), isConfig);
    bad({ replaceAfterMs: 0 });
    bad({ replaceAfterMs: 1.5 });
    bad({ now: 'soon' });
  });
});

function nthCall(n: number): TransferCall {
  const c = call();
  return { ...c, authorization: { ...c.authorization, nonce: pad(numberToHex(n), { size: 32 }) } };
}
