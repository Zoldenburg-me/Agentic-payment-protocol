import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AcceptError, AcceptErrorCode as E, EXPIRY_GRACE_S, MemorySellerLedger, type SellerPayment } from '../src/index.js';
import { CLAIM_MARGIN_S } from 'agentpay-hub/protocol';
import { codeOf, payHeader, setup, tick } from './helpers.js';

const paid = (h: string) => ({ 'payment-signature': h });
const PAST_GRACE_MS = (120 + EXPIRY_GRACE_S + 1) * 1000;
const codesOf = (errors: unknown[]) => errors.map((e) => (e instanceof AcceptError ? e.code : 'raw'));

/** A row left `owed` and never broadcast: the submit reverted before sending. */
async function unsent(s: ReturnType<typeof setup>): Promise<SellerPayment> {
  s.chain.failNextSubmitRevert = 'replacement underpriced';
  await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
  const [row] = await s.ledger.list();
  assert.equal(row?.status, 'owed');
  return row as SellerPayment;
}

describe('reconcileOwed', () => {
  it('settles a payment whose request timed out once it is mined; the retry then delivers it', async () => {
    const s = setup({ settlementTimeoutMs: 5 }, { autoMine: false });
    const header = await payHeader(s.buyer);
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.SETTLEMENT_TIMEOUT);
    s.chain.mine(2);
    assert.deepEqual(await s.acceptor.reconcileOwed(), { checked: 1, settled: 1, refused: 0, open: 0 });
    assert.equal((await s.ledger.list())[0]?.status, 'settled');
    const r = await s.acceptor.handle(s.req(paid(header)));
    assert.ok(r.kind === 'paid' && r.paid.settled && !r.paid.replayed);
  });

  it('refuses a row never sent once its authorization has expired unused', async () => {
    const s = setup();
    await unsent(s);
    s.advance(PAST_GRACE_MS);
    assert.deepEqual(await s.acceptor.reconcileOwed(), { checked: 1, settled: 0, refused: 1, open: 0 });
    const [row] = await s.ledger.list();
    assert.equal(row?.status, 'refused');
    assert.equal(row?.refusal, E.EXPIRED);
  });

  it('leaves a row never sent but still valid open, and sends nothing (it holds no signature)', async () => {
    const s = setup();
    await unsent(s);
    assert.deepEqual(await s.acceptor.reconcileOwed(), { checked: 1, settled: 0, refused: 0, open: 1 });
    assert.equal(s.chain.submissions.length, 0);
    assert.equal((await s.ledger.list())[0]?.status, 'owed');
  });

  it('reports a use it cannot trace and leaves the row open', async () => {
    const s = setup();
    const row = await unsent(s);
    s.chain.cancelAuthorization(row.payer, row.nonce);
    s.errors.length = 0;
    assert.deepEqual(await s.acceptor.reconcileOwed(), { checked: 1, settled: 0, refused: 0, open: 1 });
    assert.deepEqual(codesOf(s.errors), [E.SETTLEMENT_UNKNOWN]);
    assert.equal((await s.ledger.list())[0]?.status, 'owed');
  });

  it('refuses a mined transfer that measures wrong, keeping its txHash, and reports it', async () => {
    const s = setup({ settlementTimeoutMs: 5 }, { autoMine: false });
    s.chain.tamperLogs = 'to';
    await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    s.chain.mine(2);
    assert.deepEqual(await s.acceptor.reconcileOwed(), { checked: 1, settled: 0, refused: 1, open: 0 });
    const [row] = await s.ledger.list();
    assert.equal(row?.refusal, E.TRANSFER_MISMATCH);
    assert.equal(row?.txHash, s.chain.submissions[0]);
    assert.deepEqual(codesOf(s.errors), [E.TRANSFER_MISMATCH]);
  });

  it('an RPC outage is reported, and the row stays open', async () => {
    const s = setup();
    await unsent(s);
    s.chain.failRpc = true;
    assert.deepEqual(await s.acceptor.reconcileOwed(), { checked: 1, settled: 0, refused: 0, open: 1 });
    assert.equal(s.errors.length, 1);
    assert.equal((await s.ledger.list())[0]?.status, 'owed');
  });

  it('leaves alone a payment this process is settling right now', async () => {
    const s = setup({}, { autoMine: false });
    const pending = s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    await s.chain.untilSubmitted(1);
    await tick(); // let the request reach its polling loop, so only reconcile's own reads could land in between
    const calls = s.chain.rpcCalls;
    assert.deepEqual(await s.acceptor.reconcileOwed(), { checked: 1, settled: 0, refused: 0, open: 1 });
    assert.equal(s.chain.rpcCalls, calls, 'no chain reads for it');
    s.chain.mine(2);
    assert.equal((await pending).kind, 'paid');
  });

  it('skips a row another process settled after the list was read', async () => {
    class StaleList extends MemorySellerLedger {
      stale: readonly SellerPayment[] = [];
      override async list(): Promise<readonly SellerPayment[]> {
        return this.stale;
      }
    }
    const ledger = new StaleList();
    const s = setup({ settlementTimeoutMs: 5 }, { autoMine: false }, { ledger });
    await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    const [row] = await MemorySellerLedger.prototype.list.call(ledger);
    ledger.stale = row ? [row] : [];
    s.chain.mine(2);
    await ledger.recordSettled(row?.claimKey ?? '', s.chain.submissions[0] ?? '');
    const calls = s.chain.rpcCalls;
    assert.deepEqual(await s.acceptor.reconcileOwed(), { checked: 0, settled: 0, refused: 0, open: 0 });
    assert.equal(s.chain.rpcCalls, calls);
  });

  it('ignores rows already settled or refused, without re-reading them', async () => {
    class CountingLedger extends MemorySellerLedger {
      gets = 0;
      override async get(claimKey: string): Promise<SellerPayment | undefined> {
        this.gets += 1;
        return super.get(claimKey);
      }
    }
    const ledger = new CountingLedger();
    const s = setup({}, {}, { ledger });
    await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    ledger.gets = 0;
    assert.deepEqual(await s.acceptor.reconcileOwed(), { checked: 0, settled: 0, refused: 0, open: 0 });
    assert.equal(ledger.gets, 0);
  });
});

describe('reconcileOwed re-prices stuck transactions first', () => {
  it('asks the submitter to replace stuck transactions, and reports any it could not', async () => {
    let asked = 0;
    const s = setup({}, {}, {});
    const withBump = setup({}, {}, {
      submitter: {
        submit: (c) => s.chain.submit(c),
        replaceStuck: async () => { asked += 1; return { replaced: 1, unreplaced: 2, cause: new Error('underpriced') }; },
      },
    });
    await withBump.acceptor.reconcileOwed();
    assert.equal(asked, 1);
    assert.deepEqual(codesOf(withBump.errors), [E.SUBMIT_FAILED]);
    assert.match((withBump.errors[0] as Error).message, /2 stuck/);
    assert.match(String(((withBump.errors[0] as Error).cause as Error).message), /underpriced/);
  });

  it('a failing replaceStuck is reported without its raw message (it may hold an RPC URL), and rows are still reconciled', async () => {
    const s = setup({ settlementTimeoutMs: 5 }, { autoMine: false });
    const cause = new Error('fetch failed: https://rpc.example/v2/SECRETKEY');
    const r = setup({ settlementTimeoutMs: 5 }, { autoMine: false }, {
      submitter: { submit: (c) => s.chain.submit(c), replaceStuck: () => Promise.reject(cause) },
    });
    assert.deepEqual(await r.acceptor.reconcileOwed(), { checked: 0, settled: 0, refused: 0, open: 0 });
    assert.deepEqual(codesOf(r.errors), [E.SUBMIT_FAILED]);
    assert.doesNotMatch((r.errors[0] as Error).message, /SECRETKEY/);
    assert.equal((r.errors[0] as Error).cause, cause);
  });

  it('prunes expired payment claims, so a long-running seller never fills the store', async () => {
    const s = setup();
    assert.equal((await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))))).kind, 'paid');
    s.advance((120 + CLAIM_MARGIN_S + 1) * 1000);
    await s.acceptor.reconcileOwed();
    assert.equal(await s.claims.prune(Number.MAX_SAFE_INTEGER), 0);
  });

  it('prunes expired claims even when reconciliation itself fails', async () => {
    const s = setup();
    assert.equal((await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))))).kind, 'paid');
    const outage = new Error('ledger offline');
    const r = setup({}, {}, { claims: s.claims, ledger: Object.assign(Object.create(s.ledger), { list: () => Promise.reject(outage) }) });
    r.advance((120 + CLAIM_MARGIN_S + 1) * 1000);
    await assert.rejects(r.acceptor.reconcileOwed(), outage);
    assert.equal(await s.claims.prune(Number.MAX_SAFE_INTEGER), 0);
  });

  it('keeps claims whose authorization could still be replayed', async () => {
    const s = setup();
    assert.equal((await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))))).kind, 'paid');
    await s.acceptor.reconcileOwed();
    assert.ok((await s.claims.prune(Number.MAX_SAFE_INTEGER)) > 0);
  });

  it('reports a failing prune and still returns the reconcile counts', async () => {
    const s = setup();
    const cause = new Error('store offline');
    const r = setup({}, {}, { claims: { claim: (k, e) => s.claims.claim(k, e), release: (k, t) => s.claims.release(k, t), prune: () => Promise.reject(cause) } });
    assert.deepEqual(await r.acceptor.reconcileOwed(), { checked: 0, settled: 0, refused: 0, open: 0 });
    assert.deepEqual(r.errors, [cause]);
  });

  it('nothing is reported when every stuck transaction was replaced', async () => {
    const r = setup({}, {}, { submitter: { submit: () => Promise.reject(new Error('unused')), replaceStuck: async () => ({ replaced: 3, unreplaced: 0 }) } });
    await r.acceptor.reconcileOwed();
    assert.equal(r.errors.length, 0);
  });
});
