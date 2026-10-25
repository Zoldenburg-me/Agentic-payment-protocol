import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { claimPayment, releasePayment } from 'agentpay-hub/protocol';
import { AcceptErrorCode as E, type NewSellerPayment } from '../src/index.js';
import { SqliteRateLimiter, SqliteSellerLedger, SqliteSingleUseStore, openSqlite } from '../src/sqlite/index.js';
import { CHAIN_ID, PAY_TO, USDC, payHeader, setup } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'accept-sqlite-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
const file = () => join(dir, `store-${files++}.db`);

const row = (claimKey = 'k1'): NewSellerPayment => ({
  claimKey, sellerAccountId: 'seller-1', protocol: 'x402', chainId: CHAIN_ID, asset: USDC, payer: PAY_TO,
  nonce: `0x${'11'.repeat(32)}`, amount: '10000', payTo: PAY_TO, validBefore: '1800000120', method: 'GET', path: '/rates',
  queryDigest: 'q', headerDigest: 'd1', meta: { order: '42' },
});
const TX = `0x${'aa'.repeat(32)}`;
const PARTS = { sellerAccountId: 'seller-1', chainId: CHAIN_ID, asset: USDC, from: PAY_TO, nonce: `0x${'22'.repeat(32)}` };

describe('openSqlite', () => {
  it('refuses an empty path instead of opening a throwaway database', () => {
    assert.throws(() => openSqlite(''), { code: E.CONFIG_INVALID });
  });
});

describe('SqliteSellerLedger: durable and shared', () => {
  it('numbers settled rows in a file made before settled_seq, in seq order, once; later settles continue the count', async () => {
    const path = file();
    const old = openSqlite(path);
    old.exec(`CREATE TABLE seller_payments (seq INTEGER PRIMARY KEY AUTOINCREMENT, claim_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL, delivered INTEGER NOT NULL, row TEXT NOT NULL)`);
    const insert = old.prepare('INSERT INTO seller_payments (claim_key, status, delivered, row) VALUES (?, ?, 0, ?)');
    for (const [key, status] of [['s1', 'settled'], ['o1', 'owed'], ['s2', 'settled'], ['r1', 'refused'], ['s3', 'settled']]) {
      insert.run(key ?? '', status ?? '', JSON.stringify({ ...row(key), txHash: TX }));
    }
    old.close();
    const numbers = (db: ReturnType<typeof openSqlite>) =>
      db.prepare('SELECT claim_key, settled_seq FROM seller_payments ORDER BY seq').all().map((r) => `${r.claim_key}:${r.settled_seq}`);
    const a = openSqlite(path);
    const ledger = new SqliteSellerLedger(a);
    assert.deepEqual(numbers(a), ['s1:1', 'o1:null', 's2:2', 'r1:null', 's3:3']);
    new SqliteSellerLedger(openSqlite(path)); // a restart: nothing renumbered
    assert.deepEqual(numbers(a), ['s1:1', 'o1:null', 's2:2', 'r1:null', 's3:3']);
    await ledger.recordSettled('o1', TX, 1);
    assert.deepEqual(ledger.settledSince('seller-1', 0, 10).map((r) => [r.claimKey, r.settledSeq]), [['s1', 1], ['s2', 2], ['s3', 3], ['o1', 4]]);
    assert.equal(ledger.settledSince('seller-1', 3, 10)[0]?.logIndex, 1);
    assert.deepEqual(ledger.settledSince('other', 0, 10), []);
  });

  it('two processes settling at once never share or skip a settled_seq', async () => {
    const path = file();
    const a = new SqliteSellerLedger(openSqlite(path));
    const b = new SqliteSellerLedger(openSqlite(path));
    const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);
    for (const k of keys) await a.recordVerified(row(k));
    await Promise.all(keys.map((k, i) => (i % 2 === 0 ? a : b).recordSettled(k, TX, i)));
    assert.deepEqual(a.settledSince('seller-1', 0, 100).map((r) => r.settledSeq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('keeps every field across a restart', async () => {
    const path = file();
    const first = openSqlite(path);
    const l = new SqliteSellerLedger(first);
    await l.recordVerified(row('a'));
    await l.recordSettled('a', TX);
    await l.markDelivered('a');
    await l.recordVerified(row('b'));
    await l.recordRefused('b', E.SUBMIT_FAILED, TX);
    first.close();

    const again = new SqliteSellerLedger(openSqlite(path));
    assert.deepEqual(await again.get('a'), { ...row('a'), status: 'settled', delivered: true, txHash: TX });
    assert.deepEqual(await again.get('b'), { ...row('b'), status: 'refused', delivered: false, refusal: E.SUBMIT_FAILED, txHash: TX });
    assert.deepEqual((await again.list()).map((r) => r.claimKey), ['a', 'b']);
  });

  it('two processes on one file: a move from a stale view is refused (compare-and-set)', async () => {
    const path = file();
    const a = new SqliteSellerLedger(openSqlite(path));
    const b = new SqliteSellerLedger(openSqlite(path));
    await a.recordVerified(row());
    assert.equal((await b.get('k1'))?.status, 'owed');
    await a.recordSettled('k1', TX);
    await assert.rejects(b.recordRefused('k1', E.SETTLEMENT_TIMEOUT), { code: E.LEDGER_TRANSITION });
    assert.equal((await b.get('k1'))?.status, 'settled');
  });

  it('two processes moving the same row at once: exactly one move wins', async () => {
    const path = file();
    const a = new SqliteSellerLedger(openSqlite(path));
    const b = new SqliteSellerLedger(openSqlite(path));
    await a.recordVerified(row());
    await a.recordSubmitted('k1', TX);
    const results = await Promise.allSettled([a.recordSettled('k1', TX), b.recordRefused('k1', E.SETTLEMENT_TIMEOUT)]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    const lost = results.find((r) => r.status === 'rejected');
    assert.equal((lost as PromiseRejectedResult).reason.code, E.LEDGER_TRANSITION);
  });

  it('a move that loses the race still lands when the new status allows it (submitted, then settled)', async () => {
    const path = file();
    const a = new SqliteSellerLedger(openSqlite(path));
    const b = new SqliteSellerLedger(openSqlite(path));
    await a.recordVerified(row());
    // Both read `owed`; a's move lands first, so b's compare-and-set misses and must re-check against `submitted`.
    const [submitted, settled] = await Promise.all([a.recordSubmitted('k1', TX), b.recordSettled('k1', TX)]);
    assert.equal(submitted.status, 'submitted');
    assert.equal(settled.status, 'settled');
    assert.equal((await a.get('k1'))?.status, 'settled');
  });

  it('two processes on one file: one verified row, one delivery', async () => {
    const path = file();
    const a = new SqliteSellerLedger(openSqlite(path));
    const b = new SqliteSellerLedger(openSqlite(path));
    assert.equal((await a.recordVerified(row())).created, true);
    const second = await b.recordVerified({ ...row(), headerDigest: 'other' });
    assert.equal(second.created, false);
    assert.equal(second.row.headerDigest, 'd1');
    await a.recordSettled('k1', TX);
    assert.equal((await a.markDelivered('k1')).first, true);
    assert.equal((await b.markDelivered('k1')).first, false);
  });
});

describe('SqliteSingleUseStore', () => {
  it('lets the first claim win, refuses the reuse, and releases only with its token', async () => {
    const s = new SqliteSingleUseStore(openSqlite(':memory:'));
    const won = await s.claim('k', 100);
    assert.equal(won.ok, true);
    assert.deepEqual(await s.claim('k', 100), { ok: false, code: 'NONCE_REPLAY' });
    assert.equal(await s.release('k', 'not-the-token'), false);
    assert.equal(await s.release('k', won.ok ? won.token : ''), true);
    assert.equal((await s.claim('k', 100)).ok, true);
  });

  it('two processes on one file: a claim made by one blocks the other, and survives a restart', async () => {
    const path = file();
    const first = openSqlite(path);
    assert.equal((await new SqliteSingleUseStore(first).claim('k', 100)).ok, true);
    assert.deepEqual(await new SqliteSingleUseStore(openSqlite(path)).claim('k', 100), { ok: false, code: 'NONCE_REPLAY' });
    first.close();
    assert.deepEqual(await new SqliteSingleUseStore(openSqlite(path)).claim('k', 100), { ok: false, code: 'NONCE_REPLAY' });
  });

  it('an expired claim blocks until pruned, and prune removes only expired ones', async () => {
    const s = new SqliteSingleUseStore(openSqlite(':memory:'));
    await s.claim('old', 10);
    await s.claim('new', 20);
    assert.equal((await s.claim('old', 30)).ok, false);
    assert.equal(await s.prune(10), 1);
    assert.equal((await s.claim('old', 30)).ok, true);
    assert.equal((await s.claim('new', 30)).ok, false);
  });

  it('a full store refuses new claims without evicting a live one, and prune frees room', async () => {
    const s = new SqliteSingleUseStore(openSqlite(':memory:'), { maxEntries: 2 });
    await s.claim('a', 10);
    await s.claim('b', 20);
    assert.deepEqual(await s.claim('c', 30), { ok: false, code: 'STORE_FULL' });
    assert.deepEqual(await s.claim('a', 30), { ok: false, code: 'NONCE_REPLAY' });
    assert.equal(await s.prune(10), 1);
    assert.equal((await s.claim('c', 30)).ok, true);
    assert.deepEqual(await s.claim('b', 30), { ok: false, code: 'NONCE_REPLAY' });
    assert.throws(() => new SqliteSingleUseStore(openSqlite(':memory:'), { maxEntries: 0 }), { code: 'CONFIG_INVALID' });
  });

  it('refuses a non-integer expiry', async () => {
    const s = new SqliteSingleUseStore(openSqlite(':memory:'));
    await assert.rejects(s.claim('k', 1.5), { code: 'MALFORMED' });
  });

  it('works under claimPayment: one authorization at one seller only', async () => {
    const s = new SqliteSingleUseStore(openSqlite(':memory:'));
    const first = await claimPayment(s, PARTS, 100);
    assert.equal(first.ok, true);
    assert.deepEqual(await claimPayment(s, { ...PARTS, sellerAccountId: 'seller-2' }, 100), { ok: false, code: 'NONCE_REPLAY' });
    assert.equal(await releasePayment(s, first.ok ? first.claim : (undefined as never)), true);
    assert.equal((await claimPayment(s, { ...PARTS, sellerAccountId: 'seller-2' }, 100)).ok, true);
  });
});

describe('SqliteRateLimiter', () => {
  it('allows n per minute per key and resets after the window', () => {
    const rl = new SqliteRateLimiter(openSqlite(':memory:'));
    assert.equal(rl.take('k', 2, 0), true);
    assert.equal(rl.take('k', 2, 1), true);
    assert.equal(rl.take('k', 2, 2), false);
    assert.equal(rl.take('other', 2, 2), true);
    assert.equal(rl.take('k', 2, 59_999), false, 'the window is still open 1 ms before it ends');
    assert.equal(rl.take('k', 2, 60_000), true);
  });

  it('two processes on one file share one count', () => {
    const path = file();
    const a = new SqliteRateLimiter(openSqlite(path));
    const b = new SqliteRateLimiter(openSqlite(path));
    assert.equal(a.take('k', 2, 0), true);
    assert.equal(b.take('k', 2, 1), true);
    assert.equal(a.take('k', 2, 2), false);
  });

  it('forgets windows that have ended, so old keys do not pile up', () => {
    const db = openSqlite(':memory:');
    const rl = new SqliteRateLimiter(db);
    for (let i = 0; i < 5; i++) rl.take(`k${i}`, 1, 0);
    rl.take('late', 1, 60_000);
    assert.deepEqual({ ...db.prepare('SELECT count(*) AS n FROM rate_windows').get() }, { n: 1 });
  });

  it('stops counting once a key is over its limit, so a flooding key does not write on every request', () => {
    const db = openSqlite(':memory:');
    const rl = new SqliteRateLimiter(db);
    for (let i = 0; i < 10; i++) rl.take('k', 2, i);
    assert.deepEqual({ ...db.prepare('SELECT count FROM rate_windows WHERE key = ?').get('k') }, { count: 3 });
    assert.equal(rl.take('k', 2, 60_000), true, 'a new window still opens');
  });

  it('keeps at most maxKeys windows, dropping the oldest', () => {
    const db = openSqlite(':memory:');
    const rl = new SqliteRateLimiter(db, { maxKeys: 3 });
    for (let i = 0; i < 5; i++) rl.take(`k${i}`, 1, i);
    const keys = db.prepare('SELECT key FROM rate_windows ORDER BY key').all().map((r) => r.key);
    assert.deepEqual(keys, ['k2', 'k3', 'k4']);
  });
});

describe('accept() on SQLite stores', () => {
  it('settles a paid request, and after a restart answers its retry as a replay, not a second payment', async () => {
    const path = file();
    const db = openSqlite(path);
    const s = setup({}, {}, { ledger: new SqliteSellerLedger(db), claims: new SqliteSingleUseStore(db), rateLimiter: new SqliteRateLimiter(db) });
    const header = await payHeader(s.buyer);
    const first = await s.acceptor.handle(s.req({ 'payment-signature': header }));
    assert.equal(first.kind === 'paid' && first.paid.replayed, false);
    db.close();

    const reopened = openSqlite(path);
    const restarted = setup({}, {}, {
      ledger: new SqliteSellerLedger(reopened), claims: new SqliteSingleUseStore(reopened), rateLimiter: new SqliteRateLimiter(reopened),
    });
    const replay = await restarted.acceptor.handle(restarted.req({ 'payment-signature': header }));
    assert.equal(replay.kind === 'paid' && replay.paid.replayed, true, 'the restarted process found the settled row');
    assert.equal(replay.kind === 'paid' && first.kind === 'paid' && replay.paid.txHash, first.kind === 'paid' && first.paid.txHash);
  });
});
