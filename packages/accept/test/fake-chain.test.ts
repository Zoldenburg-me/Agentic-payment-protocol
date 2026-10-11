import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { TRANSFER_WITH_AUTHORIZATION_TYPES } from 'agentpay-hub/protocol';
import { ChainRevertError, FakeFiatToken, type TransferCall } from '../src/index.js';
import { CHAIN_ID, DOMAIN, NOW_S, PAY_TO, USDC } from './helpers.js';

// The settlement tests are only as good as this fake, so its FiatToken semantics are pinned here.
async function signed(over: Partial<TransferCall['authorization']> = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const authorization = {
    from: account.address as Hex, to: PAY_TO as Hex, value: 100n, validAfter: BigInt(NOW_S - 10),
    validBefore: BigInt(NOW_S + 60), nonce: `0x${'11'.repeat(32)}` as Hex, ...over,
  };
  const signature = await account.signTypedData({
    domain: DOMAIN, types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization', message: authorization,
  });
  return { account, call: { asset: USDC, authorization, signature } as TransferCall };
}

const fake = () => new FakeFiatToken({ chainId: CHAIN_ID, asset: USDC, domain: DOMAIN, nowSec: () => NOW_S });

describe('FakeFiatToken', () => {
  it('moves funds and emits AuthorizationUsed + Transfer for a valid authorization', async () => {
    const chain = fake();
    const { account, call } = await signed();
    chain.mint(account.address, 100n);
    const tx = await chain.submit(call);
    const receipt = await chain.getReceipt(tx);
    assert.equal(receipt?.status, 'success');
    assert.deepEqual(receipt?.logs.map((l) => l.event), ['AuthorizationUsed', 'Transfer']);
    assert.equal(chain.balanceOfSync(PAY_TO), 100n);
    assert.equal(await chain.authorizationState(USDC, account.address, call.authorization.nonce), true);
  });

  it('reverts like FiatToken on a reused nonce, a bad signature, an expired window and low balance', async () => {
    const chain = fake();
    const { account, call } = await signed();
    chain.mint(account.address, 1000n);
    await chain.submit(call);
    await assert.rejects(chain.submit(call), (e) => e instanceof ChainRevertError && /authorization is used/.test(e.message));
    const other = await signed({ nonce: `0x${'22'.repeat(32)}` });
    chain.mint(other.account.address, 1000n);
    await assert.rejects(chain.submit({ ...other.call, authorization: { ...other.call.authorization, value: 99n } }), (e) => e instanceof ChainRevertError && /invalid signature/.test(e.message));
    const expired = await signed({ validBefore: BigInt(NOW_S) });
    chain.mint(expired.account.address, 1000n);
    await assert.rejects(chain.submit(expired.call), (e) => e instanceof ChainRevertError && /authorization is expired/.test(e.message));
    const poor = await signed();
    await assert.rejects(chain.submit(poor.call), (e) => e instanceof ChainRevertError && /exceeds balance/.test(e.message));
  });

  it('simulates without changing state', async () => {
    const chain = fake();
    const { account, call } = await signed();
    chain.mint(account.address, 100n);
    await chain.simulateTransfer(call);
    assert.equal(chain.balanceOfSync(PAY_TO), 0n);
    assert.equal(await chain.authorizationState(USDC, account.address, call.authorization.nonce), false);
  });

  it('undoes a reorged transaction and can re-mine it', async () => {
    const chain = new FakeFiatToken({ chainId: CHAIN_ID, asset: USDC, domain: DOMAIN, nowSec: () => NOW_S, autoMine: false });
    const { account, call } = await signed();
    chain.mint(account.address, 100n);
    const tx = await chain.submit(call);
    chain.mine(1);
    assert.equal(chain.balanceOfSync(PAY_TO), 100n);
    chain.reorg(1, { remine: false });
    assert.equal(chain.balanceOfSync(PAY_TO), 0n);
    assert.equal(await chain.getReceipt(tx), undefined);
    const again = await chain.submit(call);
    chain.mine(1);
    chain.reorg(1, { remine: true });
    chain.mine(1);
    assert.equal((await chain.getReceipt(again))?.status, 'success');
    assert.equal(chain.balanceOfSync(PAY_TO), 100n);
  });

  it('finds the transaction that used an authorization', async () => {
    const chain = fake();
    const { account, call } = await signed();
    chain.mint(account.address, 100n);
    const tx = chain.externalSubmit(call);
    assert.equal(await chain.findAuthorizationUse(USDC, account.address, call.authorization.nonce), tx);
    assert.equal(await chain.findAuthorizationUse(USDC, account.address, `0x${'99'.repeat(32)}`), undefined);
  });

  it('counts RPC reads and fails them on demand', async () => {
    const chain = fake();
    await chain.blockNumber();
    assert.equal(chain.rpcCalls, 1);
    chain.failRpc = true;
    await assert.rejects(chain.blockNumber(), /rpc unavailable/);
  });
});
