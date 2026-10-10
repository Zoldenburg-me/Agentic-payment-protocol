import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { keccak256, toBytes } from 'viem';
import {
  type ChallengeFields, type ChallengeKeys, challengeNonce, issueChallenge, parseChallengeKeys, verifyChallenge,
} from '../../src/protocol/mpp-challenge.js';
import { b64urlEncode } from '../../src/protocol/mpp-codec.js';
import { ProtocolErrorCode as E } from '../../src/protocol/errors.js';

const NOW = 1_800_000_000;
const key = (id: string) => `${id}:${randomBytes(32).toString('base64url')}`;
const keysN1 = key('k1');
const keysN2 = key('k2');
const keysN3 = key('k3');

const fields = (over: Partial<ChallengeFields> = {}): ChallengeFields => ({
  realm: 'zoldhq.com', method: 'evm', intent: 'charge',
  request: b64urlEncode(JSON.stringify({ amount: '10000', chainId: 84532, asset: '0xa', payTo: '0xb', sellerAccountId: 's1' })),
  expiresAt: new Date((NOW + 300) * 1000), digest: 'sha-256=:abc:', opaque: 'o1', ...over,
});

describe('mpp challenge: issue and verify', () => {
  const keys = parseChallengeKeys({ current: keysN1 });

  it('verifies its own challenge and derives the EIP-3009 nonce from the id', () => {
    const params = issueChallenge(keys, fields());
    const result = verifyChallenge(keys, params, NOW);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(params.id ?? '', /^k1\./);
    assert.equal(result.id, params.id);
    assert.equal(result.nonce, keccak256(toBytes(params.id ?? '')));
    assert.equal(challengeNonce(params.id ?? ''), result.nonce);
  });

  for (const field of ['realm', 'method', 'intent', 'request', 'expires', 'digest', 'opaque'] as const) {
    it(`refuses a challenge whose ${field} was changed`, () => {
      const params = issueChallenge(keys, fields());
      const tampered = { ...params, [field]: field === 'expires' ? new Date((NOW + 3600) * 1000).toISOString() : `${params[field] ?? ''}x` };
      assert.deepEqual(verifyChallenge(keys, tampered, NOW), { ok: false, code: E.CHALLENGE_TAMPERED });
    });
  }

  it('refuses a challenge whose MAC was altered', () => {
    const params = issueChallenge(keys, fields());
    const id = params.id ?? '';
    const flipped = `${id.slice(0, -1)}${id.endsWith('A') ? 'B' : 'A'}`;
    assert.deepEqual(verifyChallenge(keys, { ...params, id: flipped }, NOW), { ok: false, code: E.CHALLENGE_TAMPERED });
  });

  it('refuses a non-canonical encoding of the valid MAC (padding bits flipped)', () => {
    const params = issueChallenge(keys, fields());
    const id = params.id ?? '';
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    // 32 bytes → 43 chars; the last char carries 4 data bits and 2 padding bits.
    const twin = alphabet[alphabet.indexOf(id.slice(-1)) ^ 1] ?? '';
    const malleated = `${id.slice(0, -1)}${twin}`;
    assert.deepEqual(Buffer.from(malleated.split('.')[1] ?? '', 'base64url'), Buffer.from(id.split('.')[1] ?? '', 'base64url'));
    assert.deepEqual(verifyChallenge(keys, { ...params, id: malleated }, NOW), { ok: false, code: E.CHALLENGE_TAMPERED });
  });

  it('refuses an optional field that was dropped', () => {
    const { opaque: _dropped, ...params } = issueChallenge(keys, fields());
    assert.deepEqual(verifyChallenge(keys, params, NOW), { ok: false, code: E.CHALLENGE_TAMPERED });
  });

  it('refuses an expired challenge', () => {
    const params = issueChallenge(keys, fields());
    assert.deepEqual(verifyChallenge(keys, params, NOW + 300), { ok: false, code: E.CHALLENGE_EXPIRED });
  });

  it('refuses at issue time any field containing the separator', () => {
    assert.throws(() => issueChallenge(keys, fields({ opaque: 'a|b' })), { code: E.CHALLENGE_MALFORMED });
  });

  it('refuses malformed params', () => {
    const params = issueChallenge(keys, fields());
    assert.deepEqual(verifyChallenge(keys, { ...params, id: 'nodot' }, NOW), { ok: false, code: E.CHALLENGE_MALFORMED });
    assert.deepEqual(verifyChallenge(keys, { ...params, expires: 'soon' }, NOW), { ok: false, code: E.CHALLENGE_MALFORMED });
    const { realm: _r, ...noRealm } = params;
    assert.deepEqual(verifyChallenge(keys, noRealm, NOW), { ok: false, code: E.CHALLENGE_MALFORMED });
  });
});

describe('mpp challenge: key rotation', () => {
  it('accepts challenges under key N and N-1, refuses N-2 and unknown key ids', () => {
    const k1: ChallengeKeys = parseChallengeKeys({ current: keysN1 });
    const k2: ChallengeKeys = parseChallengeKeys({ current: keysN2, previous: keysN1 });
    const k3: ChallengeKeys = parseChallengeKeys({ current: keysN3, previous: keysN2 });
    const byN1 = issueChallenge(k1, fields());
    const byN2 = issueChallenge(k2, fields());
    assert.equal(verifyChallenge(k2, byN1, NOW).ok, true);
    assert.equal(verifyChallenge(k2, byN2, NOW).ok, true);
    assert.equal(verifyChallenge(k3, byN2, NOW).ok, true);
    assert.deepEqual(verifyChallenge(k3, byN1, NOW), { ok: false, code: E.CHALLENGE_UNKNOWN_KEY });
  });

  it('refuses a challenge re-labelled with another key id', () => {
    const keys = parseChallengeKeys({ current: keysN2, previous: keysN1 });
    const params = issueChallenge(keys, fields());
    const relabelled = { ...params, id: (params.id ?? '').replace(/^k2\./, 'k1.') };
    assert.deepEqual(verifyChallenge(keys, relabelled, NOW), { ok: false, code: E.CHALLENGE_TAMPERED });
  });
});

describe('mpp challenge: strict key config', () => {
  for (const [label, input] of [
    ['a short secret', { current: `k1:${randomBytes(16).toString('base64url')}` }],
    ['no separator', { current: randomBytes(32).toString('base64url') }],
    ['a bad key id', { current: `k 1:${randomBytes(32).toString('base64url')}` }],
    ['a non-base64url secret', { current: `k1:${'!'.repeat(43)}` }],
    ['duplicate key ids', { current: keysN1, previous: key('k1') }],
    ['an empty current key', { current: '' }],
  ] as const) {
    it(`refuses ${label}`, () => {
      assert.throws(() => parseChallengeKeys(input), { code: E.CONFIG_INVALID });
    });
  }

  it('never puts the secret in the error message', () => {
    const secret = randomBytes(16).toString('base64url');
    assert.throws(() => parseChallengeKeys({ current: `k1:${secret}` }), (e: Error) => !e.message.includes(secret));
  });
});

describe('mpp challenge: review hardening', () => {
  const keys = parseChallengeKeys({ current: keysN1 });

  it('refuses a presented param containing the separator, even before the MAC', () => {
    const params = issueChallenge(keys, fields());
    assert.deepEqual(verifyChallenge(keys, { ...params, opaque: 'o|1' }, NOW), { ok: false, code: E.CHALLENGE_MALFORMED });
  });

  it('refuses expires that is not the issuer\'s ISO-8601 UTC form', () => {
    const params = issueChallenge(keys, fields());
    const lenient = new Date(params.expires ?? '').toUTCString();
    assert.deepEqual(verifyChallenge(keys, { ...params, expires: lenient }, NOW), { ok: false, code: E.CHALLENGE_MALFORMED });
  });

  for (const field of ['realm', 'digest', 'opaque'] as const) {
    it(`refuses an empty ${field} at issue time (absent and empty must not MAC alike)`, () => {
      assert.throws(() => issueChallenge(keys, fields({ [field]: '' })), { code: E.CHALLENGE_MALFORMED });
    });
  }
});

describe('mpp challenge: round-2', () => {
  const keys = parseChallengeKeys({ current: keysN1 });

  it('is valid one second before expiry and expired at a fractional expiry rounded down', () => {
    const params = issueChallenge(keys, fields());
    assert.equal(verifyChallenge(keys, params, NOW + 299).ok, true);
    const fractional = issueChallenge(keys, fields({ expiresAt: new Date((NOW + 300) * 1000 + 999) }));
    assert.deepEqual(verifyChallenge(keys, fractional, NOW + 300), { ok: false, code: E.CHALLENGE_EXPIRED });
  });

  it('the same key id with a rotated secret is tampered', () => {
    const params = issueChallenge(keys, fields());
    assert.deepEqual(verifyChallenge(parseChallengeKeys({ current: key('k1') }), params, NOW), { ok: false, code: E.CHALLENGE_TAMPERED });
  });

  it('checks the MAC before expiry (expired and forged → tampered)', () => {
    const params = issueChallenge(keys, fields());
    assert.deepEqual(verifyChallenge(keys, { ...params, realm: 'other' }, NOW + 9999), { ok: false, code: E.CHALLENGE_TAMPERED });
  });

  it('refuses an impossible calendar date even in ISO shape', () => {
    const params = issueChallenge(keys, fields());
    assert.deepEqual(verifyChallenge(keys, { ...params, expires: '2027-02-31T00:00:00.000Z' }, NOW), { ok: false, code: E.CHALLENGE_MALFORMED });
  });

  it('refuses a present-but-empty optional field at verify', () => {
    const { opaque: _o, ...params } = issueChallenge(keys, fields({ opaque: undefined }));
    assert.deepEqual(verifyChallenge(keys, { ...params, opaque: '' }, NOW), { ok: false, code: E.CHALLENGE_MALFORMED });
  });

  it('refuses at issue an expiry outside the four-digit-year ISO range', () => {
    assert.throws(() => issueChallenge(keys, fields({ expiresAt: new Date(Date.UTC(10000, 0, 1)) })), { code: E.CHALLENGE_MALFORMED });
  });
});
