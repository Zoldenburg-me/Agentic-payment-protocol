import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { authorizationKey, singleUseKey } from 'agentpay-hub/protocol';
import { AcceptErrorCode as E, MemorySellerLedger, type SellerPayment, accept } from '../src/index.js';
import { CHAIN_ID, NOW_S, PAY_TO, PRICE, USDC, codeOf, payHeader, setup, sha256, tick } from './helpers.js';

const paid = (h: string) => ({ 'payment-signature': h });
const NONCE = `0x${'11'.repeat(32)}` as const;

/** A ledger whose next `get` misses, as if another request wrote the row just after our lookup. */
class LaggingLedger extends MemorySellerLedger {
  lagNext = false;

  override async get(claimKey: string): Promise<SellerPayment | undefined> {
    if (this.lagNext) {
      this.lagNext = false;
      return undefined;
    }
    return super.get(claimKey);
  }
}

function withLaggingLedger() {
  const s = setup();
  const ledger = new LaggingLedger();
  const acceptor = accept(s.options, {
    ledger, claims: s.claims, chain: s.chain, submitter: s.chain, now: () => NOW_S * 1000, sleep: tick, onError: () => undefined,
  });
  return { ...s, ledger, acceptor };
}

describe('races between the ledger lookup and the claim', () => {
  it('a retry that misses the delivered row at lookup still replays it after the claim collides', async () => {
    const s = withLaggingLedger();
    const header = await payHeader(s.buyer);
    const first = await s.acceptor.handle(s.req(paid(header)));
    s.ledger.lagNext = true;
    const again = await s.acceptor.handle(s.req(paid(header)));
    assert.ok(first.kind === 'paid' && again.kind === 'paid');
    assert.equal(again.paid.replayed, true);
    assert.equal(s.chain.submissions.length, 1);
  });

  it('a retry that misses the row at lookup collides on the claim and resumes the payment from the chain', async () => {
    const s = withLaggingLedger();
    const header = await payHeader(s.buyer);
    s.chain.revertNextSubmitOnChain = 'plain';
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.SUBMIT_FAILED);
    s.ledger.lagNext = true;
    const again = await s.acceptor.handle(s.req(paid(header)));
    assert.equal(codeOf(again), E.SUBMIT_FAILED);
    assert.equal(s.chain.submissions.length, 1, 'no second submit');
    const key = authorizationKey({ chainId: CHAIN_ID, asset: USDC, from: s.buyer.address, nonce: NONCE });
    assert.equal((await s.claims.claim(key, 1)).ok, false, 'still claimed while the authorization can settle');
  });

  it('a retry that re-claims a payment refused for good releases the claim it took', async () => {
    const s = withLaggingLedger();
    const header = await payHeader(s.buyer);
    s.chain.tamperLogs = 'to';
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.TRANSFER_MISMATCH);
    const key = authorizationKey({ chainId: CHAIN_ID, asset: USDC, from: s.buyer.address, nonce: NONCE });
    await s.claims.prune(Number.MAX_SAFE_INTEGER); // the earlier claims expired
    s.ledger.lagNext = true;
    assert.equal(codeOf(await s.acceptor.handle(s.req(paid(header)))), E.TRANSFER_MISMATCH);
    assert.equal((await s.claims.claim(key, 1)).ok, true);
  });
});

describe('crash recovery', () => {
  it('a payment settled but never delivered (crash in between) is delivered on retry', async () => {
    const s = setup();
    const header = await payHeader(s.buyer);
    const claimKey = singleUseKey({ sellerAccountId: 'seller-1', chainId: CHAIN_ID, asset: USDC, from: s.buyer.address, nonce: NONCE });
    await s.ledger.recordVerified({
      claimKey, sellerAccountId: 'seller-1', protocol: 'x402', chainId: CHAIN_ID, asset: USDC, payer: s.buyer.address,
      nonce: NONCE, amount: PRICE.toString(), payTo: PAY_TO, validBefore: String(NOW_S + 120), method: 'GET', path: '/rates', queryDigest: sha256(''),
      headerDigest: sha256(header), meta: {},
    });
    await s.ledger.recordSettled(claimKey, `0x${'aa'.repeat(32)}`);
    const r = await s.acceptor.handle(s.req(paid(header)));
    assert.ok(r.kind === 'paid');
    assert.equal(r.paid.replayed, false);
    assert.equal(r.paid.settled, true);
    assert.equal((await s.ledger.get(claimKey))?.delivered, true);
    assert.equal(s.chain.submissions.length, 0);
  });
});
