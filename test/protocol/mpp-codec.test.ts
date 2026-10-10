import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_CREDENTIAL_BYTES, b64urlEncode, decodeCredential, encodeCredential, formatChallenge,
  parseParams, paymentSegments, toChallenge,
} from '../../src/protocol/mpp-codec.js';
import { ProtocolErrorCode as E } from '../../src/protocol/errors.js';

const request = b64urlEncode(JSON.stringify({ amount: '10000', currency: '0xabc', recipient: '0xdef' }));

describe('mpp codec: challenges', () => {
  it('splits Payment challenges out of a mixed WWW-Authenticate header', () => {
    const header = `Bearer realm="x", Payment id="a", method="tempo", intent="charge", request="${request}", Payment id="b", method="evm", intent="charge", request="${request}"`;
    const segments = paymentSegments(header);
    assert.equal(segments.length, 2);
    assert.deepEqual(segments.map((s) => parseParams(s).id), ['a', 'b']);
  });

  it('decodes request and refuses incomplete or undecodable challenges', () => {
    assert.deepEqual(toChallenge({ id: 'a', method: 'evm', intent: 'charge', request })?.request,
      { amount: '10000', currency: '0xabc', recipient: '0xdef' });
    assert.equal(toChallenge({ id: 'a', method: 'evm', intent: 'charge' }), undefined);
    assert.equal(toChallenge({ id: 'a', method: 'evm', intent: 'charge', request: '%%%' }), undefined);
  });

  it('formats a challenge that parses back to the same params', () => {
    const params = { id: 'k1.abc', realm: 'zold', method: 'evm', intent: 'charge', request, expires: '2027-01-01T00:00:00.000Z' };
    const header = formatChallenge(params);
    assert.match(header, /^Payment /);
    assert.deepEqual(parseParams(paymentSegments(header)[0] ?? ''), params);
  });

  for (const bad of ['a"b', 'a\\b', 'a\nb']) {
    it(`refuses to format a param value containing ${JSON.stringify(bad)}`, () => {
      assert.throws(() => formatChallenge({ id: bad }), { code: E.MPP_MALFORMED });
    });
  }
});

describe('mpp codec: credentials', () => {
  const credential = { challenge: { id: 'a', method: 'evm' }, payload: { signature: '0x01' }, source: 'did:pkh:eip155:84532:0x1' };

  it('round-trips a credential through the Payment auth scheme', () => {
    const header = encodeCredential(credential);
    assert.match(header, /^Payment [A-Za-z0-9_-]+$/);
    assert.deepEqual(decodeCredential(header), credential);
  });

  for (const [label, header] of [
    ['another auth scheme', `Bearer ${b64urlEncode(JSON.stringify(credential))}`],
    ['non-JSON', `Payment ${b64urlEncode('nope')}`],
    ['a non-string challenge param', `Payment ${b64urlEncode(JSON.stringify({ ...credential, challenge: { id: 1 } }))}`],
    ['a missing payload', `Payment ${b64urlEncode(JSON.stringify({ challenge: credential.challenge }))}`],
    ['an oversized but otherwise valid credential',
      encodeCredential({ ...credential, payload: { signature: '0x01', pad: 'x'.repeat(MAX_CREDENTIAL_BYTES) } })],
  ] as const) {
    it(`refuses ${label} as malformed`, () => {
      assert.throws(() => decodeCredential(header), { code: E.MPP_MALFORMED });
    });
  }
});

describe('mpp codec: round-2', () => {
  it('rebuilds a credential from its checked fields only', () => {
    const header = `Payment ${b64urlEncode(JSON.stringify({ challenge: { id: 'a' }, payload: { s: '0x01' }, source: 'did:x', extra: 1 }))}`;
    assert.deepEqual(Object.keys(decodeCredential(header)).sort(), ['challenge', 'payload', 'source']);
  });
});
