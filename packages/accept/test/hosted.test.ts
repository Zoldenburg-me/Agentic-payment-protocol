import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import { b64decode } from 'agentpay-hub/protocol';
import {
  AcceptError, AcceptErrorCode as E, type AcceptResult, type Acceptor, type SettleRequest, hostedSettle, nodeHandler, zoldSeller,
} from '../src/index.js';
import { decodeResult } from '../src/hosted/wire.js';
import { PAY_TO, PRICE, codeOf, payHeader, setup } from './helpers.js';

const KEY = `zsk_seller1_${'k'.repeat(32)}`;
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const readJson = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

/** A Zold-like API: the settle route is just `hostedSettle` behind an HTTP server. */
async function zold(acceptor: Acceptor, seen: unknown[] = []): Promise<string> {
  const settle = hostedSettle({ acceptorFor: (key) => (key === KEY ? acceptor : undefined), onError: () => undefined });
  return listen(async (req, res) => {
    const body = await readJson(req).catch(() => undefined);
    seen.push(body);
    const out = await settle({ authorization: req.headers.authorization, body });
    res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.body));
  });
}

function sellerOf(apiUrl: string, over: Record<string, unknown> = {}) {
  const errors: unknown[] = [];
  const handler = zoldSeller({
    apiUrl, apiKey: KEY, price: () => ({ amount: PRICE }), onError: (e: unknown) => { errors.push(e); }, timeoutMs: 2_000, ...over,
  } as never);
  return { handler, errors };
}

const get = (headers: Record<string, string> = {}) => ({ method: 'GET', path: '/files', query: '', headers, clientIp: '203.0.113.7' });

describe('hosted settlement: zoldSeller with hostedSettle', () => {
  it('end to end: a 402 offer naming the seller\'s Zold payee, then a paid request settled by Zold', async () => {
    const z = setup();
    const { handler } = sellerOf(await zold(z.acceptor));
    const shop = await listen(nodeHandler(handler, (_req, res, paid) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ claimKey: paid.claimKey, payer: paid.payer }));
    }));
    const offer = await fetch(`${shop}/files`);
    assert.equal(offer.status, 402);
    const required = b64decode<{ accepts: { payTo: string }[] }>(offer.headers.get('payment-required') ?? '');
    assert.equal(required.accepts[0]?.payTo, PAY_TO, 'the payee comes from Zold, not from the seller');
    const res = await fetch(`${shop}/files`, { headers: { 'payment-signature': await payHeader(z.buyer) } });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('payment-response'));
    const body = (await res.json()) as { claimKey: string; payer: string };
    assert.equal(body.payer, z.buyer.address);
    assert.equal((await z.ledger.get(body.claimKey))?.status, 'settled');
    assert.equal(z.chain.balanceOfSync(PAY_TO), PRICE);
  });

  it('a retry of a delivered payment comes back as replayed, with the same claim key', async () => {
    const z = setup();
    const { handler } = sellerOf(await zold(z.acceptor));
    const header = await payHeader(z.buyer);
    const first = await handler.handle(get({ 'payment-signature': header }));
    const again = await handler.handle(get({ 'payment-signature': header }));
    assert.ok(first.kind === 'paid' && again.kind === 'paid');
    assert.equal(again.paid.replayed, true);
    assert.equal(again.paid.claimKey, first.paid.claimKey);
    assert.equal(again.paid.amount, PRICE);
  });

  it('forwards only what payment needs: never cookies or other headers', async () => {
    const z = setup();
    const seen: unknown[] = [];
    const { handler } = sellerOf(await zold(z.acceptor, seen));
    await handler.handle({
      method: 'GET', path: '/files', query: 'a=1', clientIp: '203.0.113.7',
      headers: { cookie: 'session=secret', 'x-api-key': 'k', authorization: 'Bearer user-token', 'content-length': '0' },
    });
    const sent = seen[0] as SettleRequest;
    assert.deepEqual(Object.keys(sent.request.headers).sort(), ['content-length']);
    assert.doesNotMatch(JSON.stringify(sent), /secret|user-token/);
  });

  it('forwards an Authorization header only when it is an MPP Payment credential', async () => {
    const z = setup();
    const seen: unknown[] = [];
    const { handler } = sellerOf(await zold(z.acceptor, seen));
    await handler.handle(get({ authorization: 'Payment abc' }));
    assert.equal((seen[0] as SettleRequest).request.headers.authorization, 'Payment abc');
  });

  it('Zold settles at the seller\'s price, not a fixed one', async () => {
    const z = setup();
    const { handler } = sellerOf(await zold(z.acceptor), { price: () => ({ amount: 5_000n }) });
    const r = await handler.handle(get());
    const required = b64decode<{ accepts: { amount: string }[] }>(r.headers['PAYMENT-REQUIRED'] ?? '');
    assert.equal(required.accepts[0]?.amount, '5000');
  });

  it('a price function that throws is answered locally (400), without calling Zold', async () => {
    const z = setup();
    const seen: unknown[] = [];
    const { handler } = sellerOf(await zold(z.acceptor, seen), { price: () => { throw new Error('bad size header'); } });
    const r = await handler.handle(get());
    assert.equal(codeOf(r), E.PRICE_INVALID);
    assert.equal(r.kind === 'respond' && r.status, 400);
    assert.equal(seen.length, 0);
  });
});

describe('zoldSeller fails closed when Zold cannot answer', () => {
  const unavailable = (r: AcceptResult) => {
    assert.equal(r.kind === 'respond' && r.status, 503);
    assert.equal(codeOf(r), E.UPSTREAM_UNAVAILABLE);
    assert.equal(r.kind === 'respond' && r.headers['retry-after'], '1');
  };

  it('unreachable', async () => {
    const { handler, errors } = sellerOf('http://127.0.0.1:9');
    unavailable(await handler.handle(get({ 'payment-signature': 'x' })));
    assert.equal(errors.length, 1);
  });

  it('a key Zold rejects', async () => {
    const api = await listen((_req, res) => { res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"UNAUTHORIZED"}'); });
    const { handler, errors } = sellerOf(api);
    unavailable(await handler.handle(get({ 'payment-signature': 'x' })));
    assert.match((errors[0] as AcceptError).message, /401/);
  });

  it('an answer that is not a settle response (it is never taken as paid)', async () => {
    const api = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ kind: 'paid', paid: { claimKey: 'k' } }));
    });
    const { handler, errors } = sellerOf(api);
    unavailable(await handler.handle(get({ 'payment-signature': 'x' })));
    assert.equal(errors.length, 1);
  });

  it('too slow', async () => {
    const api = await listen(() => undefined);
    const { handler } = sellerOf(api, { timeoutMs: 50 });
    unavailable(await handler.handle(get({ 'payment-signature': 'x' })));
  });
});

describe('hostedSettle', () => {
  const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    request: { method: 'GET', path: '/files', query: '', headers: {}, clientIp: '203.0.113.7', ...over },
    price: { amount: '10000' },
  });

  it('refuses a missing or unknown seller key', async () => {
    const z = setup();
    const settle = hostedSettle({ acceptorFor: (key) => (key === KEY ? z.acceptor : undefined), onError: () => undefined });
    assert.equal((await settle({ authorization: undefined, body: body() })).status, 401);
    assert.equal((await settle({ authorization: 'Bearer zsk_other', body: body() })).status, 401);
    assert.equal((await settle({ authorization: `Basic ${KEY}`, body: body() })).status, 401);
  });

  it('refuses a malformed body', async () => {
    const z = setup();
    const settle = hostedSettle({ acceptorFor: () => z.acceptor, onError: () => undefined });
    for (const bad of [
      undefined, [], { request: {} }, body({ method: 7 }), body({ headers: { cookie: 'x' } }),
      body({ headers: { 'payment-signature': 'x'.repeat(20_000) } }), body({ clientIp: 5 }),
      { ...body(), price: { amount: '-1' } }, { ...body(), price: { amount: '1.5' } }, { ...body(), extra: 1 },
    ]) {
      const out = await settle({ authorization: `Bearer ${KEY}`, body: bad });
      assert.equal(out.status, 400, JSON.stringify(bad)?.slice(0, 80));
      assert.deepEqual(out.body, { error: 'MALFORMED' });
    }
  });

  it('a failing acceptor lookup is a 503, never a 200', async () => {
    const settle = hostedSettle({ acceptorFor: () => { throw new Error('db down'); }, onError: () => undefined });
    assert.equal((await settle({ authorization: `Bearer ${KEY}`, body: body() })).status, 503);
  });
});

describe('core: a caller-supplied price', () => {
  it('handle(req, { price }) prices with it instead of the configured price function', async () => {
    const s = setup({ price: () => { throw new Error('never called'); } });
    const r = await s.acceptor.handle(s.req(), { price: { amount: 7_000n } });
    const required = b64decode<{ accepts: { amount: string }[] }>(r.headers['PAYMENT-REQUIRED'] ?? '');
    assert.equal(required.accepts[0]?.amount, '7000');
  });

  it('a caller-supplied price is validated like any other', async () => {
    const s = setup();
    assert.equal(codeOf(await s.acceptor.handle(s.req(), { price: { amount: 0n } })), E.PRICE_ERROR);
  });
});

describe('zoldSeller options are parsed strictly', () => {
  const ok = { apiUrl: 'https://api.zoldhq.com', apiKey: KEY, price: () => ({ amount: 1n }), onError: () => undefined };
  const bad = (over: Record<string, unknown>) =>
    assert.throws(() => zoldSeller({ ...ok, ...over } as never), (e: unknown) => e instanceof AcceptError && e.code === E.CONFIG_INVALID);

  it('refuses plain http except to localhost, bad keys, a missing onError, and unknown keys', () => {
    bad({ apiUrl: 'http://api.zoldhq.com' });
    bad({ apiUrl: 'https://api.zoldhq.com/path?x=1' });
    bad({ apiKey: 'sk_live_123' });
    bad({ apiKey: 'zsk_short' });
    bad({ onError: undefined });
    bad({ price: 'free' });
    bad({ timeoutMs: 0 });
    bad({ surprise: true });
    assert.doesNotThrow(() => zoldSeller({ ...ok, apiUrl: 'http://localhost:4000' }));
    assert.doesNotThrow(() => zoldSeller({ ...ok, apiUrl: 'http://127.0.0.1:4000' }));
  });
});

describe('review hardening: the seller trusts only a paid answer for what it sent', () => {
  /** A Zold that settles for real, then lets a test bend its answer. */
  async function bentZold(acceptor: Acceptor, bend: (body: Record<string, unknown>) => unknown): Promise<string> {
    const settle = hostedSettle({ acceptorFor: () => acceptor, onError: () => undefined });
    return listen(async (req, res) => {
      const out = await settle({ authorization: req.headers.authorization, body: await readJson(req) });
      res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(bend(out.body as Record<string, unknown>)));
    });
  }
  const paidPart = (b: Record<string, unknown>) => b.paid as Record<string, unknown>;

  for (const [what, bend] of [
    ['a lower amount', (b: Record<string, unknown>) => ({ ...b, paid: { ...paidPart(b), amount: '1' } })],
    ['another path', (b: Record<string, unknown>) => ({ ...b, paid: { ...paidPart(b), path: '/admin' } })],
    ['another method', (b: Record<string, unknown>) => ({ ...b, paid: { ...paidPart(b), method: 'POST' } })],
    ['other meta', (b: Record<string, unknown>) => ({ ...b, paid: { ...paidPart(b), meta: { tier: 'gold' } } })],
    ['a cookie header', (b: Record<string, unknown>) => ({ ...b, headers: { 'Set-Cookie': 'sid=x' } })],
    ['chain id 0', (b: Record<string, unknown>) => ({ ...b, paid: { ...paidPart(b), chainId: 0 } })],
    ['a txHash that is not one', (b: Record<string, unknown>) => ({ ...b, paid: { ...paidPart(b), txHash: 'nope' } })],
    ['an amount above uint256', (b: Record<string, unknown>) => ({ ...b, paid: { ...paidPart(b), amount: (2n ** 256n).toString() } })],
  ] as const) {
    it(`a paid answer with ${what} is never delivered`, async () => {
      const z = setup();
      const { handler, errors } = sellerOf(await bentZold(z.acceptor, bend));
      const r = await handler.handle(get({ 'payment-signature': await payHeader(z.buyer) }));
      assert.equal(codeOf(r), E.UPSTREAM_UNAVAILABLE);
      assert.equal(errors.length, 1);
    });
  }

  for (const [what, bend] of [
    ['a 2xx status', (b: Record<string, unknown>) => ({ ...b, status: 200 })],
    ['a redirect status', (b: Record<string, unknown>) => ({ ...b, status: 302 })],
    ['an extra key', (b: Record<string, unknown>) => ({ ...b, extra: 1 })],
    ['a location header', (b: Record<string, unknown>) => ({ ...b, headers: { location: 'https://evil.example' } })],
  ] as const) {
    it(`a respond answer with ${what} is refused`, async () => {
      const z = setup();
      const { handler } = sellerOf(await bentZold(z.acceptor, bend));
      assert.equal(codeOf(await handler.handle(get())), E.UPSTREAM_UNAVAILABLE);
    });
  }

  it('price meta and contentLength round-trip, and a paid answer carries the meta', async () => {
    const z = setup();
    const { handler } = sellerOf(await zold(z.acceptor), { price: () => ({ amount: PRICE, meta: { tier: 'pro' }, contentLength: 0 }) });
    const r = await handler.handle(get({ 'payment-signature': await payHeader(z.buyer), 'content-length': '0' }));
    assert.ok(r.kind === 'paid');
    assert.deepEqual(r.paid.meta, { tier: 'pro' });
  });
});

describe('review hardening: what the seller can check, it checks locally', () => {
  it('an oversized query or payment header is a local 400, without calling Zold or onError', async () => {
    const z = setup();
    const seen: unknown[] = [];
    const { handler, errors } = sellerOf(await zold(z.acceptor, seen));
    assert.equal(codeOf(await handler.handle({ ...get(), query: `q=${'a'.repeat(5_000)}` })), E.MALFORMED);
    assert.equal(codeOf(await handler.handle(get({ 'payment-signature': 'x'.repeat(17_000) }))), E.MALFORMED);
    assert.equal(seen.length, 0);
    assert.equal(errors.length, 0);
  });

  it('price meta Zold would refuse is a local 500 PRICE_ERROR', async () => {
    const z = setup();
    const seen: unknown[] = [];
    const { handler } = sellerOf(await zold(z.acceptor, seen), { price: () => ({ amount: PRICE, meta: { n: 1 } }) });
    const r = await handler.handle(get());
    assert.equal(codeOf(r), E.PRICE_ERROR);
    assert.equal(r.kind === 'respond' && r.status, 500);
    assert.equal(seen.length, 0);
  });

  it('an answer over 64 KB is refused', async () => {
    const api = await listen((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }).end(`"${'x'.repeat(70_000)}"`); });
    const { handler, errors } = sellerOf(api);
    assert.equal(codeOf(await handler.handle(get())), E.UPSTREAM_UNAVAILABLE);
    assert.match((errors[0] as AcceptError).message, /too large/);
  });

  it('a body that stalls after the headers times out', async () => {
    const api = await listen((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); });
    const { handler } = sellerOf(api, { timeoutMs: 50 });
    assert.equal(codeOf(await handler.handle(get())), E.UPSTREAM_UNAVAILABLE);
  });

  it('the body of a non-200 answer is cancelled, not left holding the connection', async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const { handler } = sellerOf('https://api.zoldhq.com', { fetch: async () => new Response(body, { status: 500 }) });
    assert.equal(codeOf(await handler.handle(get())), E.UPSTREAM_UNAVAILABLE);
    assert.equal(cancelled, true);
  });

  it('an onError that throws or rejects does not change the answer', async () => {
    for (const onError of [() => { throw new Error('boom'); }, () => Promise.reject(new Error('boom'))]) {
      const { handler } = sellerOf('http://127.0.0.1:9', { onError });
      assert.equal(codeOf(await handler.handle(get())), E.UPSTREAM_UNAVAILABLE);
    }
  });

  it('a fetch option that is not a function is refused at startup', () => {
    assert.throws(() => sellerOf('https://api.zoldhq.com', { fetch: 'nope' }), (e: unknown) => e instanceof AcceptError && e.code === E.CONFIG_INVALID);
  });
});

describe('review hardening: hostedSettle reports what goes wrong', () => {
  const body = { request: { method: 'GET', path: '/files', query: '', headers: {}, clientIp: '203.0.113.7' }, price: { amount: '10000' } };

  it('an acceptor that throws is a 500 INTERNAL, and reported', async () => {
    const errors: unknown[] = [];
    const broken = { handle: () => Promise.reject(new Error('boom')) } as unknown as Acceptor;
    const settle = hostedSettle({ acceptorFor: () => broken, onError: (e) => { errors.push(e); } });
    const out = await settle({ authorization: `Bearer ${KEY}`, body });
    assert.deepEqual(out, { status: 500, body: { error: 'INTERNAL' } });
    assert.equal(errors.length, 1);
  });

  it('a failing acceptor lookup is reported', async () => {
    const errors: unknown[] = [];
    const settle = hostedSettle({ acceptorFor: () => { throw new Error('db down'); }, onError: (e) => { errors.push(e); } });
    assert.equal((await settle({ authorization: `Bearer ${KEY}`, body })).status, 503);
    assert.equal(errors.length, 1);
  });

  it('options are parsed strictly: onError is required', () => {
    for (const bad of [{ acceptorFor: () => undefined }, { acceptorFor: 'x', onError: () => undefined }, { acceptorFor: () => undefined, onError: () => undefined, more: 1 }]) {
      assert.throws(() => hostedSettle(bad as never), (e: unknown) => e instanceof AcceptError && e.code === E.CONFIG_INVALID);
    }
  });
});

describe('decodeResult bounds', () => {
  const paid = (over: Record<string, unknown>) => ({
    kind: 'paid', headers: {},
    paid: {
      claimKey: 'k', protocol: 'x402', payer: '0x1', amount: '1', chainId: 84532, asset: '0x2', nonce: '0x3',
      method: 'GET', path: '/files', meta: {}, settled: true, replayed: false, ...over,
    },
  });
  const respond = (status: number) => ({ kind: 'respond', status, headers: {}, body: '{}' });

  it('takes an amount up to 2^256 - 1 and no more', () => {
    assert.equal(decodeResult(paid({ amount: (2n ** 256n - 1n).toString() }))?.kind, 'paid');
    assert.equal(decodeResult(paid({ amount: (2n ** 256n).toString() })), undefined);
  });

  it('takes a respond status from 400 to 599 only', () => {
    assert.equal(decodeResult(respond(400))?.kind, 'respond');
    assert.equal(decodeResult(respond(599))?.kind, 'respond');
    assert.equal(decodeResult(respond(399)), undefined);
    assert.equal(decodeResult(respond(600)), undefined);
  });
});
