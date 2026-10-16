import assert from 'node:assert/strict';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import {
  AcceptError, AcceptErrorCode as E, type ExpressRequest, type ExpressResponse, MemorySellerLedger, type NewSellerPayment, type SellerLedgerPort,
  expressPayment, nodeHandler, redactUrls,
} from '../src/index.js';
import { SqliteSellerLedger, openSqlite } from '../src/sqlite/index.js';
import { CHAIN_ID, NOW_S, PAY_TO, PRICE, USDC, payHeader, setup, tick } from './helpers.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The ledger write after a response finishes is async: give it a few turns. */
async function eventually(check: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 50; i += 1) {
    if (await check()) return true;
    await tick();
  }
  return false;
}

describe('deferred delivery', () => {
  it('leaves the row undelivered until confirmDelivery, then a retry is a replay', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    const r = await s.acceptor.handle(s.req({ 'payment-signature': header }), { deferDelivery: true });
    assert.equal(r.kind, 'paid');
    if (r.kind !== 'paid') return;
    assert.equal(r.paid.replayed, false);
    assert.equal((await s.ledger.get(r.paid.claimKey))?.delivered, false, 'not delivered before the seller confirms');

    const again = await s.acceptor.handle(s.req({ 'payment-signature': header }), { deferDelivery: true });
    assert.equal(again.kind === 'paid' && again.paid.replayed, false, 'an unconfirmed delivery is handed out again, not as a replay');

    assert.deepEqual(await s.acceptor.confirmDelivery(r.paid.claimKey), { first: true });
    assert.deepEqual(await s.acceptor.confirmDelivery(r.paid.claimKey), { first: false });
    const replay = await s.acceptor.handle(s.req({ 'payment-signature': header }), { deferDelivery: true });
    assert.equal(replay.kind === 'paid' && replay.paid.replayed, true);
  });

  it('keeps marking delivery inside handle by default', async () => {
    const s = setup();
    const r = await s.acceptor.handle(s.req({ 'payment-signature': await payHeader(s.buyer) }));
    assert.equal(r.kind, 'paid');
    if (r.kind === 'paid') assert.equal((await s.ledger.get(r.paid.claimKey))?.delivered, true);
  });

  it('adapters keep 0.1 at-most-once by default: parallel requests with one header run the route once unreplayed', async () => {
    const s = setup();
    const replayed: boolean[] = [];
    const url = await listen(nodeHandler(s.acceptor, async (_req, res, paid) => {
      replayed.push(paid.replayed);
      await tick();
      res.end('ok');
    }));
    const header = await payHeader(s.buyer);
    await Promise.all(Array.from({ length: 5 }, () => fetch(`${url}/rates`, { headers: { 'payment-signature': header } })));
    assert.equal(replayed.filter((r) => !r).length, 1);
    assert.equal(s.chain.submissions.length, 1);
  });

  it('nodeHandler with deferDelivery marks delivery only after onPaid succeeds', async () => {
    const s = setup();
    let fail = true;
    const url = await listen(nodeHandler(s.acceptor, (_req, res) => {
      if (fail) throw new Error('seller write failed');
      res.end('ok');
    }, { deferDelivery: true }));
    const header = await payHeader(s.buyer);
    const first = await fetch(`${url}/rates`, { headers: { 'payment-signature': header } });
    assert.equal(first.status, 500);
    const [row] = await s.ledger.list();
    assert.equal(row?.status, 'settled');
    assert.equal(row?.delivered, false, 'a failed delivery stays owed to the payer');
    assert.deepEqual((await s.ledger.undelivered()).map((x) => x.claimKey), [row?.claimKey]);

    fail = false;
    const retry = await fetch(`${url}/rates`, { headers: { 'payment-signature': header } });
    assert.equal(retry.status, 200);
    assert.ok(await eventually(async () => (await s.ledger.get(row!.claimKey))?.delivered === true));
    assert.equal(s.chain.submissions.length, 1, 'the retry did not pay again');
  });

  it('nodeHandler with deferDelivery does not count an error status, and waits for a late finish', async () => {
    const s = setup();
    let mode: 'error' | 'late' = 'error';
    let finishLate: () => void = () => undefined;
    const url = await listen(nodeHandler(s.acceptor, (_req, res) => {
      if (mode === 'error') return void res.writeHead(500).end();
      res.writeHead(200);
      finishLate = () => res.end('ok'); // onPaid returns before the response is finished
    }, { deferDelivery: true }));
    const header = await payHeader(s.buyer);
    assert.equal((await fetch(`${url}/rates`, { headers: { 'payment-signature': header } })).status, 500);
    const [row] = await s.ledger.list();
    await tick();
    assert.equal((await s.ledger.get(row!.claimKey))?.delivered, false, 'a 500 is not a delivery');

    mode = 'late';
    const pending = fetch(`${url}/rates`, { headers: { 'payment-signature': header } });
    await new Promise((r) => setTimeout(r, 50)); // the request has reached onPaid and settled by now
    assert.equal((await s.ledger.get(row!.claimKey))?.delivered, false, 'not before the response finished');
    finishLate();
    assert.equal((await pending).status, 200);
    assert.ok(await eventually(async () => (await s.ledger.get(row!.claimKey))?.delivered === true));
  });

  it('expressPayment with deferDelivery marks delivery only once the route answered below 400', async () => {
    const s = setup();
    let status = 500;
    const url = await listen((rawReq, rawRes) => {
      const req = rawReq as ExpressRequest;
      const res = rawRes as ExpressResponse;
      req.originalUrl = req.url ?? '/';
      res.locals = {};
      expressPayment(s.acceptor, { deferDelivery: true })(req, res, () => res.writeHead(status).end());
    });
    const header = await payHeader(s.buyer);
    assert.equal((await fetch(`${url}/rates`, { headers: { 'payment-signature': header } })).status, 500);
    const [row] = await s.ledger.list();
    await tick();
    assert.equal((await s.ledger.get(row!.claimKey))?.delivered, false);

    status = 200;
    assert.equal((await fetch(`${url}/rates`, { headers: { 'payment-signature': header } })).status, 200);
    assert.ok(await eventually(async () => (await s.ledger.get(row!.claimKey))?.delivered === true));
  });
});

describe('lookup', () => {
  it('finds the stored row for a payment header, so a retry can be priced as it was paid', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    assert.equal(await s.acceptor.lookup(header), undefined, 'nothing stored yet');
    const r = await s.acceptor.handle(s.req({ 'payment-signature': header }), { price: { amount: PRICE, meta: { until: '1' } } });
    assert.equal(r.kind, 'paid');
    const row = await s.acceptor.lookup(header);
    assert.equal(row?.amount, PRICE.toString());
    assert.deepEqual(row?.meta, { until: '1' });

    const retry = await s.acceptor.handle(s.req({ 'payment-signature': header }), { price: { amount: BigInt(row!.amount), meta: row!.meta } });
    assert.equal(retry.kind === 'paid' && retry.paid.replayed, true);
  });

  it('ignores a different header for the same nonce, and garbage', async () => {
    const s = setup();
    await s.acceptor.handle(s.req({ 'payment-signature': await payHeader(s.buyer) }));
    const other = await payHeader(s.buyer, { validBefore: BigInt(NOW_S + 100) }); // same nonce, other signature
    assert.equal(await s.acceptor.lookup(other), undefined);
    assert.equal(await s.acceptor.lookup('not base64 json'), undefined);
  });
});

describe('onError redaction', () => {
  it('cuts URLs to scheme and host in the message and the cause, keeping the error type and code', () => {
    const s = setup();
    const cause = new Error('HTTP request failed. URL: https://base-sepolia.g.alchemy.com/v2/SECRETKEY?x=1');
    const original = new AcceptError(E.SUBMIT_FAILED, 'via https://user:pw@rpc.example/key', { cause });
    s.acceptor.reportError(original);
    const [got] = s.errors as AcceptError[];
    assert.ok(got instanceof AcceptError);
    assert.equal(got.code, E.SUBMIT_FAILED);
    assert.equal(got.message, 'via https://rpc.example');
    assert.equal((got.cause as Error).message, 'HTTP request failed. URL: https://base-sepolia.g.alchemy.com');
    assert.doesNotMatch(String(got.stack), /SECRETKEY|pw@/);
    assert.match(cause.message, /SECRETKEY/, 'the original error is not changed');
  });

  it('redacts URL-bearing properties viem sets (url, details, metaMessages)', () => {
    const s = setup();
    const viemLike = Object.assign(new Error('boom'), { url: 'https://rpc.example/key', details: 'at https://rpc.example/key', metaMessages: ['URL: https://rpc.example/key'] });
    s.acceptor.reportError(viemLike);
    const got = s.errors[0] as Error & { url: string; details: string; metaMessages: string[] };
    assert.equal(got.url, 'https://rpc.example');
    assert.equal(got.details, 'at https://rpc.example');
    assert.deepEqual(got.metaMessages, ['URL: https://rpc.example']);
  });

  it('recurses into plain objects, drops headers/body/request, survives cycles and thrown non-errors', () => {
    const s = setup();
    const viemLike = Object.assign(new Error('HTTP request failed'), {
      headers: { Authorization: 'Bearer SECRETTOKEN' },
      body: { method: 'eth_sendRawTransaction' },
      request: { url: 'https://rpc.example/key' },
      meta: { endpoint: { url: 'https://rpc.example/v3/SECRETKEY' } },
    });
    (viemLike as unknown as { self: unknown }).self = viemLike;
    s.acceptor.reportError(new AcceptError(E.RPC_UNAVAILABLE, 'rpc down', { cause: viemLike }));
    const cause = (s.errors[0] as AcceptError).cause as Record<string, unknown>;
    assert.doesNotMatch(JSON.stringify(cause), /SECRET/);
    assert.equal(cause.headers, undefined);
    assert.equal(cause.body, undefined);
    assert.equal(cause.request, undefined);
    assert.deepEqual(cause.meta, { endpoint: { url: 'https://rpc.example' } });
    assert.equal(cause.self, '[circular]');

    s.acceptor.reportError({ message: 'thrown object at https://rpc.example/key', headers: { authorization: 'x' } });
    s.acceptor.reportError('thrown string https://rpc.example/key');
    assert.deepEqual(s.errors.slice(1), [{ message: 'thrown object at https://rpc.example' }, 'thrown string https://rpc.example']);
  });

  it('redactUrls is exported for sellers logging their own errors', () => {
    assert.equal(redactUrls('see wss://node.example:8546/abc/def and http://x.test/?k=1'), 'see wss://node.example:8546 and http://x.test');
  });
});

const row = (claimKey: string, validBefore: string): NewSellerPayment => ({
  claimKey, sellerAccountId: 'seller-1', protocol: 'x402', chainId: CHAIN_ID, asset: USDC, payer: PAY_TO,
  nonce: `0x${'11'.repeat(32)}`, amount: '10000', payTo: PAY_TO, validBefore, method: 'GET', path: '/rates', queryDigest: '',
  headerDigest: 'd1', meta: {},
});
const TX = `0x${'aa'.repeat(32)}`;

const LEDGERS: readonly [string, () => MemorySellerLedger | SqliteSellerLedger][] = [
  ['MemorySellerLedger', () => new MemorySellerLedger()],
  ['SqliteSellerLedger', () => new SqliteSellerLedger(openSqlite(':memory:'))],
];

/** owed, settled-undelivered, settled-delivered and refused rows, all with validBefore 100 except `fresh`. */
async function seed(l: SellerLedgerPort): Promise<void> {
  for (const k of ['owed', 'owing', 'done', 'refused', 'fresh']) await l.recordVerified(row(k, k === 'fresh' ? '300' : '100'));
  await l.recordSettled('owing', TX);
  await l.recordSettled('done', TX);
  await l.markDelivered('done');
  await l.recordRefused('refused', E.EXPIRED);
  await l.recordSettled('fresh', TX);
  await l.markDelivered('fresh');
}

for (const [name, make] of LEDGERS) describe(`${name} undelivered and prune`, () => {
  it('lists only settled rows not yet delivered', async () => {
    const l = make();
    await seed(l);
    assert.deepEqual((await l.undelivered()).map((x) => x.claimKey), ['owing']);
  });

  it('prunes finished rows older than the cutoff, never open or still-owed ones', async () => {
    const l = make();
    await seed(l);
    assert.equal(await l.prune(200), 2);
    assert.deepEqual((await l.list()).map((x) => x.claimKey).sort(), ['fresh', 'owed', 'owing']);
    assert.equal(await l.prune(200), 0);
    assert.equal(await l.prune(400), 1, 'fresh goes once the cutoff passes it');
  });

  it('refuses a cutoff in the future or in milliseconds', async () => {
    const l = make();
    await seed(l);
    await assert.rejects(l.prune(Date.now()), { code: E.CONFIG_INVALID });
    await assert.rejects(l.prune(Math.floor(Date.now() / 1000) + 60), { code: E.CONFIG_INVALID });
    await assert.rejects(l.prune(-1), { code: E.CONFIG_INVALID });
    assert.equal((await l.list()).length, 5, 'nothing deleted');
  });
});
