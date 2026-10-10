import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import { type Hex, recoverTypedDataAddress } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { DEFAULT_ASSETS, PaymentHub, assetKey, evmX402Signer, mppAdapter, withAssets, x402Adapter } from '../src/index.js';
import { TRANSFER_WITH_AUTHORIZATION_TYPES, eip3009Domain } from '../src/wallets/evm.js';
import { ProtocolErrorCode as E } from '../src/protocol/errors.js';
import { verifyEip3009 } from '../src/protocol/verify-eip3009.js';
import { render } from '../src/mcp/render.js';
import { b64encode } from '../src/protocol/x402-codec.js';
import { DOMAIN, PAY_TO, USDC_SEPOLIA, fakeRpc, pinned } from './protocol/fixtures.js';

const requirements = (over: Record<string, unknown> = {}) => ({
  scheme: 'exact', network: 'eip155:84532', amount: '10000', asset: USDC_SEPOLIA,
  payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' }, ...over,
});
const paywall = () => new Response('pay', {
  status: 402,
  headers: { 'PAYMENT-REQUIRED': b64encode({ x402Version: 2, resource: { url: 'https://a.test/' }, accepts: [requirements()] }) },
});

describe('evm signer takes the EIP-712 domain from the asset registry, never from extra', () => {
  it('signs over the pinned domain even when extra names another', async () => {
    const signer = evmX402Signer(generatePrivateKey());
    const req = requirements({ extra: { name: 'Evil', version: '9' } });
    const { payload } = await signer.signX402(req as never, { url: 'https://a.test/' });
    const a = payload.authorization as Record<string, string>;
    const recovered = await recoverTypedDataAddress({
      domain: { ...DOMAIN, verifyingContract: DOMAIN.verifyingContract as Hex },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization',
      message: {
        from: a.from as Hex, to: a.to as Hex, value: BigInt(a.value ?? '0'),
        validAfter: BigInt(a.validAfter ?? '0'), validBefore: BigInt(a.validBefore ?? '0'), nonce: a.nonce as Hex,
      },
      signature: payload.signature as Hex,
    });
    assert.equal(recovered, signer.address);
  });

  it('pins Base mainnet USDC as "USD Coin" v2 (read on-chain 2026-10-10)', () => {
    const domain = eip3009Domain(requirements({ network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }) as never);
    assert.deepEqual(domain, { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' });
  });

  it('refuses to sign for an asset with no pinned domain', async () => {
    const signer = evmX402Signer(generatePrivateKey());
    await assert.rejects(
      signer.signX402(requirements({ asset: '0x0000000000000000000000000000000000000009' }) as never, { url: 'https://a.test/' }),
      { code: E.ASSET_DOMAIN_UNPINNED },
    );
  });

  it('refuses a registered asset that has no eip712 entry', () => {
    const assets = withAssets(DEFAULT_ASSETS, [[assetKey('eip155:84532', PAY_TO), { symbol: 'X', decimals: 6 }]]);
    assert.throws(() => eip3009Domain(requirements({ asset: PAY_TO }) as never, assets), { code: E.ASSET_DOMAIN_UNPINNED });
  });

  it('produces signatures the seller verifier accepts', async () => {
    const now = Date.now();
    const signer = evmX402Signer(generatePrivateKey(), () => now);
    const { payload } = await signer.signX402(requirements() as never, { url: 'https://a.test/' });
    const result = await verifyEip3009({ chainId: 84532, asset: USDC_SEPOLIA, ...payload }, pinned(), Math.floor(now / 1000), fakeRpc());
    assert.equal(result.ok, true);
  });
});

describe('MCP render', () => {
  it('does not claim a rejected payment was released', async () => {
    const quote = { protocol: 'x402' as const, url: 'https://a.test/', payee: PAY_TO, amount: { atomic: 1n, asset: USDC_SEPOLIA, network: 'eip155:84532' }, raw: {} };
    const out = await render({ status: 'rejected', response: new Response(null, { status: 402 }), quote });
    const text = out.content[0]?.text ?? '';
    assert.doesNotMatch(text, /released/);
    assert.match(text, /still counted against today's budget/);
    assert.equal('isError' in out && out.isError, true);
  });

  const quote = { protocol: 'x402' as const, url: 'https://a.test/', payee: PAY_TO, amount: { atomic: 10_000n, asset: USDC_SEPOLIA, network: 'eip155:84532' }, raw: {} };
  const parse = (out: Awaited<ReturnType<typeof render>>) => JSON.parse(out.content[0]?.text ?? '{}') as Record<string, unknown>;

  it('reports a free response with its redirect target, never following it', async () => {
    const out = parse(await render({ status: 'free', response: new Response('hi', { status: 302, headers: { location: 'https://b.test/' } }) }));
    assert.equal(out.redirectTo, 'https://b.test/');
    assert.equal(out.body, 'hi');
  });

  it('reports a paid response with the amount and receipt', async () => {
    const out = parse(await render({ status: 'paid', response: new Response('data'), quote, usdMicros: 10_000n, receipt: { protocol: 'x402', reference: '0xtx', raw: {} } }));
    assert.deepEqual([out.status, out.paidUsd, out.receipt, out.body], ['paid', '$0.010000', '0xtx', 'data']);
  });

  it('reports quoted and blocked offers, marking blocked as an error', async () => {
    const reports = [
      { quote, verdict: { ok: true as const, usdMicros: 10_000n }, canPay: true },
      { quote, verdict: { ok: false as const, reason: 'host not in allowlist' }, canPay: true },
    ];
    const quoted = await render({ status: 'quoted', quotes: reports });
    assert.equal((parse(quoted).options as unknown[]).length, 2);
    const blocked = await render({ status: 'blocked', quotes: reports });
    assert.equal('isError' in blocked && blocked.isError, true);
    assert.match(blocked.content[0]?.text ?? '', /host not in allowlist/);
  });

  it('marks an unsupported 402 as an error', async () => {
    const out = await render({ status: 'unsupported', response: new Response(null, { status: 402 }) });
    assert.equal('isError' in out && out.isError, true);
  });
});

describe('hub never carries payment headers across a redirect or origin', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });
  const listen = async (handler: Parameters<typeof createServer>[1]) => {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  it('a 307 on the paid retry is not followed, and the result is rejected', async () => {
    const seenByOther: Array<Record<string, unknown>> = [];
    const other = await listen((req, res) => { seenByOther.push(req.headers); res.end('stolen'); });
    const seller = await listen((req, res) => {
      if (req.headers['payment-signature']) return void res.writeHead(307, { location: `${other}/collect` }).end();
      res.writeHead(402, { 'PAYMENT-REQUIRED': paywall().headers.get('PAYMENT-REQUIRED') ?? '' }).end('pay');
    });
    const hub = new PaymentHub({ wallet: { x402: evmX402Signer(generatePrivateKey()) } });
    const result = await hub.request(`${seller}/r`);
    assert.equal(result.status, 'rejected');
    assert.equal(seenByOther.length, 0);
    assert.equal(hub.ledger.spentToday(), 10_000n);
  });

  it('a fetch that follows redirects anyway: a cross-origin paid response is rejected', async () => {
    let calls = 0;
    const hub = new PaymentHub({
      wallet: { x402: evmX402Signer(generatePrivateKey()) },
      fetch: async () => {
        calls++;
        if (calls === 1) return paywall();
        const res = new Response('ok');
        Object.defineProperty(res, 'redirected', { value: true });
        Object.defineProperty(res, 'url', { value: 'https://evil.test/collect' });
        return res;
      },
    });
    assert.equal((await hub.request('https://a.test/')).status, 'rejected');
  });

  it('a 402 that arrived via a redirect is never paid', async () => {
    let calls = 0;
    const hub = new PaymentHub({
      wallet: { x402: evmX402Signer(generatePrivateKey()) },
      fetch: async () => {
        calls++;
        const res = paywall();
        Object.defineProperty(res, 'redirected', { value: true });
        Object.defineProperty(res, 'url', { value: 'https://evil.test/pay' });
        return res;
      },
    });
    assert.equal((await hub.request('https://a.test/')).status, 'unsupported');
    assert.equal(calls, 1);
  });
});

describe('hub review hardening', () => {
  it('does not treat an x402 offer as payable when its asset has no pinned domain', async () => {
    let calls = 0;
    const assets = withAssets(DEFAULT_ASSETS, [[assetKey('eip155:84532', PAY_TO), { symbol: 'X', decimals: 6 }]]);
    const hub = new PaymentHub({
      wallet: { x402: evmX402Signer(generatePrivateKey()) }, assets,
      fetch: async () => {
        calls++;
        return new Response('pay', { status: 402, headers: { 'PAYMENT-REQUIRED': b64encode({ x402Version: 2, accepts: [requirements({ asset: PAY_TO })] }) } });
      },
    });
    const result = await hub.request('https://a.test/');
    assert.equal(result.status, 'blocked');
    assert.equal(calls, 1);
    assert.equal(hub.ledger.entries().length, 0);
  });

  it('never records a receipt reference from a redirect or a foreign origin', async () => {
    let calls = 0;
    const hub = new PaymentHub({
      wallet: { x402: evmX402Signer(generatePrivateKey()) },
      fetch: async () => {
        calls++;
        if (calls === 1) return paywall();
        return new Response(null, { status: 302, headers: { location: 'https://evil.test/', 'PAYMENT-RESPONSE': b64encode({ transaction: '0xforged' }) } });
      },
    });
    const result = await hub.request('https://a.test/');
    assert.equal(result.status, 'rejected');
    assert.equal(hub.ledger.entries()[0]?.reference, undefined);
  });

  it('says why a redirected 402 was not paid', async () => {
    const hub = new PaymentHub({
      wallet: { x402: evmX402Signer(generatePrivateKey()) },
      fetch: async () => {
        const res = paywall();
        Object.defineProperty(res, 'redirected', { value: true });
        return res;
      },
    });
    const result = await hub.request('https://a.test/');
    assert.equal(result.status, 'unsupported');
    if (result.status !== 'unsupported') return;
    assert.equal(result.reason, 'cross-origin');
    const out = await render(result);
    assert.match(out.content[0]?.text ?? '', /different origin/);
  });
});

describe('typed-data constants live in the protocol layer', () => {
  it('evm re-exports the protocol definition, so seller code need not import the signer', async () => {
    const protocol = await import('../src/protocol/eip3009-types.js');
    assert.equal(TRANSFER_WITH_AUTHORIZATION_TYPES, protocol.TRANSFER_WITH_AUTHORIZATION_TYPES);
  });
});

describe('hub round-2', () => {
  const crossOrigin = (res: Response, url = 'https://evil.test/x') => {
    Object.defineProperty(res, 'url', { value: url });
    return res;
  };
  const x402Wallet = () => ({ x402: evmX402Signer(generatePrivateKey()) });

  it('a 5xx on the paid retry is rejected, stays counted, and its receipt is ignored', async () => {
    let calls = 0;
    const hub = new PaymentHub({
      wallet: x402Wallet(),
      fetch: async () => (++calls === 1 ? paywall() : new Response('boom', { status: 500, headers: { 'PAYMENT-RESPONSE': b64encode({ transaction: '0xforged' }) } })),
    });
    const result = await hub.request('https://a.test/');
    assert.equal(result.status, 'rejected');
    assert.equal(hub.ledger.spentToday(), 10_000n);
    assert.equal(hub.ledger.entries()[0]?.reference, undefined);
  });

  it('a foreign url alone (no redirected flag) rejects the paid retry', async () => {
    let calls = 0;
    const hub = new PaymentHub({ wallet: x402Wallet(), fetch: async () => (++calls === 1 ? paywall() : crossOrigin(new Response('ok'))) });
    assert.equal((await hub.request('https://a.test/')).status, 'rejected');
  });

  it('a foreign url alone on the first 402 is unsupported (cross-origin)', async () => {
    const hub = new PaymentHub({ wallet: x402Wallet(), fetch: async () => crossOrigin(paywall()) });
    const result = await hub.request('https://a.test/');
    assert.equal(result.status === 'unsupported' && result.reason, 'cross-origin');
  });

  it('a v1 seller that puts its offer only in the 402 body is unsupported', async () => {
    let calls = 0;
    const hub = new PaymentHub({
      wallet: x402Wallet(),
      fetch: async () => { calls++; return new Response(JSON.stringify({ x402Version: 1, accepts: [requirements()] }), { status: 402 }); },
    });
    assert.equal((await hub.request('https://a.test/')).status, 'unsupported');
    assert.equal(calls, 1);
  });

  it('blocks instead of throwing when the signer cannot sign for a hub-registered asset', async () => {
    const custom = '0x0000000000000000000000000000000000000c0f';
    const assets = withAssets(DEFAULT_ASSETS, [[assetKey('eip155:84532', custom), { symbol: 'C', decimals: 6, eip712: { name: 'C', version: '1' } }]]);
    const hub = new PaymentHub({
      wallet: x402Wallet(), assets,
      fetch: async () => new Response('pay', { status: 402, headers: { 'PAYMENT-REQUIRED': b64encode({ x402Version: 2, accepts: [requirements({ asset: custom })] }) } }),
    });
    assert.equal((await hub.request('https://a.test/')).status, 'blocked');
    assert.equal(hub.ledger.spentToday(), 0n);
  });

  it('keeps an MPP amount counted when the signer throws (it may already have paid)', async () => {
    const assets = withAssets(DEFAULT_ASSETS, [[assetKey('mpp:tempo', '0xcur'), { symbol: 'T', decimals: 6 }]]);
    const request = Buffer.from(JSON.stringify({ amount: '10000', currency: '0xcur', recipient: '0xr' })).toString('base64url');
    const hub = new PaymentHub({
      wallet: { mpp: { source: 'did:x', payMpp: async () => { throw new Error('timeout after broadcast'); } } }, assets,
      fetch: async () => new Response('pay', { status: 402, headers: { 'WWW-Authenticate': `Payment id="a", method="tempo", intent="charge", request="${request}"` } }),
    });
    await assert.rejects(hub.request('https://a.test/'), /timeout after broadcast/);
    assert.equal(hub.ledger.spentToday(), 10_000n);
    assert.equal(hub.ledger.entries()[0]?.status, 'unconfirmed');
  });

  it('cancels the 402 body it does not hand back (quote mode)', async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const res = new Response(body, { status: 402, headers: paywall().headers });
    const hub = new PaymentHub({ wallet: x402Wallet(), fetch: async () => res });
    assert.equal((await hub.request('https://a.test/', {}, 'quote')).status, 'quoted');
    assert.equal(cancelled, true);
  });
});

describe('adapters round-2', () => {
  it('MPP: a challenge whose request is not an object is skipped, siblings still quoted', async () => {
    const good = Buffer.from(JSON.stringify({ amount: '1', currency: '0xc', recipient: '0xr' })).toString('base64url');
    const bad = Buffer.from('null').toString('base64url');
    const res = new Response(null, { status: 402, headers: { 'WWW-Authenticate': `Payment id="a", method="m", intent="charge", request="${bad}", Payment id="b", method="m", intent="charge", request="${good}"` } });
    const quotes = await mppAdapter.parseQuotes(res, 'https://a.test/');
    assert.deepEqual(quotes.map((q) => (q.raw as { id: string }).id), ['b']);
  });

  it('x402: a receipt reference must be a short string', () => {
    const receipt = (v: unknown) => x402Adapter.parseReceipt(new Response(null, { headers: { 'PAYMENT-RESPONSE': b64encode({ transaction: v }) } }));
    assert.equal(receipt('0xabc')?.reference, '0xabc');
    assert.equal(receipt({ x: 1 })?.reference, undefined);
    assert.equal(receipt(['0xabc'])?.reference, undefined);
    assert.equal(receipt('')?.reference, undefined);
    assert.equal(receipt('a'.repeat(257))?.reference, undefined);
  });

  it('MCP render survives a body that errors after payment', async () => {
    const quote = { protocol: 'x402' as const, url: 'https://a.test/', payee: PAY_TO, amount: { atomic: 1n, asset: USDC_SEPOLIA, network: 'eip155:84532' }, raw: {} };
    const body = new ReadableStream({ pull() { throw new Error('socket hang up'); } });
    const out = await render({ status: 'paid', response: new Response(body), quote, usdMicros: 1n });
    const parsed = JSON.parse(out.content[0]?.text ?? '{}') as Record<string, unknown>;
    assert.equal(parsed.status, 'paid');
    assert.equal(parsed.body, null);
    assert.equal(parsed.bodyError, 'the response body could not be read');
  });
});
