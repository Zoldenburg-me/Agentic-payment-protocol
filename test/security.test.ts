import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { generatePrivateKey } from 'viem/accounts';
import {
  DEFAULT_ASSETS, Ledger, PaymentHub, assetKey, evmX402Signer, toUsdMicros, withAssets, x402Adapter,
  type Wallet,
} from '../src/index.js';
import { isNonPublicIp, redactUrl } from '../src/net-guard.js';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const requirements = (over: Record<string, unknown> = {}) => ({
  scheme: 'exact', network: 'eip155:84532', amount: '10000', asset: USDC,
  payTo: '0x000000000000000000000000000000000000dEaD', maxTimeoutSeconds: 60,
  extra: { name: 'USDC', version: '2' }, ...over,
});
const challenge = (accepts: unknown[]) =>
  new Response('pay', {
    status: 402,
    headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: 'https://a.test/' }, accepts })).toString('base64') },
  });
const wallet = (): Wallet => ({ x402: evmX402Signer(generatePrivateKey()) });
const tmpLedger = () => join(mkdtempSync(join(tmpdir(), 'agentpay-')), 'ledger.jsonl');

describe('x402 offer validation', () => {
  it('drops offers with a string, huge or non-integer maxTimeoutSeconds', async () => {
    const res = challenge([
      requirements({ maxTimeoutSeconds: '60' }),
      requirements({ maxTimeoutSeconds: 1e12 }),
      requirements({ maxTimeoutSeconds: 1.5 }),
      requirements({ payTo: 42 }),
      null,
      requirements(),
    ]);
    const quotes = await x402Adapter.parseQuotes(res, 'https://a.test/');
    assert.equal(quotes.length, 1);
  });

  it('drops offers on non-EVM networks such as Solana', async () => {
    const res = challenge([
      requirements({ network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', extra: { feePayer: 'x' } }),
      requirements(),
    ]);
    const quotes = await x402Adapter.parseQuotes(res, 'https://a.test/');
    assert.deepEqual(quotes.map((q) => q.amount.network), ['eip155:84532']);
  });
});

describe('redirects and headers', () => {
  it('never follows redirects and never pays a redirecting server', async () => {
    let calls = 0;
    const hub = new PaymentHub({
      wallet: wallet(),
      fetch: async (_url, init) => {
        calls++;
        assert.equal(init?.redirect, 'manual');
        return new Response(null, { status: 302, headers: { location: 'https://evil.test/' } });
      },
    });
    const result = await hub.request('https://a.test/');
    assert.equal(result.status, 'free');
    assert.equal(calls, 1);
  });

  it('strips agent-supplied payment headers before attaching real ones', async () => {
    const seen: Array<Record<string, string>> = [];
    const hub = new PaymentHub({
      wallet: wallet(),
      fetch: async (_url, init) => {
        seen.push({ ...(init?.headers as Record<string, string>) });
        return seen.length === 1 ? challenge([requirements()]) : new Response('ok');
      },
    });
    await hub.request('https://a.test/', { headers: { 'payment-signature': 'forged', 'X-Keep': '1' } });
    const second = seen[1] ?? {};
    assert.equal(second['X-Keep'], '1');
    assert.notEqual(second['payment-signature'], 'forged');
    assert.ok(second['PAYMENT-SIGNATURE']);
  });
});

describe('budget accounting', () => {
  it('releases the reservation when signing fails before anything is sent', async () => {
    const broken: Wallet = {
      x402: { address: '0x0', signX402: async () => { throw new Error('boom'); } },
    };
    const hub = new PaymentHub({ wallet: broken, fetch: async () => challenge([requirements()]) });
    await assert.rejects(hub.request('https://a.test/'), /boom/);
    assert.equal(hub.ledger.spentToday(), 0n);
  });

  it('keeps the amount counted when the server answers 402 after receiving a signature', async () => {
    const hub = new PaymentHub({ wallet: wallet(), fetch: async () => challenge([requirements()]) });
    const result = await hub.request('https://a.test/');
    assert.equal(result.status, 'rejected');
    assert.equal(hub.ledger.spentToday(), 10_000n);
  });

  it('rounds sub-micro amounts up so dust still counts', () => {
    const assets = withAssets(DEFAULT_ASSETS, [[assetKey('eip155:1', '0xdust'), { symbol: 'D', decimals: 18 }]]);
    assert.equal(toUsdMicros({ atomic: 1n, asset: '0xdust', network: 'eip155:1' }, assets), 1n);
  });

  it('matches allowed hosts case-insensitively', async () => {
    const hub = new PaymentHub({
      wallet: wallet(), policy: { allowedHosts: ['API.A.test'] },
      fetch: async (_u, init) => ((init?.headers as Record<string, string> | undefined)?.['PAYMENT-SIGNATURE']
        ? new Response('ok') : challenge([requirements()])),
    });
    assert.equal((await hub.request('https://api.a.test/x')).status, 'paid');
  });
});

describe('ledger robustness', () => {
  it('survives a torn last line and ignores tampered negative amounts', () => {
    const path = tmpLedger();
    const ledger = new Ledger(path);
    const id = ledger.reserve('https://a.test/', 'x402', 5_000n);
    ledger.settle(id, 'paid');
    appendFileSync(path, '{"id":"x","at":"2026-10-07T00:00:00.000Z","url":"u","protocol":"x402","usdMicros":"-9","status":"paid"}\n');
    appendFileSync(path, '{"id":"torn","at":');
    assert.equal(new Ledger(path).spentToday(), 5_000n);
  });

  it('creates the ledger file readable only by its owner', () => {
    const path = tmpLedger();
    new Ledger(path);
    assert.equal(statSync(path).mode & 0o077, 0);
    assert.equal(readFileSync(path, 'utf8'), '');
  });
});

describe('net guard', () => {
  it('flags internal addresses and accepts public ones', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1', '192.168.1.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
      assert.equal(isNonPublicIp(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isNonPublicIp(ip), false, ip);
  });

  it('redacts query strings from URLs', () => {
    assert.equal(redactUrl('https://a.test/p?token=secret#x'), 'https://a.test/p');
  });
});
