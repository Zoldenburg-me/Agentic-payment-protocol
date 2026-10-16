import assert from 'node:assert/strict';
import { type RequestListener, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import { getAddress } from 'viem';
import { type PrivateKeyAccount, generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { b64decode } from 'agentpay-hub/protocol';
import { AcceptError, type AcceptResult, FakeFiatToken, nodeHandler, zoldSeller } from '@zold/accept';
import { SqliteSellerLedger, openSqlite } from '@zold/accept/sqlite';
import { CHAIN_ID, DOMAIN, NOW_S, PRICE, USDC, payHeader, tick } from '../../accept/test/helpers.js';
import { Counters } from '../src/counters.js';
import { parseEnv } from '../src/env.js';
import { MerchantStore } from '../src/merchants.js';
import { type HostedLimits, MAX_BODY_BYTES, SETTLE_ROUTE, hostedService } from '../src/service.js';

const PAY_A = getAddress(`0x${'a1'.repeat(20)}`);
const PAY_B = getAddress(`0x${'b2'.repeat(20)}`);
const LIMITS: HostedLimits = { minAmount: 1_000n, perMinute: 100, paidPerDay: 100, failedKeysPerMinute: 3 };
const isConfig = (e: unknown): boolean => e instanceof AcceptError && e.code === 'CONFIG_INVALID';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
});

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function hub(limits: Partial<HostedLimits> = {}) {
  let nowMs = NOW_S * 1000;
  const db = openSqlite(':memory:');
  const merchants = new MerchantStore(db);
  const chain = new FakeFiatToken({ chainId: CHAIN_ID, asset: USDC, domain: DOMAIN, nowSec: () => Math.floor(nowMs / 1000) });
  const buyer = privateKeyToAccount(generatePrivateKey());
  chain.mint(buyer.address, 1_000_000n);
  const errors: unknown[] = [];
  const service = hostedService({
    db, merchants, chainId: CHAIN_ID, asset: USDC, chain, submitter: chain, limits: { ...LIMITS, ...limits },
    onError: (e) => { errors.push(e); }, tuning: { pollIntervalMs: 1, settlementTimeoutMs: 2_000 }, now: () => nowMs, sleep: tick,
  });
  const url = await listen(service.listener);
  return { db, merchants, chain, buyer, service, url, errors, advance: (ms: number) => { nowMs += ms; } };
}

const sellerOf = (url: string, apiKey: string, amount = PRICE) =>
  zoldSeller({ apiUrl: url, apiKey, price: () => ({ amount }), onError: () => undefined, timeoutMs: 5_000 });

const get = (headers: Record<string, string> = {}) => ({ method: 'GET', path: '/files', query: '', headers, clientIp: '203.0.113.7' });
const payFor = (buyer: PrivateKeyAccount, payTo: string, nonce?: `0x${string}`) =>
  payHeader(buyer, { to: payTo, accepted: { payTo }, ...(nonce !== undefined ? { nonce } : {}) });
const codeOf = (r: AcceptResult): unknown => (r.kind === 'respond' ? (JSON.parse(r.body) as { error: unknown }).error : undefined);

const post = (url: string, init: { key?: string; body?: string; headers?: Record<string, string> } = {}) => fetch(`${url}${SETTLE_ROUTE}`, {
  method: 'POST', body: init.body ?? '{}',
  headers: { 'content-type': 'application/json', ...(init.key !== undefined ? { authorization: `Bearer ${init.key}` } : {}), ...init.headers },
});

describe('MerchantStore', () => {
  it('a key works until it is rotated or its merchant revoked, and only its hash is stored', () => {
    const db = openSqlite(':memory:');
    const merchants = new MerchantStore(db);
    const key = merchants.add('shareme', PAY_A.toLowerCase());
    assert.match(key, /^zsk_[0-9a-f]{16}_[0-9a-f]{64}$/);
    assert.deepEqual(merchants.verify(key), { id: 'shareme', payTo: PAY_A });
    const secret = key.slice(-64);
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM merchants').all()).includes(secret), 'the secret is not stored');
    assert.equal(merchants.verify(`${key.slice(0, -1)}${key.endsWith('0') ? '1' : '0'}`), undefined, 'a wrong secret');

    const rotated = merchants.rotate('shareme');
    assert.equal(merchants.verify(key), undefined, 'the old key stops at once');
    assert.equal(merchants.verify(rotated)?.id, 'shareme');

    merchants.revoke('shareme');
    assert.equal(merchants.verify(rotated), undefined);
    assert.equal(merchants.isPayee(PAY_A.toLowerCase()), true, 'payments taken before revocation still settle');
    assert.equal(merchants.isPayee(PAY_B), false);
    assert.throws(() => merchants.rotate('shareme'), isConfig);
    assert.deepEqual(merchants.all(), [{ id: 'shareme', payTo: PAY_A, revoked: true }]);
  });

  it('refuses bad ids, bad or zero payees and duplicates, without echoing the input', () => {
    const merchants = new MerchantStore(openSqlite(':memory:'));
    const refused = (fn: () => unknown, input: string) =>
      assert.throws(fn, (e: unknown) => isConfig(e) && !(e as Error).message.includes(input));
    refused(() => merchants.add('has space', PAY_A), 'has space');
    refused(() => merchants.add('m1', '0xnot-an-address'), '0xnot-an-address');
    refused(() => merchants.add('m1', `0x${'0'.repeat(40)}`), '0'.repeat(40));
    refused(() => merchants.add('m1', '0xA1a1A1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'), 'A1a1'); // a bad checksum
    merchants.add('m1', PAY_A);
    refused(() => merchants.add('m1', PAY_B), PAY_B);
    assert.throws(() => merchants.revoke('nobody'), isConfig);
  });

  it('anything not shaped like a key is no key', () => {
    const merchants = new MerchantStore(openSqlite(':memory:'));
    const key = merchants.add('m1', PAY_A);
    for (const bad of ['', 'zsk_', key.toUpperCase(), `${key}0`, `x${key}`]) assert.equal(merchants.verify(bad), undefined);
  });
});

describe('Counters', () => {
  it('counts per key up to the limit in a window, then starts over; sweep drops ended windows', () => {
    const db = openSqlite(':memory:');
    const c = new Counters(db);
    assert.deepEqual([c.take('k', 2, 1_000, 0), c.take('k', 2, 1_000, 10), c.take('k', 2, 1_000, 20)], [true, true, false]);
    assert.equal(c.spent('k', 2, 20), true);
    assert.equal(c.spent('other', 2, 20), false);
    assert.equal(c.take('other', 2, 1_000, 20), true, 'keys are separate');
    assert.equal(c.spent('k', 2, 1_000), false, 'the window ended');
    assert.equal(c.take('k', 2, 1_000, 1_000), true);
    c.sweep(5_000);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM hosted_counters').get() as { n: number }).n, 0);
  });
});

describe('parseEnv', () => {
  const KEY = `0x${'ab'.repeat(32)}`;
  const base = { HUB_DB_PATH: '/var/lib/hub/hub.db', HUB_RPC_URL: 'https://sepolia.base.org', HUB_RELAY_KEY: KEY };

  it('takes the three required variables and defaults the rest', () => {
    const env = parseEnv(base);
    assert.equal(env.port, 8787);
    assert.equal(env.host, '127.0.0.1');
    assert.equal(env.trustedProxyHops, 0);
    assert.deepEqual(env.limits, { minAmount: 1_000n, perMinute: 600, paidPerDay: 10_000, failedKeysPerMinute: 20 });
    assert.equal(parseEnv({ ...base, HUB_RPC_URL: 'http://localhost:8545' }).rpcUrl, 'http://localhost:8545/');
    assert.equal(parseEnv({ ...base, HUB_MIN_AMOUNT: '5000', HUB_PORT: '9000' }).limits.minAmount, 5_000n);
  });

  it('fails closed on a missing or bad variable, naming it and never its value', () => {
    const refused = (env: Record<string, string | undefined>, name: string) => assert.throws(() => parseEnv(env), (e: unknown) =>
      isConfig(e) && (e as Error).message.startsWith(name) && !(e as Error).message.includes(KEY.slice(2, 12)));
    refused({ ...base, HUB_DB_PATH: undefined }, 'HUB_DB_PATH');
    refused({ ...base, HUB_RELAY_KEY: KEY.slice(0, -2) }, 'HUB_RELAY_KEY');
    refused({ ...base, HUB_RPC_URL: 'http://rpc.example.com' }, 'HUB_RPC_URL');
    refused({ ...base, HUB_RPC_URL: 'not a url' }, 'HUB_RPC_URL');
    refused({ ...base, HUB_PORT: '70000' }, 'HUB_PORT');
    refused({ ...base, HUB_PER_MINUTE: '1.5' }, 'HUB_PER_MINUTE');
    refused({ ...base, HUB_MIN_AMOUNT: '0' }, 'HUB_MIN_AMOUNT');
  });
});

describe('hostedService: POST /api/agent-payments/settle', () => {
  it('end to end: zoldSeller gets an offer naming the merchant\'s payee, then a payment settled to it in the SQLite ledger', async () => {
    const h = await hub();
    const shop = await listen(nodeHandler(sellerOf(h.url, h.merchants.add('shareme', PAY_A)), (_req, res, paid) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ claimKey: paid.claimKey }));
    }));
    const offer = await fetch(`${shop}/files`);
    assert.equal(offer.status, 402);
    const required = b64decode<{ accepts: { payTo: string; network: string }[] }>(offer.headers.get('payment-required') ?? '');
    assert.equal(required.accepts[0]?.payTo, PAY_A);
    assert.equal(required.accepts[0]?.network, 'eip155:84532');

    const res = await fetch(`${shop}/files`, { headers: { 'payment-signature': await payFor(h.buyer, PAY_A) } });
    assert.equal(res.status, 200);
    const { claimKey } = (await res.json()) as { claimKey: string };
    const row = await new SqliteSellerLedger(h.db).get(claimKey);
    assert.equal(row?.status, 'settled');
    assert.equal(row?.sellerAccountId, 'shareme');
    assert.equal(h.chain.balanceOfSync(PAY_A), PRICE);
    assert.deepEqual(h.errors, []);
  });

  it('each merchant is paid to its own address through the one relay', async () => {
    const h = await hub();
    const a = sellerOf(h.url, h.merchants.add('a', PAY_A));
    const b = sellerOf(h.url, h.merchants.add('b', PAY_B));
    const offerB = await b.handle(get());
    assert.equal(offerB.kind === 'respond' && b64decode<{ accepts: { payTo: string }[] }>(offerB.headers['PAYMENT-REQUIRED'] ?? '').accepts[0]?.payTo, PAY_B);
    assert.equal((await a.handle(get({ 'payment-signature': await payFor(h.buyer, PAY_A, `0x${'01'.repeat(32)}`) }))).kind, 'paid');
    assert.equal((await b.handle(get({ 'payment-signature': await payFor(h.buyer, PAY_B, `0x${'02'.repeat(32)}`) }))).kind, 'paid');
    const paidToA = await a.handle(get({ 'payment-signature': await payFor(h.buyer, PAY_B, `0x${'03'.repeat(32)}`) }));
    assert.equal(paidToA.kind, 'respond', 'a payment to B is not one for A');
    assert.deepEqual([h.chain.balanceOfSync(PAY_A), h.chain.balanceOfSync(PAY_B)], [PRICE, PRICE]);
  });

  it('an unknown key is 401; repeated failures lock that IP out, valid key or not, until the window passes', async () => {
    const h = await hub({ failedKeysPerMinute: 2 });
    const key = h.merchants.add('m1', PAY_A);
    assert.equal((await post(h.url)).status, 401, 'no key');
    assert.equal((await post(h.url, { key: `zsk_${'0'.repeat(16)}_${'0'.repeat(64)}` })).status, 401);
    const locked = await post(h.url, { key });
    assert.equal(locked.status, 429);
    assert.equal(locked.headers.get('retry-after'), '60');
    h.advance(60_000);
    assert.equal((await post(h.url, { key })).status, 400, 'the key works again (and {} is no settle request)');
  });

  it('caps the body before parsing it, refuses non-JSON, and serves nothing but the settle route', async () => {
    const h = await hub();
    const key = h.merchants.add('m1', PAY_A);
    assert.equal((await post(h.url, { key, body: 'x'.repeat(MAX_BODY_BYTES + 1) })).status, 413);
    assert.equal((await post(h.url, { key, body: '{not json' })).status, 400);
    assert.equal((await fetch(`${h.url}${SETTLE_ROUTE}`)).status, 404);
    assert.equal((await fetch(`${h.url}/api/agent-payments/other`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${h.url}${SETTLE_ROUTE}?x=1`, { method: 'POST' })).status, 404);
  });

  it('a price below the minimum is the seller\'s 500 PRICE_ERROR; nothing reaches the chain', async () => {
    const h = await hub({ minAmount: 20_000n });
    const seller = sellerOf(h.url, h.merchants.add('m1', PAY_A), 10_000n);
    const result = await seller.handle(get({ 'payment-signature': await payFor(h.buyer, PAY_A) }));
    assert.equal(result.kind === 'respond' && result.status, 500);
    assert.equal(codeOf(result), 'PRICE_ERROR');
    assert.equal(h.chain.submissions.length, 0);
  });

  it('limits each seller key per minute, offers included, and its paid calls per day', async () => {
    const h = await hub({ perMinute: 2, paidPerDay: 1 });
    const seller = sellerOf(h.url, h.merchants.add('m1', PAY_A));
    const other = sellerOf(h.url, h.merchants.add('m2', PAY_B));
    assert.equal(codeOf(await seller.handle(get())), 'PAYMENT_REQUIRED');
    assert.equal(codeOf(await seller.handle(get())), 'PAYMENT_REQUIRED');
    const limited = await seller.handle(get());
    assert.equal(codeOf(limited), 'RATE_LIMITED');
    assert.equal(limited.kind === 'respond' && limited.status, 429);
    assert.equal(codeOf(await other.handle(get())), 'PAYMENT_REQUIRED', 'another key has its own budget');

    h.advance(60_000);
    assert.equal((await seller.handle(get({ 'payment-signature': await payFor(h.buyer, PAY_A, `0x${'04'.repeat(32)}`) }))).kind, 'paid');
    h.advance(60_000);
    assert.equal(codeOf(await seller.handle(get({ 'payment-signature': await payFor(h.buyer, PAY_A, `0x${'05'.repeat(32)}`) }))), 'RATE_LIMITED');
    assert.equal(codeOf(await seller.handle(get())), 'PAYMENT_REQUIRED', 'offers stay open past the daily cap');
  });

  it('reconcile walks every merchant and sweeps ended limit windows', async () => {
    const h = await hub();
    h.merchants.add('m1', PAY_A);
    h.merchants.add('m2', PAY_B);
    assert.equal((await post(h.url, { key: 'wrong' })).status, 401);
    h.advance(60_000);
    await h.service.reconcile();
    assert.equal((h.db.prepare('SELECT COUNT(*) AS n FROM hosted_counters').get() as { n: number }).n, 0);
    assert.deepEqual(h.errors, []);
  });

  it('a store failure is a 500 for the seller and reaches onError', async () => {
    const h = await hub();
    const key = h.merchants.add('m1', PAY_A);
    h.db.close();
    const res = await post(h.url, { key });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'INTERNAL' });
    assert.equal(h.errors.length, 1);
  });
});
