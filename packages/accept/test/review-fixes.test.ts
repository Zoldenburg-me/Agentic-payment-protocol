import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { authorizationKey, b64decode } from 'agentpay-hub/protocol';
import { EXPIRY_GRACE_S, AcceptError, AcceptErrorCode as E, MemorySellerLedger, type NewSellerPayment, type TransferCall } from '../src/index.js';
import { CHAIN_ID, NOW_S, PAY_TO, PRICE, USDC, codeOf, payHeader, setup, tick } from './helpers.js';

const paid = (h: string) => ({ 'payment-signature': h });
/** Past validBefore (NOW + 120 s) plus the finalization grace. */
const PAST_GRACE_MS = (120 + EXPIRY_GRACE_S + 1) * 1000;
const NONCE = `0x${'11'.repeat(32)}` as const;
const optimistic = { optimistic: { maxUsd: '0.50', readOnly: true as const } };

function callFrom(header: string): TransferCall {
  const { payload } = b64decode<{ payload: { signature: Hex; authorization: Record<string, string> } }>(header);
  const a = payload.authorization;
  return {
    asset: USDC, signature: payload.signature,
    authorization: {
      from: a.from as Hex, to: a.to as Hex, value: BigInt(a.value ?? '0'),
      validAfter: BigInt(a.validAfter ?? '0'), validBefore: BigInt(a.validBefore ?? '0'), nonce: a.nonce as Hex,
    },
  };
}

describe('replay is bound to what was bought', () => {
  it('a payment whose optimistic settlement failed is never replayed for free', async () => {
    const s = setup(optimistic, { autoMine: false });
    const header = await payHeader(s.buyer);
    s.chain.revertNextSubmitOnChain = 'plain';
    assert.equal((await s.acceptor.handle(s.req(paid(header)))).kind, 'paid');
    s.chain.mine(3);
    await s.acceptor.idle();
    const again = await s.acceptor.handle(s.req(paid(header)));
    assert.equal(again.kind === 'respond' && again.status, 502);
    assert.equal(codeOf(again), E.SUBMIT_FAILED);
    s.advance(PAST_GRACE_MS);
    await s.acceptor.handle(s.req(paid(header))); // now final
    const calls = s.chain.rpcCalls;
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.SUBMIT_FAILED);
    assert.equal(s.chain.rpcCalls, calls, 'a refused payment is answered from the ledger, without touching the chain');
  });

  it('stores a digest of the query string, never the query itself (it may carry personal data)', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    assert.equal((await s.acceptor.handle(s.req(paid(header), { query: 'email=ada%40example.org' }))).kind, 'paid');
    const [row] = await s.ledger.list();
    assert.doesNotMatch(JSON.stringify(row), /ada|example\.org/);
    assert.equal((await s.acceptor.handle(s.req(paid(header), { query: 'email=ada%40example.org' }))).kind, 'paid');
  });

  it('a replay with a different query string is refused', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    assert.equal((await s.acceptor.handle(s.req(paid(header), { query: 'id=1' }))).kind, 'paid');
    const r = await s.acceptor.handle(s.req(paid(header), { query: 'id=2' }));
    assert.equal(codeOf(r), E.NONCE_REPLAY);
  });

  it('a replay whose headers now price differently (amount or meta) is refused', async () => {
    const s = setup({
      price: ({ headers }) => ({ amount: PRICE, meta: { size: headers['x-size'] ?? '0' } }),
    });
    const header = await payHeader(s.buyer);
    assert.equal((await s.acceptor.handle(s.req({ ...paid(header), 'x-size': '1' }))).kind, 'paid');
    const r = await s.acceptor.handle(s.req({ ...paid(header), 'x-size': '999' }));
    assert.equal(codeOf(r), E.NONCE_REPLAY);
  });
});

describe('retries resume payments whose outcome was unknown', () => {
  it('a payment that timed out waiting for confirmations is settled and delivered on retry', async () => {
    const s = setup({ settlementTimeoutMs: 10 }, { autoMine: false });
    const header = await payHeader(s.buyer);
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.SETTLEMENT_TIMEOUT);
    s.chain.mine(3);
    const again = await s.acceptor.handle(s.req(paid(header)));
    assert.ok(again.kind === 'paid');
    assert.equal(again.paid.replayed, false);
    assert.equal(again.paid.txHash, s.chain.submissions[0]);
    assert.equal(s.chain.submissions.length, 1);
  });

  it('a submit whose transport failed after broadcast is found on retry and delivered', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    s.chain.failNextSubmitTransport = 'after-broadcast';
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.SUBMIT_FAILED);
    s.chain.mine(2);
    const again = await s.acceptor.handle(s.req(paid(header)));
    assert.equal(again.kind, 'paid');
  });

  it('an owed payment never sent (transport failed first) is sent on retry', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    s.chain.failNextSubmitTransport = true;
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.SUBMIT_FAILED);
    assert.equal(s.chain.submissions.length, 0);
    const again = await s.acceptor.handle(s.req(paid(header)));
    assert.ok(again.kind === 'paid' && again.paid.settled);
  });

  it('a payment still confirming answers IN_PROGRESS with Retry-After', async () => {
    const s = setup({ settlementTimeoutMs: 5 }, { autoMine: false });
    const header = await payHeader(s.buyer);
    await s.acceptor.handle(s.req(paid(header)));
    const again = await s.acceptor.handle(s.req(paid(header)));
    assert.equal(again.kind === 'respond' && again.status, 409);
    assert.equal(codeOf(again), E.IN_PROGRESS);
    assert.equal(again.kind === 'respond' && again.headers['retry-after'], '1');
  });
});

describe('reverts are confirmed before they are final', () => {
  it('waits for minConfirmations on a reverted receipt', async () => {
    const s = setup({}, { autoMine: false });
    s.chain.revertNextSubmitOnChain = 'plain';
    let done = false;
    const pending = s.acceptor.handle(s.req(paid(await payHeader(s.buyer)))).then((r) => { done = true; return r; });
    await s.chain.untilSubmitted(1);
    s.chain.mine(1);
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(done, false);
    s.chain.mine(1);
    assert.equal(codeOf(await pending), E.SUBMIT_FAILED);
  });

  it('a revert where the authorization is used but no log is found is unknown: no refusal, no release', async () => {
    const s = setup();
    s.chain.revertNextSubmitOnChain = 'front-run';
    s.chain.hideAuthorizationUseLogs = true;
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    assert.equal(r.kind === 'respond' && r.status, 503);
    assert.equal(codeOf(r), E.SETTLEMENT_UNKNOWN);
    const [row] = await s.ledger.list();
    assert.equal(row?.status, 'submitted');
    const key = authorizationKey({ chainId: CHAIN_ID, asset: USDC, from: s.buyer.address, nonce: NONCE });
    assert.equal((await s.claims.claim(key, 1)).ok, false, 'claim kept');
  });

  it('a simulation that reverts because of a front-run settles from the front-runner', async () => {
    const s = setup();
    s.chain.frontRunBeforeSimulate = true;
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    assert.ok(r.kind === 'paid');
    assert.equal(r.paid.txHash, s.chain.externalTxs[0]);
  });
});

describe('errors are reported, never swallowed', () => {
  it('a background refusal is reported to onError with its code', async () => {
    const s = setup(optimistic, { autoMine: false });
    s.chain.revertNextSubmitOnChain = 'plain';
    await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    s.chain.mine(3);
    await s.acceptor.idle();
    assert.equal(s.errors.length, 1);
    assert.ok(s.errors[0] instanceof AcceptError);
    assert.equal((s.errors[0] as AcceptError).code, E.SUBMIT_FAILED);
  });

  it('an onError that throws does not escape', async () => {
    const s = setup(optimistic, { autoMine: false }, { onError: () => { throw new Error('logger down'); } });
    s.chain.revertNextSubmitOnChain = 'plain';
    await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    s.chain.mine(3);
    await s.acceptor.idle();
  });

  it('a ledger failure becomes a reported 500 and the claim it orphaned is released', async () => {
    class BrokenLedger extends MemorySellerLedger {
      override async recordVerified(_row: NewSellerPayment): Promise<never> {
        throw new Error('db down');
      }
    }
    const s = setup({}, {}, { ledger: new BrokenLedger() });
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    assert.equal(r.kind === 'respond' && r.status, 500);
    assert.equal(codeOf(r), E.INTERNAL);
    assert.equal(s.errors.length, 1);
    const key = authorizationKey({ chainId: CHAIN_ID, asset: USDC, from: s.buyer.address, nonce: NONCE });
    assert.equal((await s.claims.claim(key, 1)).ok, true);
  });
});

describe('request hygiene', () => {
  it('the payer bucket is only spent by verified payments, so a forger cannot lock a payer out', async () => {
    const s = setup({ rateLimit: { perIpPerMinute: 100, perPayerPerMinute: 1 } });
    const forged = b64decode<{ payload: { authorization: Record<string, string> } }>(await payHeader(s.buyer, { nonce: `0x${'01'.repeat(32)}` }));
    forged.payload.authorization.nonce = `0x${'02'.repeat(32)}`;
    const junk = Buffer.from(JSON.stringify(forged)).toString('base64');
    for (let i = 0; i < 3; i++) assert.equal(codeOf(await s.acceptor.handle(s.req(paid(junk)))), E.BAD_SIGNATURE);
    assert.equal((await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: `0x${'03'.repeat(32)}` }))))).kind, 'paid');
  });

  it('the payer bucket applies after verification', async () => {
    const s = setup({ rateLimit: { perIpPerMinute: 100, perPayerPerMinute: 1 } });
    await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: `0x${'01'.repeat(32)}` }))));
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: `0x${'02'.repeat(32)}` }))));
    assert.equal(r.kind === 'respond' && r.status, 429);
    assert.equal(r.kind === 'respond' && r.headers['retry-after'], '60');
  });

  it('rate limits reset after a minute', async () => {
    const s = setup({ rateLimit: { perIpPerMinute: 1, perPayerPerMinute: 100 } });
    await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: `0x${'01'.repeat(32)}`, validBefore: BigInt(NOW_S + 200) }))));
    s.advance(60_000);
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: `0x${'02'.repeat(32)}`, validBefore: BigInt(NOW_S + 120 + 60) }))));
    assert.equal(r.kind, 'paid');
  });

  for (const path of ['/a/../rates', '//rates', 'http://evil.test/rates', '/rates%2e%2e', '']) {
    it(`refuses the non-canonical path ${JSON.stringify(path)}`, async () => {
      const s = setup();
      const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer)), { path }));
      assert.equal(r.kind === 'respond' && r.status, 400);
      assert.equal(codeOf(r), E.MALFORMED);
    });
  }

  it('refuses a non-decimal chain id in the accepted network', async () => {
    const s = setup();
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { accepted: { network: `eip155:0x${CHAIN_ID.toString(16)}` } }))));
    assert.equal(codeOf(r), E.MALFORMED);
  });

  for (const [label, meta] of [['null', null], ['an array', ['a']], ['a string', 'abc'], ['a non-string value', { a: 1 }]] as const) {
    it(`a price function returning ${label} meta is a seller error, never a throw`, async () => {
      const s = setup({ price: () => ({ amount: PRICE, meta: meta as never }) });
      const r = await s.acceptor.handle(s.req());
      assert.equal(codeOf(r), E.PRICE_ERROR);
    });
  }

  it('refuses new settlements beyond maxInFlight', async () => {
    const s = setup({ maxInFlight: 1 }, { autoMine: false });
    const first = s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: `0x${'01'.repeat(32)}` }))));
    await s.chain.untilSubmitted(1);
    const second = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: `0x${'02'.repeat(32)}` }))));
    assert.equal(second.kind === 'respond' && second.status, 503);
    assert.equal(codeOf(second), E.BUSY);
    s.chain.mine(2);
    assert.equal((await first).kind, 'paid');
    const third = s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: `0x${'02'.repeat(32)}` }))));
    await s.chain.untilSubmitted(2);
    s.chain.mine(2);
    assert.equal((await third).kind, 'paid', 'capacity is free again once the first settles');
  });
});

describe('mutation-check gaps', () => {
  it('a front-run that drained the payer\'s exact balance is settled from, never refused as unfunded', async () => {
    const s = setup();
    s.chain.burn(s.buyer.address);
    s.chain.mint(s.buyer.address, PRICE);
    const header = await payHeader(s.buyer);
    s.chain.externalSubmit(callFrom(header));
    const r = await s.acceptor.handle(s.req(paid(header)));
    assert.ok(r.kind === 'paid');
    assert.equal(r.paid.txHash, s.chain.externalTxs[0]);
  });

  it('a duplicate arriving during the pre-checks (before the row exists) is in progress', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    const pause = s.chain.pauseNextSimulation();
    const first = s.acceptor.handle(s.req(paid(header)));
    await pause.reached;
    const second = await s.acceptor.handle(s.req(paid(header)));
    assert.equal(codeOf(second), E.IN_PROGRESS);
    pause.release();
    assert.equal((await first).kind, 'paid');
  });

  it('a submit that reverts before broadcast keeps the payment open until validBefore, then refuses it as expired', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    s.chain.failNextSubmitRevert = 'ERC20: transfer amount exceeds balance';
    const r = await s.acceptor.handle(s.req(paid(header)));
    assert.equal(r.kind === 'respond' && r.status, 502);
    assert.equal(codeOf(r), E.SUBMIT_FAILED);
    const key = authorizationKey({ chainId: CHAIN_ID, asset: USDC, from: s.buyer.address, nonce: NONCE });
    assert.equal((await s.claims.claim(key, 1)).ok, false);
    assert.equal((await s.ledger.list())[0]?.status, 'owed');
    s.advance(PAST_GRACE_MS);
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.EXPIRED);
    assert.equal((await s.ledger.list())[0]?.status, 'refused');
  });

  it('maxInFlight holds under concurrency: the slot is reserved before the claim is awaited', async () => {
    const s = setup({ maxInFlight: 1 }, { autoMine: false });
    const [a, b] = await Promise.all([
      payHeader(s.buyer, { nonce: `0x${'01'.repeat(32)}` }), payHeader(s.buyer, { nonce: `0x${'02'.repeat(32)}` }),
    ]);
    const both = Promise.all([s.acceptor.handle(s.req(paid(a))), s.acceptor.handle(s.req(paid(b)))]);
    await s.chain.untilSubmitted(1);
    s.chain.mine(2);
    const results = await both;
    assert.equal(results.filter((r) => codeOf(r) === E.BUSY).length, 1);
    assert.equal(s.chain.submissions.length, 1);
  });

  it('a settle that loses a cross-process race to the same outcome still delivers', async () => {
    class RacyLedger extends MemorySellerLedger {
      override async recordSettled(claimKey: string, txHash: string): Promise<never> {
        await super.recordSettled(claimKey, txHash);
        throw new AcceptError(E.LEDGER_TRANSITION, 'another process settled it first');
      }
    }
    const s = setup({}, {}, { ledger: new RacyLedger() });
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    assert.equal(r.kind, 'paid');
  });

  it('a delivery failure in optimistic mode starts no background settlement and frees the slot', async () => {
    class FlakyLedger extends MemorySellerLedger {
      failNext = true;
      override async markDelivered(claimKey: string) {
        if (this.failNext) {
          this.failNext = false;
          throw new Error('db blip');
        }
        return super.markDelivered(claimKey);
      }
    }
    const s = setup(optimistic, { autoMine: false }, { ledger: new FlakyLedger() });
    const header = await payHeader(s.buyer);
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.INTERNAL);
    await s.acceptor.idle();
    s.chain.mine(2);
    const again = await s.acceptor.handle(s.req(paid(header)));
    assert.ok(again.kind === 'paid');
    assert.equal(again.paid.settled, true);
  });
});

describe('re-review gaps', () => {
  it('a payment another process refused between confirmation and settling is never delivered', async () => {
    class RefusingLedger extends MemorySellerLedger {
      override async recordSettled(claimKey: string): Promise<never> {
        await super.recordRefused(claimKey, E.TRANSFER_MISMATCH);
        throw new AcceptError(E.LEDGER_TRANSITION, 'refused by another process');
      }
    }
    const ledger = new RefusingLedger();
    const s = setup({}, {}, { ledger });
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    assert.equal(r.kind === 'respond' && r.status, 502);
    assert.equal(codeOf(r), E.TRANSFER_MISMATCH);
    assert.equal((await ledger.list())[0]?.delivered, false);
  });

  it('resuming a row counts against maxInFlight', async () => {
    const s = setup({ maxInFlight: 1 }, { autoMine: false });
    const b = await payHeader(s.buyer, { nonce: `0x${'0b'.repeat(32)}` });
    s.chain.failNextSubmitTransport = true;
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(b)))), E.SUBMIT_FAILED);
    const a = s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: `0x${'0a'.repeat(32)}` }))));
    await s.chain.untilSubmitted(1);
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(b)))), E.BUSY);
    s.chain.mine(2);
    assert.equal((await a).kind, 'paid');
  });
});

describe('security-review gaps', () => {
  it('a reverted payment is not finalized at validBefore by our clock alone, only after the grace period', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    s.chain.revertNextSubmitOnChain = 'plain';
    await s.acceptor.handle(s.req(paid(header)));
    s.advance(121_000); // just past validBefore by our clock; the chain may still be behind
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.SUBMIT_FAILED);
    assert.equal((await s.ledger.list())[0]?.status, 'submitted');
    s.advance(EXPIRY_GRACE_S * 1000);
    await s.acceptor.handle(s.req(paid(header)));
    assert.equal((await s.ledger.list())[0]?.status, 'refused');
  });

  it('resuming a payment spends the verified payer\'s rate-limit bucket', async () => {
    const s = setup({ rateLimit: { perIpPerMinute: 100, perPayerPerMinute: 2 }, settlementTimeoutMs: 5 }, { autoMine: false });
    const header = await payHeader(s.buyer);
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.SETTLEMENT_TIMEOUT);
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header), { clientIp: '198.51.100.9' }))), E.IN_PROGRESS);
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header), { clientIp: '198.51.100.10' }))), E.RATE_LIMITED);
  });
});

describe('untraceable and bundled uses (santa round 2)', () => {
  it('a stored transaction that never mines, with the authorization used untraceably, is reported at once and on retry', async () => {
    const s = setup({ settlementTimeoutMs: 10 }, { autoMine: false });
    const header = await payHeader(s.buyer);
    const pending = s.acceptor.handle(s.req(paid(header)));
    await s.chain.untilSubmitted(1);
    s.chain.dropPending();
    s.chain.externalSubmit(callFrom(header));
    s.chain.hideAuthorizationUseLogs = true;
    const r = await pending;
    assert.equal(r.kind === 'respond' && r.status, 503);
    assert.equal(codeOf(r), E.SETTLEMENT_UNKNOWN);
    assert.equal(s.errors.filter((e) => e instanceof AcceptError && e.code === E.SETTLEMENT_UNKNOWN).length, 1);
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.IN_PROGRESS);
    assert.equal(s.errors.filter((e) => e instanceof AcceptError && e.code === E.SETTLEMENT_UNKNOWN).length, 2);
    assert.equal((await s.ledger.list())[0]?.status, 'submitted');
  });

  it('an authorization the pre-check finds used with no transaction is reported (the seller may have been paid)', async () => {
    const s = setup();
    s.chain.cancelAuthorization(s.buyer.address, NONCE);
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))))), E.AUTHORIZATION_USED);
    assert.ok(s.errors.some((e) => e instanceof AcceptError && e.code === E.AUTHORIZATION_USED));
  });

  it('a front-runner that bundles another transfer of the payer still settles the payment', async () => {
    const s = setup();
    s.chain.tamperLogs = 'bundled';
    assert.equal((await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))))).kind, 'paid');
  });

  it('a ledger failure while expiring a row is reported, not swallowed', async () => {
    class NoRefuseLedger extends MemorySellerLedger {
      override async recordRefused(): Promise<never> {
        throw new Error('db down');
      }
    }
    const ledger = new NoRefuseLedger();
    const s = setup({}, {}, { ledger });
    const header = await payHeader(s.buyer);
    s.chain.failNextSubmitTransport = true;
    await s.acceptor.handle(s.req(paid(header)));
    s.advance(PAST_GRACE_MS);
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.IN_PROGRESS);
    assert.ok(s.errors.some((e) => e instanceof Error && e.message === 'db down'));
  });
});

describe('dropped transactions (santa round 1)', () => {
  it('first request: our transaction is dropped and a front-runner settles it — follow theirs and deliver', async () => {
    const s = setup({ settlementTimeoutMs: 20 }, { autoMine: false });
    const header = await payHeader(s.buyer);
    const pending = s.acceptor.handle(s.req(paid(header)));
    await s.chain.untilSubmitted(1);
    s.chain.dropPending();
    const theirs = s.chain.externalSubmit(callFrom(header));
    s.chain.mine(2);
    const r = await pending;
    assert.ok(r.kind === 'paid');
    assert.equal(r.paid.txHash, theirs);
  });

  it('retry: a stored transaction that never mined is followed to the front-runner that settled it', async () => {
    const s = setup({ settlementTimeoutMs: 10 }, { autoMine: false });
    const header = await payHeader(s.buyer);
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.SETTLEMENT_TIMEOUT);
    s.chain.dropPending();
    const theirs = s.chain.externalSubmit(callFrom(header));
    s.chain.mine(2);
    const again = await s.acceptor.handle(s.req(paid(header)));
    assert.ok(again.kind === 'paid');
    assert.equal(again.paid.txHash, theirs);
  });

  it('retry: a stored transaction that never mined, unused past validBefore + grace, is refused as expired', async () => {
    const s = setup({ settlementTimeoutMs: 10 }, { autoMine: false });
    const header = await payHeader(s.buyer);
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.SETTLEMENT_TIMEOUT);
    s.chain.dropPending();
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.IN_PROGRESS, 'not before the deadline');
    s.advance(PAST_GRACE_MS);
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.EXPIRED);
    assert.equal((await s.ledger.list())[0]?.status, 'refused');
  });

  it('a used authorization whose transaction cannot be found is reported for reconciliation, never delivered or refused', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    s.chain.failNextSubmitTransport = true;
    await s.acceptor.handle(s.req(paid(header)));
    s.chain.externalSubmit(callFrom(header));
    s.chain.hideAuthorizationUseLogs = true;
    s.advance(PAST_GRACE_MS);
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.IN_PROGRESS);
    assert.equal((await s.ledger.list())[0]?.status, 'owed');
    assert.ok(s.errors.some((e) => e instanceof AcceptError && e.code === E.SETTLEMENT_UNKNOWN));
  });
});

describe('boundaries', () => {
  it('a paid upload whose Content-Length equals the priced size is accepted; a missing one is refused', async () => {
    const s = setup({ price: () => ({ amount: PRICE, contentLength: 100 }) });
    const ok = await s.acceptor.handle(s.req({ ...paid(await payHeader(s.buyer, { nonce: `0x${'01'.repeat(32)}` })), 'content-length': '100' }, { method: 'PUT' }));
    assert.equal(ok.kind, 'paid');
    const missing = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: `0x${'02'.repeat(32)}` })), { method: 'PUT' }));
    assert.equal(codeOf(missing), E.PRICE_MISMATCH);
  });

  it('optimistic delivery at exactly maxUsd, and not one atomic unit above', async () => {
    const at = setup({ ...optimistic, price: () => ({ amount: 500_000n }) }, { autoMine: false });
    const r1 = await at.acceptor.handle(at.req(paid(await payHeader(at.buyer, { value: 500_000n, accepted: { amount: '500000' } }))));
    assert.ok(r1.kind === 'paid' && !r1.paid.settled);
    const above = setup({ ...optimistic, price: () => ({ amount: 500_001n }) }, { autoMine: false });
    const pending = above.acceptor.handle(above.req(paid(await payHeader(above.buyer, { value: 500_001n, accepted: { amount: '500001' } }))));
    await above.chain.untilSubmitted(1);
    above.chain.mine(2);
    const r2 = await pending;
    assert.ok(r2.kind === 'paid' && r2.paid.settled);
  });

  for (const method of ['PUT', 'DELETE']) {
    it(`never delivers optimistically for ${method}`, async () => {
      const s = setup(optimistic, { autoMine: false });
      let done = false;
      const pending = s.acceptor.handle(s.req(paid(await payHeader(s.buyer)), { method })).then((r) => { done = true; return r; });
      await s.chain.untilSubmitted(1);
      for (let i = 0; i < 20; i++) await tick();
      assert.equal(done, false, 'waits for confirmations');
      s.chain.mine(2);
      const r = await pending;
      assert.ok(r.kind === 'paid' && r.paid.settled);
    });
  }

  it('accepts a window of exactly 300 s; refuses validAfter == now and an overpayment', async () => {
    const s = setup();
    assert.equal((await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: `0x${'01'.repeat(32)}`, validBefore: BigInt(NOW_S + 300) }))))).kind, 'paid');
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: `0x${'02'.repeat(32)}`, validAfter: BigInt(NOW_S) }))))), E.NOT_YET_VALID);
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: `0x${'03'.repeat(32)}`, value: PRICE + 1n }))))), E.AMOUNT_MISMATCH);
  });

  it('a 65-byte signature that recovers to someone else is BAD_SIGNATURE, not PAYER_NO_CODE', async () => {
    const s = setup();
    const other = privateKeyToAccount(generatePrivateKey());
    const theirs = b64decode<{ payload: { signature: string } }>(await payHeader(other));
    const mine = b64decode<{ payload: { signature: string } }>(await payHeader(s.buyer));
    const swapped = Buffer.from(JSON.stringify({ ...mine, payload: { ...mine.payload, signature: theirs.payload.signature } })).toString('base64');
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(swapped)))), E.BAD_SIGNATURE);
  });

  it('a front-run before the request still settles once', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    s.chain.externalSubmit(callFrom(header));
    assert.equal((await s.acceptor.handle(s.req(paid(header)))).kind, 'paid');
    assert.equal(s.chain.balanceOfSync(PAY_TO), PRICE);
  });
});
