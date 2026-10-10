import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generatePrivateKey } from 'viem/accounts';
import {
  MAX_HEADER_BYTES, MAX_REQUIRED_HEADER_BYTES, MAX_TIMEOUT_SECONDS, X402_HEADERS, b64encode, decodePaymentRequired,
  decodePaymentSignature, encodePaymentSignature, isValidRequirements,
} from '../../src/protocol/x402-codec.js';
import { ProtocolErrorCode as E } from '../../src/protocol/errors.js';
import { PaymentHub, evmX402Signer } from '../../src/index.js';
import { PAY_TO, USDC_SEPOLIA } from './fixtures.js';

const requirements = (over: Record<string, unknown> = {}) => ({
  scheme: 'exact', network: 'eip155:84532', amount: '10000', asset: USDC_SEPOLIA,
  payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' }, ...over,
});
const resource = { url: 'https://a.test/' };

describe('x402 codec: PAYMENT-SIGNATURE', () => {
  it('round-trips a v2 payment signature', () => {
    const sig = { x402Version: 2 as const, resource, accepted: requirements(), payload: { signature: '0x01' } };
    assert.deepEqual(decodePaymentSignature(encodePaymentSignature(sig)), sig);
  });

  it('refuses x402 v1 with its own code', () => {
    const v1 = b64encode({ x402Version: 1, scheme: 'exact', network: 'base-sepolia', payload: {} });
    assert.throws(() => decodePaymentSignature(v1), { code: E.X402_V1_UNSUPPORTED });
  });

  for (const [label, header] of [
    ['an unknown version', b64encode({ x402Version: 3, resource, accepted: requirements(), payload: {} })],
    ['non-JSON base64', Buffer.from('not json').toString('base64')],
    ['a JSON array', b64encode([1, 2])],
    ['an invalid accepted offer', b64encode({ x402Version: 2, resource, accepted: requirements({ scheme: 'upto' }), payload: {} })],
    ['a missing payload', b64encode({ x402Version: 2, resource, accepted: requirements() })],
    ['an oversized but otherwise valid header', b64encode({
      x402Version: 2, resource: { url: 'https://a.test/', description: 'x'.repeat(MAX_HEADER_BYTES) },
      accepted: requirements(), payload: { signature: '0x01' },
    })],
  ] as const) {
    it(`refuses ${label} as malformed`, () => {
      assert.throws(() => decodePaymentSignature(header), { code: E.X402_MALFORMED });
    });
  }
});

describe('x402 codec: PAYMENT-REQUIRED', () => {
  it('decodes a v2 offer and keeps resource optional', () => {
    const decoded = decodePaymentRequired(b64encode({ x402Version: 2, accepts: [requirements()] }));
    assert.equal(decoded.accepts.length, 1);
    assert.equal(decoded.resource, undefined);
  });

  it('refuses x402 v1 with its own code', () => {
    assert.throws(() => decodePaymentRequired(b64encode({ x402Version: 1, accepts: [] })), { code: E.X402_V1_UNSUPPORTED });
  });

  it('refuses a missing accepts array as malformed', () => {
    assert.throws(() => decodePaymentRequired(b64encode({ x402Version: 2 })), { code: E.X402_MALFORMED });
  });
});

describe('x402 codec: requirements', () => {
  it('accepts maxTimeoutSeconds up to the cap and no further', () => {
    assert.equal(isValidRequirements(requirements({ maxTimeoutSeconds: MAX_TIMEOUT_SECONDS })), true);
    assert.equal(isValidRequirements(requirements({ maxTimeoutSeconds: MAX_TIMEOUT_SECONDS + 1 })), false);
  });

  it('keeps the header names of the v2 HTTP transport', () => {
    assert.deepEqual(X402_HEADERS, { required: 'PAYMENT-REQUIRED', signature: 'PAYMENT-SIGNATURE', response: 'PAYMENT-RESPONSE' });
  });
});

describe('hub refuses x402 v1', () => {
  it('reports a v1-only paywall as unsupported and never signs or retries', async () => {
    let calls = 0;
    const hub = new PaymentHub({
      wallet: { x402: evmX402Signer(generatePrivateKey()) },
      fetch: async () => {
        calls++;
        return new Response('pay', {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': b64encode({ x402Version: 1, accepts: [requirements()] }) },
        });
      },
    });
    assert.equal((await hub.request('https://a.test/')).status, 'unsupported');
    assert.equal(calls, 1);
  });
});

describe('x402 codec: review hardening', () => {
  for (const [label, resourceValue] of [
    ['a string resource', 'x'],
    ['a null resource', null],
    ['a resource with a non-string url', { url: 123 }],
    ['a resource with a non-string description', { url: 'https://a.test/', description: 1 }],
  ] as const) {
    it(`seller refuses ${label}`, () => {
      const header = b64encode({ x402Version: 2, resource: resourceValue, accepted: requirements(), payload: {} });
      assert.throws(() => decodePaymentSignature(header), { code: E.X402_MALFORMED });
    });
  }

  it('seller rebuilds the object, dropping unknown top-level fields', () => {
    const decoded = decodePaymentSignature(b64encode({ x402Version: 2, accepted: requirements(), payload: { a: 1 }, extra: 'x' }));
    assert.deepEqual(Object.keys(decoded).sort(), ['accepted', 'payload', 'x402Version']);
  });

  it('seller refuses non-canonical base64 (base64url alphabet, whitespace, missing padding)', () => {
    const canonical = encodePaymentSignature({ x402Version: 2, accepted: requirements() as never, payload: { pad: '>>>???' } });
    for (const variant of [canonical.replace(/\+/g, '-').replace(/\//g, '_'), ` ${canonical}`, canonical.replace(/=+$/, '')]) {
      if (variant === canonical) continue;
      assert.throws(() => decodePaymentSignature(variant), { code: E.X402_MALFORMED });
    }
  });

  it('buyer caps PAYMENT-REQUIRED too', () => {
    const big = b64encode({ x402Version: 2, accepts: [requirements()], pad: 'x'.repeat(MAX_REQUIRED_HEADER_BYTES) });
    assert.throws(() => decodePaymentRequired(big), { code: E.X402_MALFORMED });
  });

  it('buyer drops an invalid resource rather than echoing it back', () => {
    const decoded = decodePaymentRequired(b64encode({ x402Version: 2, resource: 'x', accepts: [] }));
    assert.equal(decoded.resource, undefined);
  });
});

describe('x402 codec: round-2', () => {
  it('refuses base64 with non-zero padding bits (one payload, one spelling)', () => {
    const canonical = ['1', '12', '123']
      .map((a) => encodePaymentSignature({ x402Version: 2, accepted: requirements() as never, payload: { a } }))
      .find((h) => h.endsWith('=')) ?? '';
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const body = canonical.replace(/=+$/, '');
    const last = body.slice(-1);
    const twin = `${body.slice(0, -1)}${alphabet[alphabet.indexOf(last) ^ 1]}${canonical.slice(body.length)}`;
    assert.deepEqual(Buffer.from(twin, 'base64'), Buffer.from(canonical, 'base64'));
    assert.throws(() => decodePaymentSignature(twin), { code: E.X402_MALFORMED });
  });

  it('rebuilds accepted from its known fields only', () => {
    const decoded = decodePaymentSignature(b64encode({ x402Version: 2, accepted: { ...requirements(), sneaky: 1 }, payload: {} }));
    assert.deepEqual(Object.keys(decoded.accepted).sort(), ['amount', 'asset', 'extra', 'maxTimeoutSeconds', 'network', 'payTo', 'scheme']);
  });

  it('refuses an amount longer than a uint256', () => {
    assert.equal(isValidRequirements(requirements({ amount: '1'.repeat(79) })), false);
  });
});
