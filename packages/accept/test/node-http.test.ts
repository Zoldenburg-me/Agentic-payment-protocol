import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { MemorySingleUseStore } from 'agentpay-hub/protocol';
import { PaymentHub, evmX402Signer } from 'agentpay-hub';
import { FakeFiatToken, MemoryRateLimiter, MemorySellerLedger, accept, nodeHandler, toReqLike } from '../src/index.js';
import { CHAIN_ID, DOMAIN, PAY_TO, PRICE, USDC, tick } from './helpers.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const realChain = () =>
  new FakeFiatToken({ chainId: CHAIN_ID, asset: USDC, domain: DOMAIN, nowSec: () => Math.floor(Date.now() / 1000) });

describe('node:http adapter', () => {
  it('end to end: the router hub pays, the seller settles on the (fake) chain and serves once', async () => {
    const chain = realChain();
    const ledger = new MemorySellerLedger();
    const acceptor = accept(
      { sellerAccountId: 'zold', payTo: PAY_TO, chainId: CHAIN_ID, asset: USDC, price: () => ({ amount: PRICE }), pollIntervalMs: 1 },
      { ledger, claims: new MemorySingleUseStore(), chain, submitter: chain, rateLimiter: new MemoryRateLimiter(), sleep: tick, onError: () => undefined },
    );
    const url = await listen(nodeHandler(acceptor, (_req, res, paid) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ eurUsd: 1.08, claimKey: paid.claimKey }));
    }));
    const key = generatePrivateKey();
    chain.mint(privateKeyToAccount(key).address, 1_000_000n);
    const hub = new PaymentHub({ wallet: { x402: evmX402Signer(key) } });

    const result = await hub.request(`${url}/rates`);
    assert.equal(result.status, 'paid');
    if (result.status !== 'paid') return;
    assert.equal(result.receipt?.reference, chain.submissions[0]);
    const body = JSON.parse(await result.response.text()) as { eurUsd: number; claimKey: string };
    assert.equal(body.eurUsd, 1.08);
    assert.equal((await ledger.get(body.claimKey))?.delivered, true);
    assert.equal(chain.balanceOfSync(PAY_TO), PRICE);
  });

  it('answers the 402 offer and refusals itself, with JSON bodies', async () => {
    const chain = realChain();
    const acceptor = accept(
      { sellerAccountId: 'zold', payTo: PAY_TO, chainId: CHAIN_ID, asset: USDC, price: () => ({ amount: PRICE }) },
      { ledger: new MemorySellerLedger(), claims: new MemorySingleUseStore(), chain, submitter: chain, onError: () => undefined },
    );
    const url = await listen(nodeHandler(acceptor, () => assert.fail('must not deliver')));
    const res = await fetch(`${url}/rates`);
    assert.equal(res.status, 402);
    assert.ok(res.headers.get('payment-required'));
    assert.deepEqual(await res.json(), { error: 'PAYMENT_REQUIRED' });
  });

  it('turns a throwing delivery handler into a bare 500 without leaking the error', async () => {
    const chain = realChain();
    const acceptor = accept(
      { sellerAccountId: 'zold', payTo: PAY_TO, chainId: CHAIN_ID, asset: USDC, price: () => ({ amount: PRICE }), pollIntervalMs: 1 },
      { ledger: new MemorySellerLedger(), claims: new MemorySingleUseStore(), chain, submitter: chain, sleep: tick, onError: () => undefined },
    );
    const url = await listen(nodeHandler(acceptor, () => { throw new Error('db password is hunter2'); }));
    const key = generatePrivateKey();
    chain.mint(privateKeyToAccount(key).address, 1_000_000n);
    const result = await new PaymentHub({ wallet: { x402: evmX402Signer(key) } }).request(`${url}/rates`);
    assert.equal(result.status, 'rejected');
    if (result.status !== 'rejected') return;
    assert.equal(result.response.status, 500);
    assert.equal(result.response.headers.get('payment-response'), null, 'a failed delivery carries no success receipt');
    assert.doesNotMatch(await result.response.text(), /hunter2/);
  });
});

describe('toReqLike', () => {
  const fakeReq = (headers: Record<string, string | string[]>, remoteAddress = '10.0.0.5') =>
    ({ method: 'GET', url: '/rates?x=1', headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

  it('uses the socket address unless proxy hops are trusted explicitly', () => {
    assert.equal(toReqLike(fakeReq({ 'x-forwarded-for': '1.2.3.4' })).clientIp, '10.0.0.5');
  });

  it('reads X-Forwarded-For from the right, so a client cannot choose its own address', () => {
    const xff = { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' };
    assert.equal(toReqLike(fakeReq(xff), { trustedProxyHops: 1 }).clientIp, '1.2.3.4');
    assert.equal(toReqLike(fakeReq(xff), { trustedProxyHops: 2 }).clientIp, '6.6.6.6');
    assert.equal(toReqLike(fakeReq(xff), { trustedProxyHops: 3 }).clientIp, '10.0.0.5', 'fewer entries than hops: socket');
    assert.equal(toReqLike(fakeReq({ 'x-forwarded-for': 'not-an-ip' }), { trustedProxyHops: 1 }).clientIp, '10.0.0.5');
  });

  it('splits path and query and lower-cases header names', () => {
    const r = toReqLike(fakeReq({ 'Payment-Signature': 'abc' }));
    assert.equal(r.path, '/rates');
    assert.equal(r.query, 'x=1');
    assert.equal(r.headers['payment-signature'], 'abc');
  });

  it('joins repeated headers so a duplicated payment header fails strict parsing', () => {
    assert.equal(toReqLike(fakeReq({ 'payment-signature': ['a', 'b'] })).headers['payment-signature'], 'a, b');
  });
});
