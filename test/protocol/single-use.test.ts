import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CLAIM_MARGIN_S, MemorySingleUseStore, authorizationKey, claimExpiry, claimPayment, releasePayment, singleUseKey,
} from '../../src/protocol/single-use.js';
import { ProtocolErrorCode as E } from '../../src/protocol/errors.js';
import { PAY_TO, USDC_SEPOLIA } from './fixtures.js';

const NOW = 1_800_000_000;
const parts = (over: Partial<Parameters<typeof singleUseKey>[0]> = {}) => ({
  sellerAccountId: 'seller-1', chainId: 84532, asset: USDC_SEPOLIA, from: PAY_TO, nonce: `0x${'11'.repeat(32)}`, ...over,
});

describe('singleUseKey', () => {
  it('normalises address and nonce case so a re-cased replay hits the same key', () => {
    assert.equal(
      singleUseKey(parts()),
      singleUseKey(parts({ asset: USDC_SEPOLIA.toUpperCase().replace('0X', '0x'), from: PAY_TO.toLowerCase(), nonce: `0x${'11'.repeat(32)}`.toUpperCase().replace('0X', '0x') })),
    );
  });

  it('separates sellers, chains and assets', () => {
    const base = singleUseKey(parts());
    assert.notEqual(singleUseKey(parts({ sellerAccountId: 'seller-2' })), base);
    assert.notEqual(singleUseKey(parts({ chainId: 8453 })), base);
    assert.notEqual(singleUseKey(parts({ asset: PAY_TO })), base);
  });

  for (const [label, over] of [
    ['a seller id with the separator', { sellerAccountId: 'a|b' }],
    ['an empty seller id', { sellerAccountId: '' }],
    ['a non-integer chain id', { chainId: 1.5 }],
    ['a bad address', { from: '0x12' }],
    ['a bad nonce', { nonce: '0x11' }],
  ] as const) {
    it(`refuses ${label}`, () => {
      assert.throws(() => singleUseKey(parts(over)), { code: E.MALFORMED });
    });
  }
});

describe('claimExpiry', () => {
  it('is validBefore plus the margin', () => {
    assert.equal(claimExpiry(BigInt(NOW + 60)), NOW + 60 + CLAIM_MARGIN_S);
  });
});

describe('MemorySingleUseStore', () => {
  it('lets the first claim win and refuses the reuse', async () => {
    const store = new MemorySingleUseStore();
    const key = singleUseKey(parts());
    const first = await store.claim(key, NOW + 900);
    assert.equal(first.ok, true);
    assert.deepEqual(await store.claim(key, NOW + 900), { ok: false, code: E.NONCE_REPLAY });
  });

  it('lets exactly one of 50 concurrent claims win', async () => {
    const store = new MemorySingleUseStore();
    const key = singleUseKey(parts());
    const results = await Promise.all(Array.from({ length: 50 }, () => store.claim(key, NOW + 900)));
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => !r.ok && r.code === E.NONCE_REPLAY).length, 49);
  });

  it('releases only with the token of the winning claim', async () => {
    const store = new MemorySingleUseStore();
    const key = singleUseKey(parts());
    const first = await store.claim(key, NOW + 900);
    assert.ok(first.ok);
    assert.equal(await store.release(key, 'not-the-token'), false);
    assert.deepEqual(await store.claim(key, NOW + 900), { ok: false, code: E.NONCE_REPLAY });
    assert.equal(await store.release(key, first.token), true);
    assert.equal((await store.claim(key, NOW + 900)).ok, true);
  });

  it('a stale token cannot release a newer claim on the same key', async () => {
    const store = new MemorySingleUseStore();
    const key = singleUseKey(parts());
    const first = await store.claim(key, NOW + 900);
    assert.ok(first.ok);
    await store.release(key, first.token);
    const second = await store.claim(key, NOW + 900);
    assert.ok(second.ok);
    assert.equal(await store.release(key, first.token), false);
    assert.deepEqual(await store.claim(key, NOW + 900), { ok: false, code: E.NONCE_REPLAY });
  });

  it('prunes only claims past their expiry', async () => {
    const store = new MemorySingleUseStore();
    const old = singleUseKey(parts({ nonce: `0x${'01'.repeat(32)}` }));
    const live = singleUseKey(parts({ nonce: `0x${'02'.repeat(32)}` }));
    await store.claim(old, NOW);
    await store.claim(live, NOW + 1);
    assert.equal(await store.prune(NOW), 1);
    assert.equal((await store.claim(old, NOW + 900)).ok, true);
    assert.deepEqual(await store.claim(live, NOW + 900), { ok: false, code: E.NONCE_REPLAY });
  });

  it('refuses a non-integer expiry', async () => {
    const store = new MemorySingleUseStore();
    await assert.rejects(store.claim(singleUseKey(parts()), Number.NaN), { code: E.MALFORMED });
  });
});

describe('single-use: review hardening', () => {
  it('claimExpiry refuses a validBefore beyond the safe integer range', () => {
    assert.throws(() => claimExpiry(2n ** 64n), { code: E.MALFORMED });
  });

  it('refuses new claims when full instead of growing without bound', async () => {
    const store = new MemorySingleUseStore({ maxEntries: 2 });
    await store.claim(singleUseKey(parts({ nonce: `0x${'01'.repeat(32)}` })), NOW + 900);
    await store.claim(singleUseKey(parts({ nonce: `0x${'02'.repeat(32)}` })), NOW + 900);
    assert.deepEqual(await store.claim(singleUseKey(parts({ nonce: `0x${'03'.repeat(32)}` })), NOW + 900), { ok: false, code: E.STORE_FULL });
    assert.equal(await store.prune(NOW + 900), 2);
    assert.equal((await store.claim(singleUseKey(parts({ nonce: `0x${'03'.repeat(32)}` })), NOW + 1800)).ok, true);
  });

  it('refuses a non-positive capacity', () => {
    assert.throws(() => new MemorySingleUseStore({ maxEntries: 0 }), { code: E.CONFIG_INVALID });
  });
});

describe('claimPayment: seller key plus chain-wide authorization key', () => {
  const auth = { chainId: 84532, asset: USDC_SEPOLIA, from: PAY_TO, nonce: `0x${'11'.repeat(32)}` };

  it('authorizationKey ignores the seller and normalises case', () => {
    assert.equal(authorizationKey(auth), authorizationKey({ ...auth, from: PAY_TO.toLowerCase(), asset: USDC_SEPOLIA.toLowerCase() }));
    assert.match(authorizationKey(auth), /^#auth\|84532\|/);
  });

  it('refuses the same authorization at a second seller account (cross-seller replay)', async () => {
    const store = new MemorySingleUseStore();
    assert.equal((await claimPayment(store, { ...auth, sellerAccountId: 'seller-1' }, NOW + 900)).ok, true);
    assert.deepEqual(await claimPayment(store, { ...auth, sellerAccountId: 'seller-2' }, NOW + 900), { ok: false, code: E.NONCE_REPLAY });
  });

  it('lets exactly one of 50 concurrent claims across two sellers win', async () => {
    const store = new MemorySingleUseStore();
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) =>
      claimPayment(store, { ...auth, sellerAccountId: `seller-${i % 2}` }, NOW + 900)));
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => !r.ok && r.code === E.NONCE_REPLAY).length, 49);
  });

  it('releases the chain-wide claim when the seller claim is refused', async () => {
    const store = new MemorySingleUseStore();
    await store.claim(singleUseKey({ ...auth, sellerAccountId: 'seller-1' }), NOW + 900);
    assert.deepEqual(await claimPayment(store, { ...auth, sellerAccountId: 'seller-1' }, NOW + 900), { ok: false, code: E.NONCE_REPLAY });
    assert.equal((await claimPayment(store, { ...auth, sellerAccountId: 'seller-2' }, NOW + 900)).ok, true);
  });

  it('rolls back the chain-wide claim when the store fills between the two claims', async () => {
    const store = new MemorySingleUseStore({ maxEntries: 1 });
    assert.deepEqual(await claimPayment(store, { ...auth, sellerAccountId: 'seller-1' }, NOW + 900), { ok: false, code: E.STORE_FULL });
    assert.equal((await store.claim(authorizationKey(auth), NOW + 900)).ok, true);
  });

  it('releasePayment frees both keys, and only with the right tokens', async () => {
    const store = new MemorySingleUseStore();
    const first = await claimPayment(store, { ...auth, sellerAccountId: 'seller-1' }, NOW + 900);
    assert.ok(first.ok);
    assert.equal(await releasePayment(store, { ...first.claim, authToken: 'wrong' }), false);
    for (const sellerAccountId of ['seller-1', 'seller-2']) {
      assert.deepEqual(await claimPayment(store, { ...auth, sellerAccountId }, NOW + 900), { ok: false, code: E.NONCE_REPLAY });
    }
    assert.equal(await releasePayment(store, first.claim), true);
    assert.equal((await claimPayment(store, { ...auth, sellerAccountId: 'seller-2' }, NOW + 900)).ok, true);
  });

  it('a seller account named "auth" cannot collide with the chain-wide key', async () => {
    const store = new MemorySingleUseStore();
    assert.equal((await claimPayment(store, { ...auth, sellerAccountId: 'auth' }, NOW + 900)).ok, true);
  });
});

describe('single-use: round-2', () => {
  it('separates payers and nonces', () => {
    const base = singleUseKey(parts());
    assert.notEqual(singleUseKey(parts({ from: USDC_SEPOLIA })), base);
    assert.notEqual(singleUseKey(parts({ nonce: `0x${'22'.repeat(32)}` })), base);
  });

  it('a full store still reports a replay as a replay, and release frees capacity', async () => {
    const store = new MemorySingleUseStore({ maxEntries: 1 });
    const key = singleUseKey(parts());
    const first = await store.claim(key, NOW + 900);
    assert.ok(first.ok);
    assert.deepEqual(await store.claim(key, NOW + 900), { ok: false, code: E.NONCE_REPLAY });
    await store.release(key, first.token);
    assert.equal((await store.claim(singleUseKey(parts({ nonce: `0x${'09'.repeat(32)}` })), NOW + 900)).ok, true);
  });

  it('an expired but unpruned claim still blocks', async () => {
    const store = new MemorySingleUseStore();
    const key = singleUseKey(parts());
    await store.claim(key, NOW);
    assert.deepEqual(await store.claim(key, NOW + 900), { ok: false, code: E.NONCE_REPLAY });
  });

  it('claimExpiry accepts the largest safe value and refuses one more, negatives and bad margins', () => {
    const max = BigInt(Number.MAX_SAFE_INTEGER - CLAIM_MARGIN_S);
    assert.equal(claimExpiry(max), Number.MAX_SAFE_INTEGER);
    assert.throws(() => claimExpiry(max + 1n), { code: E.MALFORMED });
    assert.throws(() => claimExpiry(-1n), { code: E.MALFORMED });
    for (const margin of [-1, 1.5, Number.NaN]) assert.throws(() => claimExpiry(1n, margin), { code: E.MALFORMED });
  });

  it('refuses an unsafe-integer chain id in keys', () => {
    assert.throws(() => singleUseKey(parts({ chainId: 1e21 })), { code: E.MALFORMED });
  });
});
