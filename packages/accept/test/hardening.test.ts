import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import type { Hex } from 'viem';
import { b64decode } from 'agentpay-hub/protocol';
import {
  AcceptError, AcceptErrorCode as E, EXPIRY_GRACE_S, MemoryRateLimiter, MemorySellerLedger, type TransferCall, accept, nodeHandler,
} from '../src/index.js';
import { CHAIN_ID, NOW_S, PAY_TO, PRICE, USDC, codeOf, payHeader, setup, tick } from './helpers.js';

const paid = (h: string) => ({ 'payment-signature': h });
const optimistic = { optimistic: { maxUsd: '0.50', readOnly: true as const } };
const PAST_GRACE_MS = (120 + EXPIRY_GRACE_S + 1) * 1000;
const nonce = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;
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
const codesOf = (errors: unknown[]) => errors.map((e) => (e instanceof AcceptError ? e.code : 'raw'));

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe('a failed delivery is reported', () => {
  it('onPaid throwing reaches onError as DELIVERY_FAILED with the claim key; the payer gets a bare 500', async () => {
    const s = setup();
    const server = createServer(nodeHandler(s.acceptor, () => { throw new Error('render failed'); }));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rates`;
    const res = await fetch(url, { headers: paid(await payHeader(s.buyer)) });
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('payment-response'), null);
    assert.deepEqual(codesOf(s.errors), [E.DELIVERY_FAILED]);
    const [row] = await s.ledger.list();
    const err = s.errors[0] as AcceptError;
    assert.ok(row && err.message.includes(row.claimKey));
    assert.equal((err.cause as Error).message, 'render failed');
  });

  it('reportError routes to onError, and survives an onError that throws', () => {
    const s = setup();
    s.acceptor.reportError(new Error('x'));
    assert.equal(s.errors.length, 1);
    const t = setup({}, {}, { onError: () => { throw new Error('logger down'); } });
    t.acceptor.reportError(new Error('x'));
  });
});

describe('rate-limit buckets cannot be multiplied', () => {
  it('IPv6 clients share a bucket per /64', async () => {
    const s = setup({ rateLimit: { perIpPerMinute: 1 } });
    const h = paid(await payHeader(s.buyer));
    await s.acceptor.handle(s.req(h, { clientIp: '2001:db8:1:2::1' }));
    const r = await s.acceptor.handle(s.req(h, { clientIp: '2001:db8:1:2:ffff:ffff:ffff:fffe' }));
    assert.equal(codeOf(r), E.RATE_LIMITED);
    const other = await s.acceptor.handle(s.req(h, { clientIp: '2001:db8:1:3::1' }));
    assert.notEqual(codeOf(other), E.RATE_LIMITED);
  });

  it('an IPv4-mapped IPv6 address shares the IPv4 bucket', async () => {
    const s = setup({ rateLimit: { perIpPerMinute: 1 } });
    const h = paid(await payHeader(s.buyer));
    await s.acceptor.handle(s.req(h, { clientIp: '203.0.113.9' }));
    assert.equal(codeOf(await s.acceptor.handle(s.req(h, { clientIp: '::ffff:203.0.113.9' }))), E.RATE_LIMITED);
  });

  it('a full limiter evicts its oldest key instead of refusing everyone new', () => {
    const rl = new MemoryRateLimiter({ maxKeys: 2 });
    assert.equal(rl.take('a', 5, 0), true);
    assert.equal(rl.take('b', 5, 0), true);
    assert.equal(rl.take('c', 5, 0), true);
    assert.equal(rl.take('b', 2, 0), true);
    assert.equal(rl.take('b', 2, 0), false, 'b was kept, with its count');
    assert.equal(rl.take('a', 1, 0), true, 'a was evicted, so it starts over');
  });
});

describe('ambiguous outcomes are reported with their cause', () => {
  it('a submit that failed in transport after broadcast is reported as SUBMIT_FAILED', async () => {
    const s = setup();
    s.chain.failNextSubmitTransport = 'after-broadcast';
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    assert.equal(codeOf(r), E.SUBMIT_FAILED);
    assert.deepEqual(codesOf(s.errors), [E.SUBMIT_FAILED]);
    assert.match(((s.errors[0] as AcceptError).cause as Error).message, /ECONNRESET/);
  });

  it('a mined transfer that measures wrong is refused with its txHash kept, and reported', async () => {
    const s = setup();
    s.chain.tamperLogs = 'to';
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    assert.equal(codeOf(r), E.TRANSFER_MISMATCH);
    const [row] = await s.ledger.list();
    assert.equal(row?.status, 'refused');
    assert.equal(row?.txHash, s.chain.submissions[0]);
    assert.deepEqual(codesOf(s.errors), [E.TRANSFER_MISMATCH]);
  });

  it('a settlement that timed out on RPC errors is reported with the last one', async () => {
    const s = setup({ settlementTimeoutMs: 5 }, { autoMine: false });
    const pending = s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    await s.chain.untilSubmitted(1);
    s.chain.failRpc = true;
    assert.equal(codeOf(await pending), E.SETTLEMENT_TIMEOUT);
    assert.deepEqual(codesOf(s.errors), [E.SETTLEMENT_TIMEOUT]);
    assert.equal(((s.errors[0] as AcceptError).cause as Error).message, 'rpc unavailable');
  });

  it('a plain timeout with a healthy RPC is not an error', async () => {
    const s = setup({ settlementTimeoutMs: 5 }, { autoMine: false });
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))))), E.SETTLEMENT_TIMEOUT);
    assert.deepEqual(s.errors, []);
  });

  it('a broadcast whose recordSubmitted fails still settles, and the txHash is reported', async () => {
    class LosingLedger extends MemorySellerLedger {
      override async recordSubmitted(): Promise<never> {
        throw new Error('db blip');
      }
    }
    const s = setup({}, {}, { ledger: new LosingLedger() });
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    assert.ok(r.kind === 'paid' && r.paid.settled);
    assert.deepEqual(codesOf(s.errors), [E.INTERNAL]);
    assert.ok((s.errors[0] as AcceptError).message.includes(s.chain.submissions[0] ?? 'x'));
  });

  it('an async onError that rejects becomes a process warning, not an unhandled rejection', async () => {
    const warned = new Promise<Error>((resolve) => process.once('warning', resolve));
    const s = setup({}, {}, { onError: async () => { throw new Error('logger down'); } });
    s.acceptor.reportError(new Error('x'));
    const w = await warned;
    assert.equal((w as Error & { code?: string }).code, 'ZOLD_ACCEPT_ONERROR');
    assert.doesNotMatch(w.message, /logger down/);
  });
});

describe('mutation gaps', () => {
  it('a front-run that measures wrong is refused with the front-runner\'s txHash kept', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    s.chain.tamperLogs = 'to';
    s.chain.externalSubmit(callFrom(header));
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.TRANSFER_MISMATCH);
    const [row] = await s.ledger.list();
    assert.equal(row?.status, 'refused');
    assert.equal(row?.txHash, s.chain.externalTxs[0]);
  });

  it('a timeout where only receipt reads failed is reported with that cause', async () => {
    const s = setup({ settlementTimeoutMs: 5 }, { autoMine: false });
    const pending = s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    await s.chain.untilSubmitted(1);
    s.chain.failReceipts = true;
    assert.equal(codeOf(await pending), E.SETTLEMENT_TIMEOUT);
    assert.equal(((s.errors[0] as AcceptError).cause as Error).message, 'receipt unavailable');
  });

  it('past the deadline, a row is not expired unless the authorization reads unused right now', async () => {
    const s = setup({ settlementTimeoutMs: 5 }, { autoMine: false });
    const header = await payHeader(s.buyer);
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.SETTLEMENT_TIMEOUT);
    s.chain.dropPending();
    s.advance(PAST_GRACE_MS);
    s.chain.failRpc = true;
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.IN_PROGRESS);
    assert.equal((await s.ledger.list())[0]?.status, 'submitted');
    s.chain.failRpc = false;
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.EXPIRED);
  });

  it('a final failure found while resuming refuses the row', async () => {
    const s = setup({ settlementTimeoutMs: 5 }, { autoMine: false });
    const header = await payHeader(s.buyer);
    s.chain.tamperLogs = 'to';
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.SETTLEMENT_TIMEOUT);
    s.chain.mine(2);
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.TRANSFER_MISMATCH);
    assert.equal((await s.ledger.list())[0]?.status, 'refused');
  });
});

describe('a stranded payment is resubmitted', () => {
  it('a broadcast that reverted before sending is retried on the next request with the same header', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    s.chain.failNextSubmitRevert = 'replacement underpriced';
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.SUBMIT_FAILED);
    assert.equal((await s.ledger.list())[0]?.status, 'owed');
    const again = await s.acceptor.handle(s.req(paid(header)));
    assert.ok(again.kind === 'paid' && again.paid.settled);
    assert.equal(s.chain.balanceOfSync(PAY_TO), PRICE);
  });

  it('a resubmit that cannot pay now leaves the row open (the payer may still fund it)', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    s.chain.failNextSubmitRevert = 'nonce too low';
    await s.acceptor.handle(s.req(paid(header)));
    s.chain.burn(s.buyer.address);
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.INSUFFICIENT_FUNDS);
    assert.equal((await s.ledger.list())[0]?.status, 'owed');
    s.chain.mint(s.buyer.address, PRICE);
    assert.equal((await s.acceptor.handle(s.req(paid(header)))).kind, 'paid');
  });
});

describe('the path that was priced is the path that is served', () => {
  for (const path of ['/%70remium', '/a;b', '/a%2Fb', '/a%7e', '/a%3a', '/caf%c3%a9']) {
    it(`refuses ${path}`, async () => {
      const s = setup();
      assert.equal(codeOf(await s.acceptor.handle(s.req({}, { path }))), E.MALFORMED);
    });
  }

  it('accepts reserved characters percent-encoded in upper case', async () => {
    const s = setup();
    const r = await s.acceptor.handle(s.req({}, { path: '/files/a%20b%3F/caf%C3%A9' }));
    assert.equal(codeOf(r), E.PAYMENT_REQUIRED);
  });

  it('PaidContext carries the method and path that were priced', async () => {
    const s = setup();
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer)), { method: 'HEAD', path: '/rates/eur' }));
    assert.ok(r.kind === 'paid');
    assert.equal(r.paid.method, 'HEAD');
    assert.equal(r.paid.path, '/rates/eur');
  });
});

describe('a payer cannot sign more than it holds', () => {
  it('a second payment is refused while the first is unsettled and the balance only covers one', async () => {
    const s = setup({}, { autoMine: false });
    s.chain.burn(s.buyer.address);
    s.chain.mint(s.buyer.address, PRICE);
    const first = s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: nonce(1) }))));
    await s.chain.untilSubmitted(1);
    const second = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: nonce(2) }))));
    assert.equal(codeOf(second), E.INSUFFICIENT_FUNDS);
    assert.equal(s.chain.submissions.length, 1);
    s.chain.mine(2);
    assert.equal((await first).kind, 'paid');
    const third = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: nonce(3) }))));
    assert.equal(codeOf(third), E.INSUFFICIENT_FUNDS, 'settled: the balance is now spent');
  });

  it('a settled payment frees its hold, so the next is checked against the balance only', async () => {
    const s = setup();
    s.chain.burn(s.buyer.address);
    s.chain.mint(s.buyer.address, 2n * PRICE);
    assert.equal((await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: nonce(1) }))))).kind, 'paid');
    assert.equal((await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: nonce(2) }))))).kind, 'paid');
  });

  it('an optimistic payment settled in the background frees its hold', async () => {
    const s = setup(optimistic, { autoMine: false });
    const first = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: nonce(1) }))));
    assert.ok(first.kind === 'paid' && !first.paid.settled);
    s.chain.mine(2);
    await s.acceptor.idle();
    const second = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: nonce(2) }))));
    assert.ok(second.kind === 'paid' && !second.paid.settled, 'optimistic again: nothing else is unsettled');
    s.chain.mine(2);
    await s.acceptor.idle();
  });

  it('no optimistic delivery while the payer already has one unsettled', async () => {
    const s = setup(optimistic, { autoMine: false });
    const first = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: nonce(1) }))));
    assert.ok(first.kind === 'paid' && !first.paid.settled);
    let done = false;
    const second = s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { nonce: nonce(2) })))).finally(() => { done = true; });
    await s.chain.untilSubmitted(2);
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(done, false, 'waits for its confirmation');
    s.chain.mine(2);
    const r = await second;
    assert.ok(r.kind === 'paid' && r.paid.settled);
    await s.acceptor.idle();
  });
});

describe('small fixes', () => {
  it('every response says Cache-Control: no-store', async () => {
    const s = setup();
    const offer = await s.acceptor.handle(s.req());
    assert.equal(offer.headers['cache-control'], 'no-store');
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  it('an optimistic delivery carries no PAYMENT-RESPONSE until it settles', async () => {
    const s = setup(optimistic, { autoMine: false });
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    assert.ok(r.kind === 'paid' && !r.paid.settled);
    assert.equal(r.headers['PAYMENT-RESPONSE'], undefined);
    s.chain.mine(2);
    await s.acceptor.idle();
  });

  it('a row keeps its payTo, so a payee change does not refuse payments already in flight', async () => {
    const s = setup({ settlementTimeoutMs: 5 }, { autoMine: false });
    const header = await payHeader(s.buyer);
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.SETTLEMENT_TIMEOUT);
    assert.equal((await s.ledger.list())[0]?.payTo, PAY_TO);
    const moved = accept({ ...s.options, payTo: `0x${'be'.repeat(20)}` }, {
      ledger: s.ledger, claims: s.claims, chain: s.chain, submitter: s.chain, rateLimiter: new MemoryRateLimiter(),
      now: () => NOW_S * 1000, sleep: tick, onError: () => undefined,
    });
    s.chain.mine(2);
    const again = await moved.handle(s.req(paid(header)));
    assert.ok(again.kind === 'paid' && again.paid.settled);
  });

  it('a replay matches meta whatever order its keys come in', async () => {
    let flip = false;
    const s = setup({
      price: () => {
        flip = !flip;
        return { amount: PRICE, meta: flip ? { a: 'b,c', 'a,b': 'c' } : { 'a,b': 'c', a: 'b,c' } };
      },
    });
    const header = await payHeader(s.buyer);
    assert.equal((await s.acceptor.handle(s.req(paid(header)))).kind, 'paid');
    const again = await s.acceptor.handle(s.req(paid(header)));
    assert.ok(again.kind === 'paid' && again.paid.replayed);
  });

  it('a chain id beyond the safe integer range is malformed', async () => {
    const s = setup();
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { accepted: { network: 'eip155:9999999999999999' } }))));
    assert.equal(codeOf(r), E.MALFORMED);
  });

  it('a settled PAYMENT-RESPONSE still names the transaction', async () => {
    const s = setup();
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    assert.ok(r.kind === 'paid');
    const receipt = b64decode<Record<string, unknown>>(r.headers['PAYMENT-RESPONSE'] ?? '');
    assert.equal(receipt.transaction, s.chain.submissions[0]);
    assert.equal(receipt.network, `eip155:${CHAIN_ID}`);
  });
});
