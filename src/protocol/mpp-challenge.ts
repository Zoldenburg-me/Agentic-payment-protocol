import { createHmac, timingSafeEqual } from 'node:crypto';
import { type Hex, keccak256, toBytes } from 'viem';
import { ProtocolError, ProtocolErrorCode as E, type Refusal, refuse } from './errors.js';

/**
 * Stateless MPP challenges. The id is `<keyId>.<HMAC>` over the challenge fields, so the
 * seller needs no storage to know it issued a challenge. The EIP-3009 nonce is derived from
 * the id, so each payer can pay one challenge at most once on-chain. EIP-3009 nonces are
 * per payer: two different payers can each pay the same challenge (each pays in full). A
 * seller that wants one delivery per challenge must also claim the challenge id.
 */
export interface ChallengeKey {
  readonly id: string;
  readonly secret: Buffer;
}

/** Key N signs; keys N and N-1 verify, so a rotation never breaks challenges in flight. */
export interface ChallengeKeys {
  readonly current: ChallengeKey;
  readonly previous?: ChallengeKey;
}

export interface ChallengeFields {
  readonly realm: string;
  readonly method: string;
  readonly intent: string;
  /** base64url JSON; binds chainId, asset, payTo, amount and sellerAccountId. */
  readonly request: string;
  readonly expiresAt: Date;
  readonly digest?: string;
  readonly opaque?: string;
}

export type ChallengeVerdict =
  | { readonly ok: true; readonly id: string; readonly keyId: string; readonly nonce: Hex }
  | Refusal;

const MIN_SECRET_BYTES = 32;
const KEY_SPEC = /^([A-Za-z0-9_-]{1,32}):([A-Za-z0-9_-]+)$/;
const SEPARATOR = '|';
const REQUIRED = ['id', 'realm', 'method', 'intent', 'request', 'expires'] as const;
/** Exactly what `Date.prototype.toISOString` emits; the MAC covers this string. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MACED = ['realm', 'method', 'intent', 'request', 'expires', 'digest', 'opaque'] as const;

function parseKey(spec: string, label: string): ChallengeKey {
  const m = KEY_SPEC.exec(spec);
  if (!m?.[1] || !m[2]) throw new ProtocolError(E.CONFIG_INVALID, `${label} challenge key must be "<keyId>:<base64url secret>"`);
  const secret = Buffer.from(m[2], 'base64url');
  if (secret.length < MIN_SECRET_BYTES || secret.toString('base64url') !== m[2]) {
    throw new ProtocolError(E.CONFIG_INVALID, `${label} challenge key secret must be at least ${MIN_SECRET_BYTES} bytes of base64url`);
  }
  return { id: m[1], secret };
}

/** Strict: a malformed or short key is an error, never a weaker key. Messages never echo secrets. */
export function parseChallengeKeys(input: { readonly current: string; readonly previous?: string }): ChallengeKeys {
  const current = parseKey(input.current, 'current');
  if (input.previous === undefined) return { current };
  const previous = parseKey(input.previous, 'previous');
  if (previous.id === current.id) throw new ProtocolError(E.CONFIG_INVALID, 'current and previous challenge keys need distinct ids');
  return { current, previous };
}

const macInput = (f: Readonly<Record<string, string | undefined>>): string =>
  [f.realm, f.method, f.intent, f.request, f.expires, f.digest ?? '', f.opaque ?? ''].join(SEPARATOR);

const mac = (key: ChallengeKey, input: string): string =>
  createHmac('sha256', key.secret).update(input).digest('base64url');

export const challengeNonce = (id: string): Hex => keccak256(toBytes(id));

export function issueChallenge(keys: ChallengeKeys, fields: ChallengeFields): Record<string, string> {
  if (Number.isNaN(fields.expiresAt.getTime()) || !ISO_UTC.test(fields.expiresAt.toISOString())) {
    throw new ProtocolError(E.CHALLENGE_MALFORMED, 'expiresAt must be a date with a four-digit year');
  }
  const params: Record<string, string> = {
    realm: fields.realm, method: fields.method, intent: fields.intent, request: fields.request,
    expires: fields.expiresAt.toISOString(),
    ...(fields.digest !== undefined ? { digest: fields.digest } : {}),
    ...(fields.opaque !== undefined ? { opaque: fields.opaque } : {}),
  };
  if (Object.values(params).some((v) => v === '' || v.includes(SEPARATOR))) {
    throw new ProtocolError(E.CHALLENGE_MALFORMED, 'challenge fields must be non-empty and must not contain "|"');
  }
  return { id: `${keys.current.id}.${mac(keys.current, macInput(params))}`, ...params };
}

function keyFor(keys: ChallengeKeys, keyId: string): ChallengeKey | undefined {
  if (keys.current.id === keyId) return keys.current;
  return keys.previous?.id === keyId ? keys.previous : undefined;
}

/**
 * Order: shape, key, MAC (constant time, on the canonical string), then expiry.
 * Only the MAC'd fields are authenticated; any other param (e.g. `header`) is not.
 */
export function verifyChallenge(
  keys: ChallengeKeys, params: Readonly<Record<string, string>>, nowSec: number,
): ChallengeVerdict {
  if (REQUIRED.some((k) => typeof params[k] !== 'string' || params[k] === '')) return refuse(E.CHALLENGE_MALFORMED);
  const id = params.id as string;
  const dot = id.indexOf('.');
  const expiresMs = Date.parse(params.expires as string);
  // Exactly the issuer's form: ISO shape and a real calendar date (no 31 February).
  const canonicalExpiry = !Number.isNaN(expiresMs) && new Date(expiresMs).toISOString() === params.expires;
  if (dot <= 0 || !canonicalExpiry) return refuse(E.CHALLENGE_MALFORMED);
  if (params.digest === '' || params.opaque === '') return refuse(E.CHALLENGE_MALFORMED);
  if (MACED.some((k) => params[k]?.includes(SEPARATOR))) return refuse(E.CHALLENGE_MALFORMED);

  const keyId = id.slice(0, dot);
  const key = keyFor(keys, keyId);
  if (!key) return refuse(E.CHALLENGE_UNKNOWN_KEY);
  const expected = Buffer.from(mac(key, macInput(params)));
  const given = Buffer.from(id.slice(dot + 1));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return refuse(E.CHALLENGE_TAMPERED);

  if (Math.floor(expiresMs / 1000) <= nowSec) return refuse(E.CHALLENGE_EXPIRED);
  return { ok: true, id, keyId, nonce: challengeNonce(id) };
}
