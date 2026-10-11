import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_ASSETS, assetKey, withAssets } from 'agentpay-hub';
import { AcceptErrorCode as E, type AcceptOptions, parseAcceptOptions } from '../src/index.js';
import { CHAIN_ID, PAY_TO, USDC } from './helpers.js';

const base: AcceptOptions = {
  sellerAccountId: 'seller-1', payTo: PAY_TO, chainId: CHAIN_ID, asset: USDC, price: () => ({ amount: 1n }),
};

describe('parseAcceptOptions', () => {
  it('applies the documented defaults and pins the domain from the asset registry', () => {
    const c = parseAcceptOptions(base);
    assert.equal(c.minConfirmations, 2);
    assert.equal(c.maxTimeoutSeconds, 120);
    assert.equal(c.settlementTimeoutMs, 60_000);
    assert.equal(c.pollIntervalMs, 1_000);
    assert.deepEqual(c.rateLimit, { perIpPerMinute: 120, perPayerPerMinute: 60 });
    assert.equal(c.optimisticMaxUsdMicros, undefined);
    assert.deepEqual(c.domain, { name: 'USDC', version: '2', chainId: CHAIN_ID, verifyingContract: USDC });
    assert.equal(c.network, `eip155:${CHAIN_ID}`);
  });

  it('parses optimistic.maxUsd into micro-dollars', () => {
    assert.equal(parseAcceptOptions({ ...base, optimistic: { maxUsd: '0.50', readOnly: true } }).optimisticMaxUsdMicros, 500_000n);
  });

  const invalid: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['an empty sellerAccountId', { sellerAccountId: '' }],
    ['a sellerAccountId with the key separator', { sellerAccountId: 'a|b' }],
    ['a payTo that is not an address', { payTo: 'alice' }],
    ['a zero payTo', { payTo: '0x0000000000000000000000000000000000000000' }],
    ['an asset with no pinned EIP-712 domain', { asset: PAY_TO }],
    ['a chain the asset is not registered on', { chainId: 8453 }],
    ['minConfirmations 0', { minConfirmations: 0 }],
    ['minConfirmations 65', { minConfirmations: 65 }],
    ['fractional minConfirmations', { minConfirmations: 1.5 }],
    ['maxTimeoutSeconds above 240 (no skew margin under the 300 s cap)', { maxTimeoutSeconds: 241 }],
    ['maxTimeoutSeconds below 60', { maxTimeoutSeconds: 59 }],
    ['a non-https publicOrigin', { publicOrigin: 'http://zoldhq.com' }],
    ['a publicOrigin with a path', { publicOrigin: 'https://zoldhq.com/api' }],
    ['optimistic above $0.50', { optimistic: { maxUsd: '0.51', readOnly: true } }],
    ['optimistic with a malformed amount', { optimistic: { maxUsd: 'half', readOnly: true } }],
    ['optimistic without readOnly: true', { optimistic: { maxUsd: '0.10', readOnly: false } }],
    ['a zero rate limit', { rateLimit: { perIpPerMinute: 0 } }],
    ['a price that is not a function', { price: 5 }],
    ['an unknown option', { facilitator: 'https://x402.org' }],
    ['a settlement timeout shorter than one poll', { settlementTimeoutMs: 5, pollIntervalMs: 10 }],
  ];
  for (const [label, over] of invalid) {
    it(`refuses ${label}`, () => {
      assert.throws(() => parseAcceptOptions({ ...base, ...over } as AcceptOptions), { code: E.CONFIG_INVALID });
    });
  }

  it('accepts a custom asset registry with a pinned domain', () => {
    const custom = '0x0000000000000000000000000000000000000c0f';
    const assets = withAssets(DEFAULT_ASSETS, [[assetKey(`eip155:${CHAIN_ID}`, custom), { symbol: 'C', decimals: 6, eip712: { name: 'C', version: '1' } }]]);
    assert.equal(parseAcceptOptions({ ...base, asset: custom, assets }).domain.name, 'C');
  });

  it('never echoes option values in its errors', () => {
    assert.throws(() => parseAcceptOptions({ ...base, payTo: 'secret-looking-value' }), (e: Error) => !e.message.includes('secret-looking-value'));
  });
});
