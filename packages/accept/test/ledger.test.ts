import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AcceptErrorCode as E, MemorySellerLedger, type NewSellerPayment, type SellerLedgerPort } from '../src/index.js';
import { SqliteSellerLedger, openSqlite } from '../src/sqlite/index.js';
import { CHAIN_ID, PAY_TO, USDC } from './helpers.js';

const row = (claimKey = 'k1'): NewSellerPayment => ({
  claimKey, sellerAccountId: 'seller-1', protocol: 'x402', chainId: CHAIN_ID, asset: USDC, payer: PAY_TO,
  nonce: `0x${'11'.repeat(32)}`, amount: '10000', payTo: PAY_TO, validBefore: '1800000120', method: 'GET', path: '/rates', queryDigest: '',
  headerDigest: 'd1', meta: {},
});
const TX = `0x${'aa'.repeat(32)}` as const;

const LEDGERS: readonly [string, () => SellerLedgerPort][] = [
  ['MemorySellerLedger', () => new MemorySellerLedger()],
  ['SqliteSellerLedger', () => new SqliteSellerLedger(openSqlite(':memory:'))],
];

for (const [name, make] of LEDGERS) describe(name, () => {
  it('records a verified payment as owed, once', async () => {
    const l = make();
    const first = await l.recordVerified(row());
    assert.equal(first.created, true);
    assert.equal(first.row.status, 'owed');
    assert.equal(first.row.delivered, false);
    const again = await l.recordVerified({ ...row(), headerDigest: 'other' });
    assert.equal(again.created, false);
    assert.equal(again.row.headerDigest, 'd1', 'an existing row is never overwritten');
  });

  it('moves forward only: owed → submitted → settled', async () => {
    const l = make();
    await l.recordVerified(row());
    assert.equal((await l.recordSubmitted('k1', TX)).status, 'submitted');
    assert.equal((await l.recordSettled('k1', TX, 0)).status, 'settled');
    await assert.rejects(l.recordSubmitted('k1', TX), { code: E.LEDGER_TRANSITION });
    await assert.rejects(l.recordRefused('k1', E.SUBMIT_FAILED), { code: E.LEDGER_TRANSITION });
  });

  it('allows settling straight from owed (front-run) and refusing from owed or submitted', async () => {
    const l = make();
    await l.recordVerified(row('a'));
    assert.equal((await l.recordSettled('a', TX, 0)).status, 'settled');
    await l.recordVerified(row('b'));
    await l.recordSubmitted('b', TX);
    const refused = await l.recordRefused('b', E.SETTLEMENT_TIMEOUT);
    assert.equal(refused.status, 'refused');
    assert.equal(refused.refusal, E.SETTLEMENT_TIMEOUT);
    await assert.rejects(l.recordSettled('b', TX, 0), { code: E.LEDGER_TRANSITION });
  });

  it('marks delivery exactly once', async () => {
    const l = make();
    await l.recordVerified(row());
    await l.recordSettled('k1', TX, 0);
    assert.equal((await l.markDelivered('k1')).first, true);
    assert.equal((await l.markDelivered('k1')).first, false);
  });

  it('never marks a refused, undelivered payment as delivered', async () => {
    const l = make();
    await l.recordVerified(row());
    await l.recordRefused('k1', E.SUBMIT_FAILED);
    await assert.rejects(l.markDelivered('k1'), { code: E.LEDGER_TRANSITION });
  });

  it('refuses transitions for unknown rows', async () => {
    const l = make();
    await assert.rejects(l.markDelivered('nope'), { code: E.LEDGER_TRANSITION });
  });

  it('hands out immutable snapshots', async () => {
    const l = make();
    const { row: r } = await l.recordVerified(row());
    assert.throws(() => { (r as { status: string }).status = 'settled'; });
    assert.equal((await l.get('k1'))?.status, 'owed');
  });

  it('lists rows in insertion order', async () => {
    const l = make();
    await l.recordVerified(row('a'));
    await l.recordVerified(row('b'));
    assert.deepEqual((await l.list()).map((r) => r.claimKey), ['a', 'b']);
  });
});
