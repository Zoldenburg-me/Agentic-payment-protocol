import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { generatePrivateKey } from 'viem/accounts';
import {
  DEFAULT_ASSETS, Ledger, PaymentHub, assetKey, evmX402Signer, mockMppSigner, withAssets,
  type Policy, type Wallet,
} from '../src/index.js';
import {
  MOCK_MPP_CURRENCY, MOCK_MPP_NETWORK, startMockMerchant, type MockMerchant,
} from '../src/testing/mock-merchant.js';

const assets = withAssets(DEFAULT_ASSETS, [
  [assetKey(MOCK_MPP_NETWORK, MOCK_MPP_CURRENCY), { symbol: 'MOCK', decimals: 6 }],
]);
const fullWallet = (): Wallet => ({
  x402: evmX402Signer(generatePrivateKey()),
  mpp: mockMppSigner(),
});

describe('PaymentHub against a mock merchant', () => {
  let merchant: MockMerchant;
  beforeEach(async () => { merchant = await startMockMerchant(); });
  afterEach(async () => { await merchant.close(); });

  const hub = (wallet: Wallet, policy: Partial<Policy> = {}, ledger = new Ledger()) =>
    new PaymentHub({ wallet, policy, assets, ledger });

  it('passes through free resources without paying', async () => {
    const result = await hub(fullWallet()).request(`${merchant.url}/free`);
    assert.equal(result.status, 'free');
    assert.equal(merchant.settled.length, 0);
  });

  it('pays an x402 paywall with a verifiable EIP-3009 signature', async () => {
    const h = hub(fullWallet());
    const result = await h.request(`${merchant.url}/x402/weather`);
    assert.equal(result.status, 'paid');
    if (result.status !== 'paid') return;
    assert.equal(result.quote.protocol, 'x402');
    assert.equal(result.usdMicros, 10_000n);
    assert.equal(result.receipt?.reference, '0xmocktx');
    assert.match(await result.response.text(), /via x402/);
    assert.equal(h.ledger.spentToday(), 10_000n);
  });

  it('pays an MPP paywall', async () => {
    const result = await hub(fullWallet()).request(`${merchant.url}/mpp/search`);
    assert.equal(result.status, 'paid');
    if (result.status !== 'paid') return;
    assert.equal(result.quote.protocol, 'mpp');
    assert.match(await result.response.text(), /via mpp/);
  });

  it('picks the cheaper protocol when a server offers both', async () => {
    const result = await hub(fullWallet()).request(`${merchant.url}/both/data`);
    assert.equal(result.status, 'paid');
    if (result.status === 'paid') assert.equal(result.quote.protocol, 'mpp');
  });

  it('falls back to the protocol the wallet can actually pay with', async () => {
    const x402Only: Wallet = { x402: evmX402Signer(generatePrivateKey()) };
    const result = await hub(x402Only).request(`${merchant.url}/both/data`);
    assert.equal(result.status, 'paid');
    if (result.status === 'paid') assert.equal(result.quote.protocol, 'x402');
  });

  it('blocks purchases above the per-transaction cap and pays nothing', async () => {
    const result = await hub(fullWallet()).request(`${merchant.url}/expensive`);
    assert.equal(result.status, 'blocked');
    if (result.status === 'blocked') {
      const verdict = result.quotes[0]?.verdict;
      assert.equal(verdict?.ok, false);
      assert.match(verdict && !verdict.ok ? verdict.reason : '', /per-transaction cap/);
    }
    assert.equal(merchant.settled.length, 0);
  });

  it('stops spending once the daily budget is used up', async () => {
    const h = hub(fullWallet(), { dailyBudgetUsdMicros: 20_000n });
    assert.equal((await h.request(`${merchant.url}/x402/weather`)).status, 'paid');
    assert.equal((await h.request(`${merchant.url}/x402/weather`)).status, 'paid');
    assert.equal((await h.request(`${merchant.url}/x402/weather`)).status, 'blocked');
    assert.equal(merchant.settled.length, 2);
  });

  it('holds the daily budget when payments run concurrently', async () => {
    // Every 402 body's cancel() waits until all requests reach it, so each policy check
    // runs before any reservation: the widest interleaving a real event loop can produce.
    const parallel = 6;
    let arrived = 0;
    let openGate = (): void => undefined;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const fallback = setTimeout(openGate, 2_000);
    const gatedFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (res.status !== 402) return res;
      const body = new ReadableStream({
        async cancel() {
          if (++arrived === parallel) openGate();
          await gate;
        },
      });
      return new Response(body, { status: 402, headers: res.headers });
    };
    const h = new PaymentHub({
      wallet: fullWallet(), policy: { dailyBudgetUsdMicros: 20_000n }, assets, fetch: gatedFetch,
    });
    const results = await Promise.all(
      Array.from({ length: parallel }, () => h.request(`${merchant.url}/x402/weather`)),
    );
    clearTimeout(fallback);
    assert.equal(results.filter((r) => r.status === 'paid').length, 2);
    assert.equal(results.filter((r) => r.status === 'blocked').length, 4);
    assert.equal(merchant.settled.length, 2);
    assert.equal(h.ledger.spentToday(), 20_000n);
  });

  it('enforces the host allowlist', async () => {
    const result = await hub(fullWallet(), { allowedHosts: ['api.example.com'] })
      .request(`${merchant.url}/x402/weather`);
    assert.equal(result.status, 'blocked');
  });

  it('quote mode reports prices and never pays', async () => {
    const result = await hub(fullWallet()).request(`${merchant.url}/both/data`, {}, 'quote');
    assert.equal(result.status, 'quoted');
    if (result.status === 'quoted') {
      assert.deepEqual(result.quotes.map((q) => q.quote.protocol).sort(), ['mpp', 'x402']);
    }
    assert.equal(merchant.settled.length, 0);
  });

  it('refuses to pay when the wallet has no signers (quote-only mode)', async () => {
    const result = await hub({}).request(`${merchant.url}/x402/weather`);
    assert.equal(result.status, 'blocked');
    assert.equal(merchant.settled.length, 0);
  });

  it('refuses assets that are not registered stablecoins', async () => {
    const strict = new PaymentHub({ wallet: fullWallet(), assets: DEFAULT_ASSETS });
    const result = await strict.request(`${merchant.url}/mpp/search`);
    assert.equal(result.status, 'blocked');
  });

  it('persists the ledger so the budget survives a restart', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agentpay-')), 'ledger.jsonl');
    await hub(fullWallet(), {}, new Ledger(path)).request(`${merchant.url}/x402/weather`);
    assert.equal(new Ledger(path).spentToday(), 10_000n);
  });

  it('reports unsupported 402s instead of guessing', async () => {
    const fake = new PaymentHub({
      fetch: async () => new Response('pay me', { status: 402 }),
    });
    assert.equal((await fake.request('http://example.test/')).status, 'unsupported');
  });
});
