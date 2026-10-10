import type { MppChallenge } from '../types.js';
import { ProtocolError, ProtocolErrorCode as E } from './errors.js';

/** Upper bound on an MPP credential a seller will decode. */
export const MAX_CREDENTIAL_BYTES = 16 * 1024;

export const b64urlDecode = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');
export const b64urlEncode = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

/** Split a WWW-Authenticate value into the `Payment ...` challenges it contains. */
export function paymentSegments(header: string): string[] {
  return header
    .split(/(?:^|,\s*)(?=Payment\s+[a-z]+=)/i)
    .map((s) => s.trim())
    .filter((s) => /^payment\s/i.test(s));
}

export function parseParams(segment: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const m of segment.matchAll(/([A-Za-z][\w-]*)="([^"]*)"/g)) {
    if (m[1] && m[2] !== undefined) params[m[1]] = m[2];
  }
  return params;
}

export function toChallenge(params: Record<string, string>): MppChallenge | undefined {
  const { id, method, intent, request } = params;
  if (!id || !method || !intent || !request) return undefined;
  try {
    return { params, id, method, intent, request: JSON.parse(b64urlDecode(request)) };
  } catch {
    return undefined;
  }
}

const PARAM_NAME = /^[A-Za-z][\w-]*$/;

/** Seller side. Values are quoted-strings without escapes, so `"`, `\` and controls are refused. */
export function formatChallenge(params: Readonly<Record<string, string>>): string {
  const parts = Object.entries(params).map(([k, v]) => {
    if (!PARAM_NAME.test(k)) throw new ProtocolError(E.MPP_MALFORMED, 'invalid challenge param name');
    if (/["\\\u0000-\u001f\u007f]/.test(v)) throw new ProtocolError(E.MPP_MALFORMED, `challenge param ${k} cannot be quoted`);
    return `${k}="${v}"`;
  });
  return `Payment ${parts.join(', ')}`;
}

export interface MppCredential {
  readonly challenge: Readonly<Record<string, string>>;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly source?: string;
}

export const encodeCredential = (credential: MppCredential): string =>
  `Payment ${b64urlEncode(JSON.stringify(credential))}`;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Seller side: size-capped and strict. */
export function decodeCredential(header: string): MppCredential {
  const m = /^Payment ([A-Za-z0-9_-]+)$/.exec(header);
  if (!m?.[1]) throw new ProtocolError(E.MPP_MALFORMED, 'not a Payment credential');
  if (m[1].length > MAX_CREDENTIAL_BYTES) throw new ProtocolError(E.MPP_MALFORMED, 'credential too large');
  let decoded: unknown;
  try {
    decoded = JSON.parse(b64urlDecode(m[1]));
  } catch {
    throw new ProtocolError(E.MPP_MALFORMED, 'credential is not base64url JSON');
  }
  if (!isObject(decoded) || !isObject(decoded.challenge) || !isObject(decoded.payload)) {
    throw new ProtocolError(E.MPP_MALFORMED, 'credential needs challenge and payload objects');
  }
  if (!Object.values(decoded.challenge).every((v) => typeof v === 'string')) {
    throw new ProtocolError(E.MPP_MALFORMED, 'challenge params must be strings');
  }
  if (decoded.source !== undefined && typeof decoded.source !== 'string') {
    throw new ProtocolError(E.MPP_MALFORMED, 'source must be a string');
  }
  return {
    challenge: decoded.challenge as Record<string, string>,
    payload: decoded.payload,
    ...(decoded.source !== undefined ? { source: decoded.source } : {}),
  };
}
