import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Hex } from 'viem';
import { authorizationKey, b64decode } from 'agentpay-hub/protocol';
import { EXPIRY_GRACE_S, AcceptErrorCode as E, type TransferCall } from '../src/index.js';
import { CHAIN_ID, PAY_TO, PRICE, USDC, codeOf, payHeader, setup, tick } from './helpers.js';

const paid = (h: string) => ({ 'payment-signature': h });
/** Past validBefore (NOW + 120 s) plus the finalization grace. */
const PAST_GRACE_MS = (120 + EXPIRY_GRACE_S + 1) * 1000;
const NONCE = `0x${'11'.repeat(32)}` as const;

/** The on-chain call a third party could make with the buyer's signed authorization. */
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

describe('settle: before submitting', () => {
  it('an unfunded payer is refused and both claims are released (provably unsettled)', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    s.chain.burn(s.buyer.address);
    const r = await s.acceptor.handle(s.req(paid(header)));
    assert.equal(r.kind === 'respond' && r.status, 402);
    assert.equal(codeOf(r), E.INSUFFICIENT_FUNDS);
    const key = authorizationKey({ chainId: CHAIN_ID, asset: USDC, from: s.buyer.address, nonce: NONCE });
    assert.equal((await s.claims.claim(key, 1)).ok, true, 'chain-wide claim was released');
  });

  it('a failed simulation is refused and released', async () => {
    const s = setup();
    s.chain.failNextSimulation = 'FiatToken: account is blacklisted';
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    assert.equal(r.kind === 'respond' && r.status, 402);
    assert.equal(codeOf(r), E.SIMULATION_FAILED);
    assert.equal(s.chain.submissions.length, 0);
  });

  it('a cancelled authorization is refused and its claim is kept', async () => {
    const s = setup();
    s.chain.cancelAuthorization(s.buyer.address, NONCE);
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    assert.equal(r.kind === 'respond' && r.status, 402);
    assert.equal(codeOf(r), E.AUTHORIZATION_USED);
    const key = authorizationKey({ chainId: CHAIN_ID, asset: USDC, from: s.buyer.address, nonce: NONCE });
    assert.equal((await s.claims.claim(key, 1)).ok, false, 'chain-wide claim is kept');
  });

  it('an RPC outage is a 503, never a delivery', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    s.chain.failRpc = true;
    const r = await s.acceptor.handle(s.req(paid(header)));
    assert.equal(r.kind === 'respond' && r.status, 503);
    assert.equal(codeOf(r), E.RPC_UNAVAILABLE);
  });
});

describe('settle: front-running', () => {
  it('someone else submitted the authorization first: settle from their AuthorizationUsed + Transfer, deliver once', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    const theirs = s.chain.externalSubmit(callFrom(header));
    s.chain.mine(2);
    const r = await s.acceptor.handle(s.req(paid(header)));
    assert.equal(r.kind, 'paid');
    if (r.kind !== 'paid') return;
    assert.equal(r.paid.txHash, theirs);
    assert.equal(s.chain.submissions.length, 0);
    assert.equal(s.chain.balanceOfSync(PAY_TO), PRICE);
  });

  it('our submit reverts because a front-runner won the race: settle from their transaction', async () => {
    const s = setup();
    s.chain.frontRunNextSubmit = true;
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    assert.equal(r.kind, 'paid');
    if (r.kind !== 'paid') return;
    assert.equal(s.chain.submissions.length, 0, 'our submit reverted at estimation and was never broadcast');
    assert.equal(r.paid.txHash, s.chain.externalTxs[0]);
    assert.equal(s.chain.balanceOfSync(PAY_TO), PRICE);
  });

  it('our transaction is mined but reverted after a mempool front-run: settle from theirs', async () => {
    const s = setup();
    s.chain.revertNextSubmitOnChain = 'front-run';
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    assert.equal(r.kind, 'paid');
    if (r.kind !== 'paid') return;
    assert.notEqual(r.paid.txHash, s.chain.submissions[0]);
    assert.equal(s.chain.balanceOfSync(PAY_TO), PRICE);
  });

  it('our transaction reverts with the authorization unused: 502, but not final while it can still settle', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    s.chain.revertNextSubmitOnChain = 'plain';
    const r = await s.acceptor.handle(s.req(paid(header)));
    assert.equal(r.kind === 'respond' && r.status, 502);
    assert.equal(codeOf(r), E.SUBMIT_FAILED);
    const key = authorizationKey({ chainId: CHAIN_ID, asset: USDC, from: s.buyer.address, nonce: NONCE });
    assert.equal((await s.claims.claim(key, 1)).ok, false, 'claim kept: the authorization is still valid');
    assert.equal((await s.ledger.list())[0]?.status, 'submitted');
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.SUBMIT_FAILED);
    assert.equal((await s.ledger.list())[0]?.status, 'submitted', 'a retry before validBefore leaves it open');
    s.advance(PAST_GRACE_MS); // past validBefore: now it can never settle
    const again = await s.acceptor.handle(s.req(paid(header)));
    assert.equal(codeOf(again), E.SUBMIT_FAILED);
    assert.equal((await s.ledger.list())[0]?.status, 'refused');
  });

  it('an authorization that reverted for us but was later submitted by someone else is settled and delivered on retry', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    s.chain.revertNextSubmitOnChain = 'plain';
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.SUBMIT_FAILED);
    const theirs = s.chain.externalSubmit(callFrom(header));
    s.chain.mine(2);
    const again = await s.acceptor.handle(s.req(paid(header)));
    assert.ok(again.kind === 'paid');
    assert.equal(again.paid.txHash, theirs);
    assert.equal(s.chain.balanceOfSync(PAY_TO), PRICE);
  });

  for (const mode of ['value', 'to', 'drop-used', 'extra-transfer'] as const) {
    it(`never delivers when the measured logs do not match (${mode})`, async () => {
      const s = setup();
      s.chain.tamperLogs = mode;
      const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
      assert.equal(r.kind === 'respond' && r.status, 502);
      assert.equal(codeOf(r), E.TRANSFER_MISMATCH);
      const [row] = await s.ledger.list();
      assert.equal(row?.delivered, false);
      assert.equal(row?.status, 'refused');
    });
  }
});

describe('settle: confirmations and reorgs', () => {
  it('waits for minConfirmations before delivering', async () => {
    const s = setup({ minConfirmations: 3 }, { autoMine: false });
    let done = false;
    const pending = s.acceptor.handle(s.req(paid(await payHeader(s.buyer)))).then((r) => { done = true; return r; });
    await s.chain.untilSubmitted(1);
    s.chain.mine(2);
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(done, false, 'two confirmations are not enough');
    s.chain.mine(1);
    assert.equal((await pending).kind, 'paid');
  });

  it('a reorg that drops the transaction before 2 confirmations never delivers', async () => {
    const s = setup({ settlementTimeoutMs: 40 }, { autoMine: false });
    const pending = s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    await s.chain.untilSubmitted(1);
    s.chain.mine(1);
    for (let i = 0; i < 5; i++) await tick();
    s.chain.reorg(1, { remine: false });
    const r = await pending;
    assert.equal(r.kind === 'respond' && r.status, 503);
    assert.equal(codeOf(r), E.SETTLEMENT_TIMEOUT);
    assert.equal(s.chain.balanceOfSync(PAY_TO), 0n);
    const [row] = await s.ledger.list();
    assert.equal(row?.status, 'submitted', 'an ambiguous submit is left for reconciliation, never released');
    assert.equal(row?.delivered, false);
  });

  it('a reorg that re-mines the transaction later still delivers exactly once', async () => {
    const s = setup({}, { autoMine: false });
    const pending = s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    await s.chain.untilSubmitted(1);
    s.chain.mine(1);
    for (let i = 0; i < 5; i++) await tick();
    s.chain.reorg(1, { remine: true });
    s.chain.mine(2);
    const r = await pending;
    assert.equal(r.kind, 'paid');
    assert.equal(s.chain.balanceOfSync(PAY_TO), PRICE);
  });

  it('a transaction that never confirms times out without delivery or release', async () => {
    const s = setup({ settlementTimeoutMs: 20 }, { autoMine: false });
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    assert.equal(codeOf(r), E.SETTLEMENT_TIMEOUT);
    const [row] = await s.ledger.list();
    assert.equal(row?.status, 'submitted');
  });

  it('a submitter transport failure leaves the row owed for reconciliation', async () => {
    const s = setup();
    s.chain.failNextSubmitTransport = true;
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    assert.equal(r.kind === 'respond' && r.status, 503);
    assert.equal(codeOf(r), E.SUBMIT_FAILED);
    const [row] = await s.ledger.list();
    assert.equal(row?.status, 'owed');
  });
});

describe('settle: optimistic delivery', () => {
  const optimistic = { optimistic: { maxUsd: '0.50', readOnly: true as const } };

  it('delivers a cheap read-only request right after submit, then records settlement', async () => {
    const s = setup(optimistic, { autoMine: false });
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer))));
    assert.equal(r.kind, 'paid');
    if (r.kind !== 'paid') return;
    assert.equal(r.paid.settled, false);
    assert.equal((await s.ledger.get(r.paid.claimKey))?.status, 'submitted');
    s.chain.mine(2);
    await s.acceptor.idle();
    const row = await s.ledger.get(r.paid.claimKey);
    assert.equal(row?.status, 'settled');
    assert.equal(row?.delivered, true);
  });

  it('a front-run payment is settled normally, never delivered optimistically', async () => {
    const s = setup(optimistic);
    const header = await payHeader(s.buyer);
    s.chain.externalSubmit(callFrom(header));
    const r = await s.acceptor.handle(s.req(paid(header)));
    assert.ok(r.kind === 'paid');
    assert.equal(r.paid.settled, true);
  });

  it('never delivers optimistically for a non-read-only method', async () => {
    const s = setup(optimistic);
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer)), { method: 'POST' }));
    assert.ok(r.kind === 'paid' && r.paid.settled);
  });

  it('never delivers optimistically above maxUsd', async () => {
    const s = setup({ ...optimistic, price: () => ({ amount: 600_000n }) });
    const r = await s.acceptor.handle(s.req(paid(await payHeader(s.buyer, { value: 600_000n, accepted: { amount: '600000' } }))));
    assert.ok(r.kind === 'paid' && r.paid.settled);
  });

  it('an optimistically delivered payment that fails to settle is refused once it can no longer settle', async () => {
    const s = setup(optimistic, { autoMine: false });
    const header = await payHeader(s.buyer);
    s.chain.revertNextSubmitOnChain = 'plain';
    const r = await s.acceptor.handle(s.req(paid(header)));
    assert.ok(r.kind === 'paid' && !r.paid.settled);
    s.chain.mine(3);
    await s.acceptor.idle();
    const claimKey = r.kind === 'paid' ? r.paid.claimKey : '';
    assert.equal((await s.ledger.get(claimKey))?.status, 'submitted');
    s.advance(PAST_GRACE_MS);
    s.chain.mine(2);
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.SUBMIT_FAILED);
    const row = await s.ledger.get(claimKey);
    assert.equal(row?.status, 'refused');
    assert.equal(row?.delivered, true);
    assert.equal(row?.refusal, E.SUBMIT_FAILED);
  });
});
