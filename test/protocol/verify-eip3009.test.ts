import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BaseError, ExecutionRevertedError, type Hex, domainSeparator, encodeFunctionResult, parseAbi, toFunctionSelector,
} from 'viem';
import {
  DEFAULT_MIN_REMAINING_S, ERC1271_GAS_CAP, ERC1271_MAGIC, RpcRevertError, resolveDomain, verifyEip3009, viemRpc,
} from '../../src/protocol/verify-eip3009.js';
import { ProtocolErrorCode as E } from '../../src/protocol/errors.js';
import { DOMAIN, NOW, PAY_TO, USDC_SEPOLIA, fakeRpc, pinned, signedClaim, toHighS } from './fixtures.js';

const SAFE_CODE = '0x6080604052' as Hex;
const magicWord = `${ERC1271_MAGIC}${'0'.repeat(56)}` as Hex;

describe('verifyEip3009: accepts', () => {
  it('a valid EOA authorization signed over the pinned domain', async () => {
    const { account, claim } = await signedClaim();
    const result = await verifyEip3009(claim, pinned(), NOW, fakeRpc());
    assert.deepEqual(result, {
      ok: true, payer: account.address, nonce: `0x${'11'.repeat(32)}`,
      value: 10_000n, validAfter: BigInt(NOW - 600), validBefore: BigInt(NOW + 60),
    });
  });

  it('asset and payTo compared case-insensitively', async () => {
    const { claim } = await signedClaim();
    const result = await verifyEip3009(
      { ...claim, asset: USDC_SEPOLIA.toLowerCase() }, pinned({ payTo: PAY_TO.toLowerCase() }), NOW, fakeRpc(),
    );
    assert.equal(result.ok, true);
  });

  it('a window of exactly maxWindowS', async () => {
    const { claim } = await signedClaim({ validBefore: BigInt(NOW + 300) });
    assert.equal((await verifyEip3009(claim, pinned(), NOW, fakeRpc())).ok, true);
  });
});

describe('verifyEip3009: domain is pinned, never taken from the payer', () => {
  for (const [label, domain] of [
    ['name', { ...DOMAIN, name: 'Fake' }],
    ['version', { ...DOMAIN, version: '1' }],
    ['chainId', { ...DOMAIN, chainId: 8453 }],
    ['verifyingContract', { ...DOMAIN, verifyingContract: '0x0000000000000000000000000000000000000001' }],
  ] as const) {
    it(`refuses a signature over a spoofed ${label}`, async () => {
      const { claim } = await signedClaim({}, domain);
      const spoofed = { ...claim, extra: { name: domain.name, version: domain.version } };
      assert.deepEqual(await verifyEip3009(spoofed, pinned(), NOW, fakeRpc()), { ok: false, code: E.BAD_SIGNATURE });
    });
  }
});

describe('verifyEip3009: offer binding', () => {
  it('refuses a claim for another chain', async () => {
    const { claim } = await signedClaim();
    assert.deepEqual(await verifyEip3009({ ...claim, chainId: 8453 }, pinned(), NOW, fakeRpc()), { ok: false, code: E.CHAIN_MISMATCH });
  });

  it('refuses a claim for another asset', async () => {
    const { claim } = await signedClaim();
    const other = { ...claim, asset: '0x0000000000000000000000000000000000000002' };
    assert.deepEqual(await verifyEip3009(other, pinned(), NOW, fakeRpc()), { ok: false, code: E.ASSET_MISMATCH });
  });

  it('refuses a transfer to anyone but the pinned payTo', async () => {
    const { claim } = await signedClaim({ to: '0x0000000000000000000000000000000000000003' });
    assert.deepEqual(await verifyEip3009(claim, pinned(), NOW, fakeRpc()), { ok: false, code: E.PAYTO_MISMATCH });
  });

  it('refuses an underpayment by one atomic unit', async () => {
    const { claim } = await signedClaim({ value: 9_999n });
    assert.deepEqual(await verifyEip3009(claim, pinned(), NOW, fakeRpc()), { ok: false, code: E.UNDERPAID });
  });

  it('refuses an overpayment (exact means exact)', async () => {
    const { claim } = await signedClaim({ value: 10_001n });
    assert.deepEqual(await verifyEip3009(claim, pinned(), NOW, fakeRpc()), { ok: false, code: E.AMOUNT_MISMATCH });
  });
});

describe('verifyEip3009: validity window', () => {
  it('refuses an authorization that is not yet valid', async () => {
    const { claim } = await signedClaim({ validAfter: BigInt(NOW + 1) });
    assert.deepEqual(await verifyEip3009(claim, pinned(), NOW, fakeRpc()), { ok: false, code: E.NOT_YET_VALID });
  });

  it('refuses an authorization that expires now', async () => {
    const { claim } = await signedClaim({ validBefore: BigInt(NOW) });
    assert.deepEqual(await verifyEip3009(claim, pinned(), NOW, fakeRpc()), { ok: false, code: E.EXPIRED });
  });

  it('refuses a window longer than maxWindowS', async () => {
    const { claim } = await signedClaim({ validBefore: BigInt(NOW + 301) });
    assert.deepEqual(await verifyEip3009(claim, pinned(), NOW, fakeRpc()), { ok: false, code: E.WINDOW_TOO_LONG });
  });
});

describe('verifyEip3009: signature form', () => {
  it('refuses the high-s twin of a valid signature', async () => {
    const { claim } = await signedClaim();
    const malleable = { ...claim, signature: toHighS(claim.signature as Hex) };
    assert.deepEqual(await verifyEip3009(malleable, pinned(), NOW, fakeRpc()), { ok: false, code: E.HIGH_S });
  });

  it('refuses a v that is neither 27 nor 28', async () => {
    const { claim } = await signedClaim();
    const badV = { ...claim, signature: `${claim.signature.slice(0, 130)}1d` };
    assert.deepEqual(await verifyEip3009(badV, pinned(), NOW, fakeRpc()), { ok: false, code: E.MALFORMED });
  });

  it('refuses a contract-style signature from a payer with no code', async () => {
    const { claim } = await signedClaim();
    const safeSig = { ...claim, signature: `0x${'ab'.repeat(97)}` };
    const rpc = fakeRpc();
    assert.deepEqual(await verifyEip3009(safeSig, pinned(), NOW, rpc), { ok: false, code: E.PAYER_NO_CODE });
    assert.equal(rpc.calls.length, 0);
  });

  const malformed: ReadonlyArray<[string, (c: Awaited<ReturnType<typeof signedClaim>>['claim']) => unknown]> = [
    ['null claim', () => null],
    ['missing authorization', (c) => ({ ...c, authorization: undefined })],
    ['non-hex signature', (c) => ({ ...c, signature: 'zz' })],
    ['from not an address', (c) => ({ ...c, authorization: { ...c.authorization, from: '0x123' } })],
    ['value not decimal', (c) => ({ ...c, authorization: { ...c.authorization, value: '0x10' } })],
    ['negative validAfter', (c) => ({ ...c, authorization: { ...c.authorization, validAfter: '-1' } })],
    ['nonce too short', (c) => ({ ...c, authorization: { ...c.authorization, nonce: '0x11' } })],
    ['chainId not an integer', (c) => ({ ...c, chainId: '84532' })],
  ];
  for (const [label, mutate] of malformed) {
    it(`refuses a malformed claim: ${label}`, async () => {
      const { claim } = await signedClaim();
      assert.deepEqual(await verifyEip3009(mutate(claim), pinned(), NOW, fakeRpc()), { ok: false, code: E.MALFORMED });
    });
  }
});

describe('verifyEip3009: contract payers (ERC-1271)', () => {
  it('accepts when isValidSignature returns the magic value, with a gas cap', async () => {
    const { account, claim } = await signedClaim();
    const rpc = fakeRpc({ code: { [account.address.toLowerCase()]: SAFE_CODE }, call: async () => magicWord });
    const contractSig = { ...claim, signature: `0x${'ab'.repeat(97)}` };
    const result = await verifyEip3009(contractSig, pinned(), NOW, rpc);
    assert.equal(result.ok, true);
    assert.equal(rpc.calls.length, 1);
    assert.equal(rpc.calls[0]?.to, account.address);
    assert.equal(rpc.calls[0]?.gas, ERC1271_GAS_CAP);
    assert.ok(rpc.calls[0]?.data.startsWith(ERC1271_MAGIC));
  });

  it('uses ERC-1271 only, even for a valid ECDSA signature, when the payer has code', async () => {
    const { account, claim } = await signedClaim();
    const rpc = fakeRpc({ code: { [account.address.toLowerCase()]: SAFE_CODE }, call: async () => '0xffffffff' });
    assert.deepEqual(await verifyEip3009(claim, pinned(), NOW, rpc), { ok: false, code: E.BAD_SIGNATURE });
  });

  it('refuses when isValidSignature returns anything else', async () => {
    const { account, claim } = await signedClaim();
    const rpc = fakeRpc({ code: { [account.address.toLowerCase()]: SAFE_CODE }, call: async () => '0x' });
    assert.deepEqual(await verifyEip3009(claim, pinned(), NOW, rpc), { ok: false, code: E.BAD_SIGNATURE });
  });

  it('fails closed when eth_call errors', async () => {
    const { account, claim } = await signedClaim();
    const rpc = fakeRpc({ code: { [account.address.toLowerCase()]: SAFE_CODE }, call: async () => { throw new Error('timeout'); } });
    assert.deepEqual(await verifyEip3009(claim, pinned(), NOW, rpc), { ok: false, code: E.RPC_UNAVAILABLE });
  });

  it('fails closed when the code lookup errors', async () => {
    const { claim } = await signedClaim();
    assert.deepEqual(await verifyEip3009(claim, pinned(), NOW, fakeRpc({ failGetCode: true })), { ok: false, code: E.RPC_UNAVAILABLE });
  });
});

describe('verifyEip3009: pinned config is strict', () => {
  const cases: ReadonlyArray<[string, Parameters<typeof pinned>[0]]> = [
    ['maxWindowS above 300', { maxWindowS: 301 }],
    ['maxWindowS zero', { maxWindowS: 0 }],
    ['domain chainId differs from chainId', { domain: { ...DOMAIN, chainId: 1 } }],
    ['domain verifyingContract differs from asset', { domain: { ...DOMAIN, verifyingContract: PAY_TO } }],
    ['zero amount', { amount: 0n }],
  ];
  for (const [label, over] of cases) {
    it(`throws CONFIG_INVALID for ${label}`, async () => {
      const { claim } = await signedClaim();
      await assert.rejects(verifyEip3009(claim, pinned(over), NOW, fakeRpc()), { code: E.CONFIG_INVALID });
    });
  }
});

describe('resolveDomain', () => {
  const abi = parseAbi([
    'function eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])',
    'function name() view returns (string)',
    'function version() view returns (string)',
    'function DOMAIN_SEPARATOR() view returns (bytes32)',
  ]);
  const sel = (sig: string) => toFunctionSelector(sig);
  const fiatTokenRpc = (separator: Hex) => fakeRpc({
    call: async ({ data }) => {
      if (data.startsWith(sel('eip712Domain()'))) throw new RpcRevertError();
      if (data.startsWith(sel('name()'))) return encodeFunctionResult({ abi, functionName: 'name', result: 'USDC' });
      if (data.startsWith(sel('version()'))) return encodeFunctionResult({ abi, functionName: 'version', result: '2' });
      if (data.startsWith(sel('DOMAIN_SEPARATOR()'))) return encodeFunctionResult({ abi, functionName: 'DOMAIN_SEPARATOR', result: separator });
      throw new Error('unknown selector');
    },
  });
  const realSeparator = domainSeparator({ domain: DOMAIN as { name: string; version: string; chainId: number; verifyingContract: Hex } });

  it('returns the pinned domain without touching the RPC', async () => {
    const rpc = fakeRpc();
    const domain = await resolveDomain({ chainId: 84532, asset: USDC_SEPOLIA, pinned: { name: 'USDC', version: '2' } }, rpc);
    assert.deepEqual(domain, DOMAIN);
    assert.equal(rpc.calls.length, 0);
  });

  it('falls back to name()/version() for FiatToken (no EIP-5267) and checks DOMAIN_SEPARATOR', async () => {
    assert.deepEqual(await resolveDomain({ chainId: 84532, asset: USDC_SEPOLIA }, fiatTokenRpc(realSeparator)), DOMAIN);
  });

  it('refuses when the on-chain DOMAIN_SEPARATOR does not match', async () => {
    await assert.rejects(
      resolveDomain({ chainId: 84532, asset: USDC_SEPOLIA }, fiatTokenRpc(`0x${'00'.repeat(32)}`)),
      { code: E.DOMAIN_MISMATCH },
    );
  });

  it('uses eip712Domain() when present and checks chainId and contract', async () => {
    const rpc5267 = (chainId: bigint) => fakeRpc({
      call: async () => encodeFunctionResult({
        abi, functionName: 'eip712Domain',
        result: ['0x0f', 'USDC', '2', chainId, USDC_SEPOLIA, `0x${'00'.repeat(32)}`, []],
      }),
    });
    assert.deepEqual(await resolveDomain({ chainId: 84532, asset: USDC_SEPOLIA }, rpc5267(84532n)), DOMAIN);
    await assert.rejects(resolveDomain({ chainId: 84532, asset: USDC_SEPOLIA }, rpc5267(1n)), { code: E.DOMAIN_MISMATCH });
  });

  it('fails closed when the RPC is down', async () => {
    const rpc = fakeRpc({ call: async () => { throw new Error('down'); } });
    await assert.rejects(resolveDomain({ chainId: 84532, asset: USDC_SEPOLIA }, rpc), { code: E.RPC_UNAVAILABLE });
  });
});

describe('viemRpc', () => {
  it('maps getCode and call onto a viem client, passing the gas cap through', async () => {
    const seen: unknown[] = [];
    const rpc = viemRpc({
      getCode: async (a: { address: Hex }) => { seen.push(a); return undefined; },
      call: async (r: { to: Hex; data: Hex; gas?: bigint }) => { seen.push(r); return { data: '0x01' as Hex }; },
    });
    assert.equal(await rpc.getCode(PAY_TO), '0x');
    assert.equal(await rpc.call({ to: PAY_TO, data: '0xabcd', gas: 5n }), '0x01');
    assert.deepEqual(seen, [{ address: PAY_TO }, { to: PAY_TO, data: '0xabcd', gas: 5n }]);
  });
});

describe('verifyEip3009: review hardening', () => {
  it('refuses validAfter == now (FiatToken requires now > validAfter)', async () => {
    const { claim } = await signedClaim({ validAfter: BigInt(NOW) });
    assert.deepEqual(await verifyEip3009(claim, pinned(), NOW, fakeRpc()), { ok: false, code: E.NOT_YET_VALID });
  });

  it('refuses an authorization with less than minRemainingS left', async () => {
    const { claim } = await signedClaim({ validBefore: BigInt(NOW + 29) });
    assert.deepEqual(await verifyEip3009(claim, pinned({ minRemainingS: 30 }), NOW, fakeRpc()), { ok: false, code: E.EXPIRES_TOO_SOON });
    const { claim: ok } = await signedClaim({ validBefore: BigInt(NOW + 30) });
    assert.equal((await verifyEip3009(ok, pinned({ minRemainingS: 30 }), NOW, fakeRpc())).ok, true);
  });

  it('defaults minRemainingS to DEFAULT_MIN_REMAINING_S', async () => {
    const { claim } = await signedClaim({ validBefore: BigInt(NOW + DEFAULT_MIN_REMAINING_S - 1) });
    assert.deepEqual(await verifyEip3009(claim, pinned(), NOW, fakeRpc()), { ok: false, code: E.EXPIRES_TOO_SOON });
  });

  it('enforces the challenge-bound nonce when expectedNonce is pinned', async () => {
    const { claim } = await signedClaim({ nonce: `0x${'ab'.repeat(32)}` });
    assert.deepEqual(
      await verifyEip3009(claim, pinned({ expectedNonce: `0x${'11'.repeat(32)}` }), NOW, fakeRpc()),
      { ok: false, code: E.NONCE_MISMATCH },
    );
    assert.equal((await verifyEip3009(claim, pinned({ expectedNonce: `0x${'AB'.repeat(32)}` }), NOW, fakeRpc())).ok, true);
  });

  it('refuses uint256 overflow as malformed instead of throwing', async () => {
    const { claim } = await signedClaim();
    const huge = (2n ** 256n).toString();
    const over = { ...claim, authorization: { ...claim.authorization, value: huge } };
    assert.deepEqual(await verifyEip3009(over, pinned(), NOW, fakeRpc()), { ok: false, code: E.MALFORMED });
  });

  it('refuses a short (e.g. EIP-2098 64-byte) signature from an EOA as malformed', async () => {
    const { claim } = await signedClaim();
    const short = { ...claim, signature: claim.signature.slice(0, 130) };
    assert.deepEqual(await verifyEip3009(short, pinned(), NOW, fakeRpc()), { ok: false, code: E.MALFORMED });
  });

  it('refuses an EIP-7702-delegated payer', async () => {
    const { account, claim } = await signedClaim();
    const rpc = fakeRpc({ code: { [account.address.toLowerCase()]: `0xef0100${'ab'.repeat(20)}` }, call: async () => magicWord });
    assert.deepEqual(await verifyEip3009(claim, pinned(), NOW, rpc), { ok: false, code: E.PAYER_DELEGATED });
    assert.equal(rpc.calls.length, 0);
  });

  it('fails closed on malformed getCode output', async () => {
    const { account, claim } = await signedClaim();
    const rpc = fakeRpc({ code: { [account.address.toLowerCase()]: '0xabc' as Hex }, call: async () => magicWord });
    assert.deepEqual(await verifyEip3009(claim, pinned(), NOW, rpc), { ok: false, code: E.RPC_UNAVAILABLE });
  });

  it('calls isValidSignature as the token (msg.sender = asset), like settlement does', async () => {
    const { account, claim } = await signedClaim();
    const rpc = fakeRpc({ code: { [account.address.toLowerCase()]: SAFE_CODE }, call: async () => magicWord });
    await verifyEip3009(claim, pinned(), NOW, rpc);
    assert.equal(rpc.calls[0]?.from, USDC_SEPOLIA);
  });

  for (const [label, over] of [
    ['minRemainingS >= maxWindowS', { minRemainingS: 300 }],
    ['negative minRemainingS', { minRemainingS: -1 }],
    ['malformed expectedNonce', { expectedNonce: '0x11' }],
  ] as const) {
    it(`throws CONFIG_INVALID for ${label}`, async () => {
      const { claim } = await signedClaim();
      await assert.rejects(verifyEip3009(claim, pinned(over), NOW, fakeRpc()), { code: E.CONFIG_INVALID });
    });
  }

  it('viemRpc passes the caller as account only when given', async () => {
    const seen: unknown[] = [];
    const rpc = viemRpc({
      getCode: async () => '0x',
      call: async (r: { to: Hex; data: Hex; gas?: bigint; account?: Hex }) => { seen.push(r); return { data: '0x01' as Hex }; },
    });
    await rpc.call({ to: PAY_TO, data: '0xabcd', from: USDC_SEPOLIA });
    assert.deepEqual(seen, [{ to: PAY_TO, data: '0xabcd', account: USDC_SEPOLIA }]);
  });
});

const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const withS = (signature: string, s: bigint) =>
  `${signature.slice(0, 66)}${s.toString(16).padStart(64, '0')}${signature.slice(130)}`;

describe('verifyEip3009: round-2 boundaries', () => {
  it('s == n/2 passes the low-s check (then fails recovery); s == n/2 + 1 is HIGH_S', async () => {
    const { claim } = await signedClaim();
    assert.deepEqual(await verifyEip3009({ ...claim, signature: withS(claim.signature, HALF_N) }, pinned(), NOW, fakeRpc()), { ok: false, code: E.BAD_SIGNATURE });
    assert.deepEqual(await verifyEip3009({ ...claim, signature: withS(claim.signature, HALF_N + 1n) }, pinned(), NOW, fakeRpc()), { ok: false, code: E.HIGH_S });
  });

  for (const v of ['00', '01']) {
    it(`refuses v = 0x${v} as malformed`, async () => {
      const { claim } = await signedClaim();
      assert.deepEqual(await verifyEip3009({ ...claim, signature: `${claim.signature.slice(0, 130)}${v}` }, pinned(), NOW, fakeRpc()), { ok: false, code: E.MALFORMED });
    });
  }

  it('a 66-byte signature from a payer with no code is PAYER_NO_CODE', async () => {
    const { claim } = await signedClaim();
    assert.deepEqual(await verifyEip3009({ ...claim, signature: `${claim.signature}00` }, pinned(), NOW, fakeRpc()), { ok: false, code: E.PAYER_NO_CODE });
  });

  it('accepts validAfter = now - 1', async () => {
    const { claim } = await signedClaim({ validAfter: BigInt(NOW - 1) });
    assert.equal((await verifyEip3009(claim, pinned(), NOW, fakeRpc())).ok, true);
  });

  it('refuses an upper-case delegation designator too', async () => {
    const { account, claim } = await signedClaim();
    const rpc = fakeRpc({ code: { [account.address.toLowerCase()]: `0xEF0100${'AB'.repeat(20)}` as Hex } });
    assert.deepEqual(await verifyEip3009(claim, pinned(), NOW, rpc), { ok: false, code: E.PAYER_DELEGATED });
  });

  for (const [label, result] of [['the bare selector', ERC1271_MAGIC], ['the magic word with a non-zero tail', `${ERC1271_MAGIC}${'0'.repeat(55)}1`]] as const) {
    it(`refuses an ERC-1271 return of ${label}`, async () => {
      const { account, claim } = await signedClaim();
      const rpc = fakeRpc({ code: { [account.address.toLowerCase()]: SAFE_CODE }, call: async () => result as Hex });
      assert.deepEqual(await verifyEip3009(claim, pinned(), NOW, rpc), { ok: false, code: E.BAD_SIGNATURE });
    });
  }

  it('an ERC-1271 revert is a bad signature, not an RPC outage', async () => {
    const { account, claim } = await signedClaim();
    const rpc = fakeRpc({ code: { [account.address.toLowerCase()]: SAFE_CODE }, call: async () => { throw new RpcRevertError(); } });
    assert.deepEqual(await verifyEip3009(claim, pinned(), NOW, rpc), { ok: false, code: E.BAD_SIGNATURE });
  });

  it('honours a custom minRemainingS and accepts the window boundaries', async () => {
    const { claim } = await signedClaim({ validBefore: BigInt(NOW + 10) });
    assert.equal((await verifyEip3009(claim, pinned({ minRemainingS: 5 }), NOW, fakeRpc())).ok, true);
    const { claim: one } = await signedClaim({ validBefore: BigInt(NOW + 1) });
    assert.equal((await verifyEip3009(one, pinned({ minRemainingS: 0, maxWindowS: 1 }), NOW, fakeRpc())).ok, true);
    const { claim: last } = await signedClaim({ validBefore: BigInt(NOW + 299) });
    assert.equal((await verifyEip3009(last, pinned({ minRemainingS: 299 }), NOW, fakeRpc())).ok, true);
  });

  for (const [label, over] of [
    ['a maxWindowS not above the default minRemainingS', { maxWindowS: DEFAULT_MIN_REMAINING_S }],
    ['a fractional minRemainingS', { minRemainingS: 1.5 }],
    ['a non-address payTo', { payTo: 'alice' }],
    ['chainId 0', { chainId: 0, domain: { ...DOMAIN, chainId: 0 } }],
  ] as const) {
    it(`throws CONFIG_INVALID for ${label}`, async () => {
      const { claim } = await signedClaim();
      await assert.rejects(verifyEip3009(claim, pinned(over), NOW, fakeRpc()), { code: E.CONFIG_INVALID });
    });
  }

  for (const nowSec of [NOW + 0.5, Number.NaN]) {
    it(`throws CONFIG_INVALID for nowSec ${nowSec}`, async () => {
      const { claim } = await signedClaim();
      await assert.rejects(verifyEip3009(claim, pinned(), nowSec, fakeRpc()), { code: E.CONFIG_INVALID });
    });
  }
});

describe('resolveDomain: round-2', () => {
  const abi = parseAbi(['function eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])']);
  const rpc5267 = (fields: Hex, contract: string) => fakeRpc({
    call: async () => encodeFunctionResult({ abi, functionName: 'eip712Domain', result: [fields, 'USDC', '2', 84532n, contract as Hex, `0x${'00'.repeat(32)}`, []] }),
  });

  it('refuses eip712Domain() describing another contract', async () => {
    await assert.rejects(resolveDomain({ chainId: 84532, asset: USDC_SEPOLIA }, rpc5267('0x0f', PAY_TO)), { code: E.DOMAIN_MISMATCH });
  });

  it('refuses eip712Domain() with fields other than 0x0f', async () => {
    await assert.rejects(resolveDomain({ chainId: 84532, asset: USDC_SEPOLIA }, rpc5267('0x0d', USDC_SEPOLIA)), { code: E.DOMAIN_MISMATCH });
  });

  it('does not fall back to the legacy getters on a transport error', async () => {
    const rpc = fakeRpc({ call: async ({ data }) => {
      if (data.startsWith(toFunctionSelector('eip712Domain()'))) throw new Error('ECONNRESET');
      throw new Error('legacy path must not be called');
    } });
    await assert.rejects(resolveDomain({ chainId: 84532, asset: USDC_SEPOLIA }, rpc), { code: E.RPC_UNAVAILABLE });
    assert.equal(rpc.calls.length, 1);
  });

  it('a token without DOMAIN_SEPARATOR() is a domain mismatch, not an outage', async () => {
    const legacy = parseAbi(['function name() view returns (string)', 'function version() view returns (string)']);
    const rpc = fakeRpc({ call: async ({ data }) => {
      if (data.startsWith(toFunctionSelector('name()'))) return encodeFunctionResult({ abi: legacy, functionName: 'name', result: 'USDC' });
      if (data.startsWith(toFunctionSelector('version()'))) return encodeFunctionResult({ abi: legacy, functionName: 'version', result: '2' });
      throw new RpcRevertError();
    } });
    await assert.rejects(resolveDomain({ chainId: 84532, asset: USDC_SEPOLIA }, rpc), { code: E.DOMAIN_MISMATCH });
  });
});

describe('viemRpc: revert classification', () => {
  const client = (error: unknown) => ({
    getCode: async () => undefined,
    call: async (): Promise<{ data?: Hex }> => { throw error; },
  });

  it('maps a viem execution revert (direct or as a cause) to RpcRevertError', async () => {
    for (const error of [new ExecutionRevertedError({ message: 'reverted' }), new BaseError('call failed', { cause: new ExecutionRevertedError() })]) {
      await assert.rejects(viemRpc(client(error)).call({ to: PAY_TO, data: '0x' }), RpcRevertError);
    }
  });

  it('passes any other error through unchanged', async () => {
    const transport = new Error('ECONNRESET');
    await assert.rejects(viemRpc(client(transport)).call({ to: PAY_TO, data: '0x' }), (e) => e === transport);
  });
});
