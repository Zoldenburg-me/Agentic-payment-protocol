import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { b64decode } from 'agentpay-hub/protocol';
import { AcceptErrorCode as E, MemoryRateLimiter, MemorySellerLedger, accept } from '../src/index.js';
import { CHAIN_ID, DOMAIN, NOW_S, PAY_TO, PRICE, USDC, codeOf, payHeader, setup, tick } from './helpers.js';

const paid = (h: string) => ({ 'payment-signature': h });

describe('handle: offer', () => {
  it('answers an unpaid request with 402 and a pinned x402 v2 offer', async () => {
    const s = setup({ publicOrigin: 'https://zoldhq.com' });
    const r = await s.acceptor.handle(s.req());
    assert.equal(r.kind, 'respond');
    if (r.kind !== 'respond') return;
    assert.equal(r.status, 402);
    assert.equal(codeOf(r), E.PAYMENT_REQUIRED);
    const offer = b64decode<{ x402Version: number; resource: { url: string }; accepts: Array<Record<string, unknown>> }>(r.headers['PAYMENT-REQUIRED'] ?? '');
    assert.equal(offer.x402Version, 2);
    assert.equal(offer.resource.url, 'https://zoldhq.com/rates');
    assert.deepEqual(offer.accepts, [{
      scheme: 'exact', network: `eip155:${CHAIN_ID}`, amount: PRICE.toString(), asset: USDC, payTo: PAY_TO,
      maxTimeoutSeconds: 120, extra: { name: DOMAIN.name, version: DOMAIN.version },
    }]);
  });

  it('prices from headers only and refuses a paid upload whose Content-Length differs from the priced size', async () => {
    const s = setup({
      price: ({ headers }) => {
        const size = Number(headers['x-upload-size']);
        if (!Number.isSafeInteger(size) || size <= 0) throw new Error('bad size');
        return { amount: BigInt(size) * 10n, meta: { size: String(size) }, contentLength: size };
      },
    });
    const header = await payHeader(s.buyer, { value: 1000n, accepted: { amount: '1000' } });
    const r = await s.acceptor.handle(s.req({ ...paid(header), 'x-upload-size': '100', 'content-length': '101' }, { method: 'PUT' }));
    assert.equal(r.kind === 'respond' && r.status, 400);
    assert.equal(codeOf(r), E.PRICE_MISMATCH);
    assert.equal(s.chain.rpcCalls, 0);
  });

  it('a price function that throws on bad request headers is a 400', async () => {
    const s = setup({ price: () => { throw new Error('bad header'); } });
    const r = await s.acceptor.handle(s.req());
    assert.equal(r.kind === 'respond' && r.status, 400);
    assert.equal(codeOf(r), E.PRICE_INVALID);
  });

  it('a price function that returns a non-positive amount is a seller error (500)', async () => {
    const s = setup({ price: () => ({ amount: 0n }) });
    const r = await s.acceptor.handle(s.req());
    assert.equal(r.kind === 'respond' && r.status, 500);
    assert.equal(codeOf(r), E.PRICE_ERROR);
  });
});

describe('handle: strict parsing happens before any RPC', () => {
  it('refuses a request carrying both an x402 and an MPP payment header', async () => {
    const s = setup();
    const r = await s.acceptor.handle(s.req({ ...paid(await payHeader(s.buyer)), authorization: 'Payment abc' }));
    assert.equal(r.kind === 'respond' && r.status, 400);
    assert.equal(codeOf(r), E.BOTH_HEADERS);
    assert.equal(s.chain.rpcCalls, 0);
  });

  it('refuses x402 v1', async () => {
    const s = setup();
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { x402Version: 1 }))));
    assert.equal(r.kind === 'respond' && r.status, 400);
    assert.equal(codeOf(r), E.X402_V1_UNSUPPORTED);
    assert.equal(s.chain.rpcCalls, 0);
  });

  it('refuses an oversized or non-canonical header as malformed', async () => {
    const s = setup();
    for (const h of ['A'.repeat(20_000), ` ${await payHeader(s.buyer)}`]) {
      const r = await s.acceptor.handle(s.req(paid(h)));
      assert.equal(r.kind === 'respond' && r.status, 400);
      assert.equal(codeOf(r), E.X402_MALFORMED);
    }
    assert.equal(s.chain.rpcCalls, 0);
  });

  it('rate-limits per client IP before any RPC', async () => {
    const s = setup({ rateLimit: { perIpPerMinute: 1, perPayerPerMinute: 100 } });
    await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: `0x${'01'.repeat(32)}` }))));
    const calls = s.chain.rpcCalls;
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: `0x${'02'.repeat(32)}` }))));
    assert.equal(r.kind === 'respond' && r.status, 429);
    assert.equal(codeOf(r), E.RATE_LIMITED);
    assert.equal(s.chain.rpcCalls, calls);
  });

  it('rate-limits per claimed payer across IPs', async () => {
    const s = setup({ rateLimit: { perIpPerMinute: 100, perPayerPerMinute: 1 } });
    await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: `0x${'01'.repeat(32)}` })), { clientIp: '198.51.100.1' }));
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: `0x${'02'.repeat(32)}` })), { clientIp: '198.51.100.2' }));
    assert.equal(codeOf(r), E.RATE_LIMITED);
  });
});

describe('handle: verifier refusals map to 402 with one exact code', () => {
  const cases: ReadonlyArray<[string, Parameters<typeof payHeader>[1], string]> = [
    ['a domain spoofed via extra', { domain: { ...DOMAIN, name: 'Fake' }, accepted: { extra: { name: 'Fake', version: '2' } } }, E.BAD_SIGNATURE],
    ['another chain', { accepted: { network: 'eip155:8453' } }, E.CHAIN_MISMATCH],
    ['another asset', { accepted: { asset: PAY_TO } }, E.ASSET_MISMATCH],
    ['another payTo', { to: USDC }, E.PAYTO_MISMATCH],
    ['an underpayment', { value: PRICE - 1n }, E.UNDERPAID],
    ['an expired window', { validBefore: BigInt(NOW_S) }, E.EXPIRED],
    ['a window over 300 s', { validBefore: BigInt(NOW_S + 301) }, E.WINDOW_TOO_LONG],
  ];
  for (const [label, over, code] of cases) {
    it(`refuses ${label}`, async () => {
      const s = setup();
      const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, over))));
      assert.equal(r.kind === 'respond' && r.status, 402);
      assert.equal(codeOf(r), code);
      assert.ok(r.kind === 'respond' && r.headers['PAYMENT-REQUIRED'], 'a refused payment gets a fresh offer');
      assert.equal(s.chain.submissions.length, 0);
    });
  }

  it('refuses a high-s signature', async () => {
    const s = setup();
    const sig = b64decode<{ payload: { signature: string } }>(await payHeader(s.buyer));
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const sHex = sig.payload.signature.slice(66, 130);
    const v = sig.payload.signature.slice(130) === '1b' ? '1c' : '1b';
    const high = `${sig.payload.signature.slice(0, 66)}${(n - BigInt(`0x${sHex}`)).toString(16).padStart(64, '0')}${v}`;
    const tampered = Buffer.from(JSON.stringify({ ...sig, payload: { ...sig.payload, signature: high } })).toString('base64');
    const r = await s.acceptor.handle(s.req(paid(tampered)));
    assert.equal(codeOf(r), E.HIGH_S);
  });

  it('refuses a contract-style signature from a payer with no code', async () => {
    const s = setup();
    const sig = b64decode<{ payload: { signature: string } }>(await payHeader(s.buyer));
    const forged = Buffer.from(JSON.stringify({ ...sig, payload: { ...sig.payload, signature: `0x${'ab'.repeat(97)}` } })).toString('base64');
    const r = await s.acceptor.handle(s.req(paid(forged)));
    assert.equal(codeOf(r), E.PAYER_NO_CODE);
  });
});

describe('handle: one payment, one delivery', () => {
  it('settles with 2 confirmations, records the ledger row, and returns the payment context', async () => {
    const s = setup();
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    assert.equal(r.kind, 'paid');
    if (r.kind !== 'paid') return;
    assert.equal(r.paid.payer, s.buyer.address);
    assert.equal(r.paid.amount, PRICE);
    assert.equal(r.paid.settled, true);
    assert.equal(r.paid.replayed, false);
    assert.equal(s.chain.balanceOfSync(PAY_TO), PRICE);
    const row = await s.ledger.get(r.paid.claimKey);
    assert.equal(row?.status, 'settled');
    assert.equal(row?.delivered, true);
    assert.equal(row?.txHash, r.paid.txHash);
    const receipt = b64decode<Record<string, unknown>>(r.headers['PAYMENT-RESPONSE'] ?? '');
    assert.deepEqual(receipt, { success: true, transaction: r.paid.txHash, network: `eip155:${CHAIN_ID}`, payer: s.buyer.address });
  });

  it('returns the same claimKey without a second submit when the same payment is retried', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    const first = await s.acceptor.handle(s.req(paid(header)));
    s.advance(200_000); // past validBefore: a retry after a dropped response must still work
    const again = await s.acceptor.handle(s.req(paid(header)));
    assert.ok(first.kind === 'paid' && again.kind === 'paid');
    assert.equal(again.paid.claimKey, first.paid.claimKey);
    assert.equal(again.paid.replayed, true);
    assert.equal(s.chain.submissions.length, 1);
  });

  it('does not replay a delivered payment for a different path', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    await s.acceptor.handle(s.req(paid(header)));
    const r = await s.acceptor.handle(s.req(paid(header), { path: '/other' }));
    assert.equal(r.kind === 'respond' && r.status, 409);
    assert.equal(codeOf(r), E.NONCE_REPLAY);
  });

  it('lets exactly one of 50 concurrent identical requests submit', async () => {
    const s = setup({ rateLimit: { perIpPerMinute: 1000, perPayerPerMinute: 1000 } });
    const header = await payHeader(s.buyer);
    const results = await Promise.all(Array.from({ length: 50 }, () => s.acceptor.handle(s.req(paid(header)))));
    assert.equal(s.chain.submissions.length, 1);
    assert.equal(results.filter((r) => r.kind === 'paid' && !r.paid.replayed).length, 1);
    assert.ok(results.every((r) => r.kind === 'paid' || (r.kind === 'respond' && r.status === 409)));
  });

  it('reports an in-flight payment as in progress', async () => {
    const s = setup({}, { autoMine: false });
    const header = await payHeader(s.buyer);
    const first = s.acceptor.handle(s.req(paid(header)));
    await s.chain.untilSubmitted(1);
    const second = await s.acceptor.handle(s.req(paid(header)));
    assert.equal(second.kind === 'respond' && second.status, 409);
    assert.equal(codeOf(second), E.IN_PROGRESS);
    s.chain.mine(3);
    assert.equal((await first).kind, 'paid');
  });

  it('refuses the same authorization at a second seller sharing the claim store', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    const two = accept({ ...s.options, sellerAccountId: 'seller-2' }, {
      ledger: new MemorySellerLedger(), claims: s.claims, chain: s.chain, submitter: s.chain,
      now: () => NOW_S * 1000, sleep: tick, onError: () => undefined,
    });
    assert.equal((await s.acceptor.handle(s.req(paid(header)))).kind, 'paid');
    const r = await two.handle(s.req(paid(header)));
    assert.equal(r.kind === 'respond' && r.status, 409);
    assert.equal(codeOf(r), E.NONCE_REPLAY);
  });

  it('a refusal before anything is sent is not sticky: the payer funds the account and retries the same signature', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    s.chain.burn(s.buyer.address);
    const first = await s.acceptor.handle(s.req(paid(header)));
    assert.equal(codeOf(first), E.INSUFFICIENT_FUNDS);
    assert.equal((await s.ledger.list()).length, 0, 'no ledger row for a payment that never got past the pre-checks');
    s.chain.mint(s.buyer.address, 1_000_000n);
    const again = await s.acceptor.handle(s.req(paid(header)));
    assert.equal(again.kind, 'paid');
  });
});

describe('MemoryRateLimiter', () => {
  it('allows n per window per key and resets after the window', () => {
    const rl = new MemoryRateLimiter();
    assert.equal(rl.take('k', 2, 0), true);
    assert.equal(rl.take('k', 2, 1), true);
    assert.equal(rl.take('k', 2, 2), false);
    assert.equal(rl.take('other', 2, 2), true);
    assert.equal(rl.take('k', 2, 60_000), true);
  });

  it('forgets the least recently used key when it is tracking too many', () => {
    const rl = new MemoryRateLimiter({ maxKeys: 1 });
    assert.equal(rl.take('a', 1, 0), true);
    assert.equal(rl.take('b', 1, 0), true);
    assert.equal(rl.take('a', 1, 0), true, 'a was forgotten, so it starts a new window');
  });
});
