import assert from 'node:assert/strict';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import {
  AcceptError, AcceptErrorCode as E, type Acceptor, type ExpressRequest, type ExpressResponse, expressDeliveryErrors, expressPayment, paymentOf,
} from '../src/index.js';
import { PRICE, payHeader, setup } from './helpers.js';

type Next = (error?: unknown) => void;
type Middleware = (req: ExpressRequest, res: ExpressResponse, next: Next) => void;
type ErrorMiddleware = (error: unknown, req: ExpressRequest, res: ExpressResponse, next: Next) => void;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/**
 * Just enough of Express to exercise the adapter: `mount` strips its prefix from req.url (keeping
 * originalUrl), middleware run in order, next(error) skips to the error middleware, and the final
 * handler answers 500 for an unhandled error.
 */
async function app(mount: string, chain: Middleware[], onError: ErrorMiddleware[] = []): Promise<string> {
  const server = createServer((rawReq: IncomingMessage, rawRes: ServerResponse) => {
    const req = rawReq as ExpressRequest;
    const res = rawRes as ExpressResponse;
    req.originalUrl = req.url ?? '/';
    if (mount !== '' && req.url?.startsWith(mount)) req.url = req.url.slice(mount.length) || '/';
    res.locals = {};
    let i = 0;
    let e = 0;
    const next: Next = (error) => {
      if (error !== undefined) {
        const handler = onError[e++];
        if (handler) return handler(error, req, res, next);
        if (!res.headersSent) res.writeHead(500).end('unhandled');
        return;
      }
      chain[i++]?.(req, res, next);
    };
    next();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('Express adapter', () => {
  it('answers the 402 itself and never calls the route', async () => {
    const s = setup();
    const url = await app('', [expressPayment(s.acceptor), () => assert.fail('route must not run')]);
    const res = await fetch(`${url}/rates`);
    assert.equal(res.status, 402);
    assert.ok(res.headers.get('payment-required'));
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  it('a paid request reaches the route with the payment on res.locals and the receipt header set', async () => {
    const s = setup();
    const url = await app('', [
      expressPayment(s.acceptor),
      (_req, res) => {
        const paid = paymentOf(res);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ claimKey: paid?.claimKey, amount: String(paid?.amount) }));
      },
    ]);
    const res = await fetch(`${url}/rates`, { headers: { 'payment-signature': await payHeader(s.buyer) } });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('payment-response'));
    const body = (await res.json()) as { claimKey: string; amount: string };
    assert.equal(body.amount, PRICE.toString());
    assert.equal((await s.ledger.get(body.claimKey))?.delivered, true);
  });

  it('prices the full path when mounted, so a router prefix cannot make a route cheaper', async () => {
    const seen: string[] = [];
    const s = setup({ price: (r) => { seen.push(r.path); return { amount: PRICE }; } });
    const url = await app('/api', [expressPayment(s.acceptor)]);
    await fetch(`${url}/api/premium?x=1`);
    assert.deepEqual(seen, ['/api/premium']);
  });

  it('a route that fails after payment is reported as DELIVERY_FAILED, without a receipt header', async () => {
    const s = setup();
    const url = await app('', [expressPayment(s.acceptor), (_req, _res, next) => next(new Error('render failed'))], [expressDeliveryErrors(s.acceptor)]);
    const res = await fetch(`${url}/rates`, { headers: { 'payment-signature': await payHeader(s.buyer) } });
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('payment-response'), null);
    assert.equal(s.errors.length, 1);
    const err = s.errors[0] as AcceptError;
    assert.equal(err.code, E.DELIVERY_FAILED);
    assert.equal((err.cause as Error).message, 'render failed');
  });

  it('the delivery-error hook ignores errors on requests that were not paid', async () => {
    const s = setup();
    const boom: Middleware = (_req, _res, next) => next(new Error('unrelated'));
    const url = await app('', [boom], [expressDeliveryErrors(s.acceptor)]);
    assert.equal((await fetch(`${url}/rates`)).status, 500);
    assert.equal(s.errors.length, 0);
  });

  it('an adapter failure answers a bare 500 itself and is reported, never passed to Express', async () => {
    const reported: unknown[] = [];
    const broken: Acceptor = {
      handle: () => Promise.reject(new Error('core down')),
      reportError: (e) => { reported.push(e); },
      reconcileOwed: () => Promise.reject(new Error('unused')),
      idle: () => Promise.resolve(),
    };
    let reachedExpress = false;
    const url = await app('', [expressPayment(broken)], [() => { reachedExpress = true; }]);
    const res = await fetch(`${url}/rates`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'INTERNAL' });
    assert.equal(reported.length, 1);
    assert.equal(reachedExpress, false);
  });

  it('uses trustedProxyHops for the client IP, like the node:http adapter', async () => {
    const s = setup({ rateLimit: { perIpPerMinute: 1 } });
    const url = await app('', [expressPayment(s.acceptor, { trustedProxyHops: 1 }), (_req, res) => { res.end('ok'); }]);
    const header = await payHeader(s.buyer);
    const as = (ip: string) => fetch(`${url}/rates`, { headers: { 'payment-signature': header, 'x-forwarded-for': ip } });
    assert.equal((await as('198.51.100.1')).status, 200);
    assert.equal((await as('198.51.100.2')).status, 200, 'a different client has its own bucket');
    assert.equal((await as('198.51.100.1')).status, 429);
  });
});
