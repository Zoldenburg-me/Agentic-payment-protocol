import type { X402Requirements, X402Resource } from '../types.js';
import { ProtocolError, ProtocolErrorCode as E } from './errors.js';

export const X402_HEADERS = {
  required: 'PAYMENT-REQUIRED',
  signature: 'PAYMENT-SIGNATURE',
  response: 'PAYMENT-RESPONSE',
} as const;

/** Longest signature validity we will grant or accept, however long the other side asks for. */
export const MAX_TIMEOUT_SECONDS = 300;

/** Upper bound on a PAYMENT-SIGNATURE header a seller will decode. */
export const MAX_HEADER_BYTES = 16 * 1024;
/** Upper bound on a PAYMENT-REQUIRED header the buyer will decode. */
export const MAX_REQUIRED_HEADER_BYTES = 64 * 1024;

export interface PaymentRequired {
  readonly x402Version: 2;
  readonly resource?: X402Resource;
  readonly accepts: readonly unknown[];
}

export interface PaymentSignature {
  readonly x402Version: 2;
  readonly resource?: X402Resource;
  readonly accepted: X402Requirements;
  readonly payload: Readonly<Record<string, unknown>>;
}

export const b64encode = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64');
export const b64decode = <T>(s: string): T => JSON.parse(Buffer.from(s, 'base64').toString('utf8')) as T;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function isValidRequirements(r: unknown): r is X402Requirements {
  if (!isObject(r)) return false;
  return (
    r.scheme === 'exact' &&
    // The only signer we ship is EVM (EIP-3009); offers on other chains cannot be paid.
    typeof r.network === 'string' && r.network.startsWith('eip155:') &&
    typeof r.asset === 'string' &&
    typeof r.payTo === 'string' &&
    typeof r.amount === 'string' && /^\d{1,78}$/.test(r.amount) &&
    Number.isInteger(r.maxTimeoutSeconds) &&
    (r.maxTimeoutSeconds as number) >= 1 && (r.maxTimeoutSeconds as number) <= MAX_TIMEOUT_SECONDS
  );
}

function decodeVersioned(header: string, maxBytes: number, canonical: boolean): Record<string, unknown> {
  if (Buffer.byteLength(header) > maxBytes) throw new ProtocolError(E.X402_MALFORMED, 'x402 header too large');
  // Canonical padded base64 only, so one payload has exactly one header spelling: the round
  // trip rejects the base64url alphabet, whitespace, missing padding and non-zero padding bits.
  if (canonical && Buffer.from(header, 'base64').toString('base64') !== header) {
    throw new ProtocolError(E.X402_MALFORMED, 'x402 header is not canonical base64');
  }
  let decoded: unknown;
  try {
    decoded = b64decode<unknown>(header);
  } catch {
    throw new ProtocolError(E.X402_MALFORMED, 'x402 header is not base64 JSON');
  }
  if (!isObject(decoded)) throw new ProtocolError(E.X402_MALFORMED, 'x402 header is not an object');
  if (decoded.x402Version === 1) throw new ProtocolError(E.X402_V1_UNSUPPORTED, 'x402 v1 is not supported');
  if (decoded.x402Version !== 2) throw new ProtocolError(E.X402_MALFORMED, 'unknown x402Version');
  return decoded;
}

function parseResource(v: unknown): X402Resource | undefined {
  if (!isObject(v) || typeof v.url !== 'string') return undefined;
  if (v.description !== undefined && typeof v.description !== 'string') return undefined;
  if (v.mimeType !== undefined && typeof v.mimeType !== 'string') return undefined;
  return {
    url: v.url,
    ...(v.description !== undefined ? { description: v.description as string } : {}),
    ...(v.mimeType !== undefined ? { mimeType: v.mimeType as string } : {}),
  };
}

/** Buyer side. Individual offers are filtered later; an invalid resource is dropped, never echoed. */
export function decodePaymentRequired(header: string): PaymentRequired {
  const decoded = decodeVersioned(header, MAX_REQUIRED_HEADER_BYTES, false);
  if (!Array.isArray(decoded.accepts)) throw new ProtocolError(E.X402_MALFORMED, 'accepts must be an array');
  const resource = parseResource(decoded.resource);
  return { x402Version: 2, accepts: decoded.accepts, ...(resource ? { resource } : {}) };
}

export const encodePaymentSignature = (sig: PaymentSignature): string => b64encode(sig);

/**
 * Seller side: size-capped, canonical, strict, and rebuilt from checked fields only.
 * `accepted` is what the payer claims; compare it to the pinned offer, never trust it.
 */
export function decodePaymentSignature(header: string): PaymentSignature {
  const decoded = decodeVersioned(header, MAX_HEADER_BYTES, true);
  if (!isValidRequirements(decoded.accepted)) throw new ProtocolError(E.X402_MALFORMED, 'accepted offer is invalid');
  if (!isObject(decoded.payload)) throw new ProtocolError(E.X402_MALFORMED, 'payload must be an object');
  const resource = parseResource(decoded.resource);
  if (decoded.resource !== undefined && !resource) throw new ProtocolError(E.X402_MALFORMED, 'resource is invalid');
  const a = decoded.accepted;
  const accepted: X402Requirements = {
    scheme: a.scheme, network: a.network, amount: a.amount, asset: a.asset, payTo: a.payTo,
    maxTimeoutSeconds: a.maxTimeoutSeconds, ...(isObject(a.extra) ? { extra: a.extra } : {}),
  };
  return { x402Version: 2, ...(resource ? { resource } : {}), accepted, payload: decoded.payload };
}
