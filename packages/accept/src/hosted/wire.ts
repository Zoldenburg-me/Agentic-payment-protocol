import type { AcceptResult, PaidContext, ReqLike } from '../accept.js';
import type { Price } from '../config.js';

/**
 * The one call a hosted seller makes: POST /api/agent-payments/settle with its `zsk_` key. Only the
 * headers payment needs travel; the seller prices locally and Zold settles at that price.
 */
export interface SettleRequest {
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly query: string;
    readonly headers: Readonly<Partial<Record<ForwardedHeader, string>>>;
    readonly clientIp: string;
  };
  readonly price: { readonly amount: string; readonly meta?: Readonly<Record<string, string>>; readonly contentLength?: number };
}

/** An AcceptResult as JSON: the amount travels as a decimal string. */
export type SettleResponse =
  | { readonly kind: 'respond'; readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string }
  | { readonly kind: 'paid'; readonly headers: Readonly<Record<string, string>>; readonly paid: Omit<PaidContext, 'amount'> & { readonly amount: string } };

export const FORWARDED_HEADERS = ['payment-signature', 'authorization', 'payment-authorization', 'content-length'] as const;
export type ForwardedHeader = (typeof FORWARDED_HEADERS)[number];

const MAX_HEADER = 16_384;
const MAX_META_ENTRIES = 32;
const MAX_META_VALUE = 1_024;
const AMOUNT = /^[1-9]\d{0,77}$/;
const MAX_UINT256 = 2n ** 256n - 1n;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
/** Only the headers the core itself sets: an answer can never set cookies, redirect or reframe the response. */
const ANSWER_HEADERS = new Set(['content-type', 'cache-control', 'retry-after', 'payment-required', 'payment-response']);
const METHOD = /^[A-Z]{1,16}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (o: Obj, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every((k) => k in o) && Object.keys(o).every((k) => required.includes(k) || optional.includes(k));
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isAmount = (v: unknown): v is string => str(v, 78) && AMOUNT.test(v) && BigInt(v) <= MAX_UINT256;
const isAnswerHeaders = (v: unknown): v is Record<string, string> =>
  isStringRecord(v, ANSWER_HEADERS.size, MAX_HEADER) && Object.keys(v).every((k) => ANSWER_HEADERS.has(k.toLowerCase()));
export const isStringRecord = (v: unknown, maxEntries: number, maxValue: number): v is Record<string, string> =>
  isObj(v) && Object.keys(v).length <= maxEntries && Object.values(v).every((x) => str(x, maxValue));

/** Only what payment needs: an Authorization header only when it carries an MPP Payment credential. */
export function forwardedHeaders(headers: ReqLike['headers']): Partial<Record<ForwardedHeader, string>> {
  const out: Partial<Record<ForwardedHeader, string>> = {};
  for (const name of FORWARDED_HEADERS) {
    const value = headers[name];
    if (value === undefined) continue;
    if (name === 'authorization' && !/^payment\s/i.test(value)) continue;
    out[name] = value;
  }
  return out;
}

/** The request half of a settle request, as Zold will accept it; undefined if Zold would refuse it. */
export function parseForwardedRequest(r: unknown): ReqLike | undefined {
  if (!isObj(r) || !exactKeys(r, ['method', 'path', 'query', 'headers', 'clientIp'])) return undefined;
  if (!str(r.method, 16) || !METHOD.test(r.method) || !str(r.path, 2_048) || !str(r.query, 4_096) || !str(r.clientIp, 64)) return undefined;
  const headers = r.headers;
  if (!isStringRecord(headers, FORWARDED_HEADERS.length, MAX_HEADER)) return undefined;
  if (!Object.keys(headers).every((k) => (FORWARDED_HEADERS as readonly string[]).includes(k))) return undefined;
  return { method: r.method, path: r.path, query: r.query, headers: { ...headers }, clientIp: r.clientIp };
}

/** The price half of a settle request; undefined if Zold would refuse it. */
export function parseWirePrice(p: unknown): Price | undefined {
  if (!isObj(p) || !exactKeys(p, ['amount'], ['meta', 'contentLength'])) return undefined;
  if (!isAmount(p.amount)) return undefined;
  if (p.meta !== undefined && !isStringRecord(p.meta, MAX_META_ENTRIES, MAX_META_VALUE)) return undefined;
  if (p.contentLength !== undefined && !(Number.isSafeInteger(p.contentLength) && (p.contentLength as number) >= 0)) return undefined;
  return {
    amount: BigInt(p.amount),
    ...(p.meta !== undefined ? { meta: { ...p.meta } } : {}),
    ...(p.contentLength !== undefined ? { contentLength: p.contentLength as number } : {}),
  };
}

/** Strict: exact keys, bounded sizes, only forwarded headers. Undefined means malformed. */
export function parseSettleRequest(body: unknown): { req: ReqLike; price: Price } | undefined {
  if (!isObj(body) || !exactKeys(body, ['request', 'price'])) return undefined;
  const req = parseForwardedRequest(body.request);
  const price = parseWirePrice(body.price);
  return req === undefined || price === undefined ? undefined : { req, price };
}

/** Strict: a paid answer counts only for exactly what was asked, at exactly the price that was sent. */
export function answersFor(result: AcceptResult, req: ReqLike, price: Price): boolean {
  if (result.kind !== 'paid') return true;
  const { paid } = result;
  const meta = price.meta ?? {};
  const sameMeta = Object.keys(meta).length === Object.keys(paid.meta).length && Object.entries(meta).every(([k, v]) => paid.meta[k] === v);
  return paid.amount === price.amount && paid.method === req.method && paid.path === req.path && sameMeta;
}

export function encodeResult(result: AcceptResult): SettleResponse {
  if (result.kind === 'respond') return result;
  return { kind: 'paid', headers: result.headers, paid: { ...result.paid, amount: result.paid.amount.toString() } };
}

const PAID_STRINGS = ['claimKey', 'payer', 'asset', 'nonce', 'method', 'path'] as const;

/** Strict: anything that is not exactly a settle response is undefined, and is never taken as paid. */
export function decodeResult(body: unknown): AcceptResult | undefined {
  if (!isObj(body)) return undefined;
  if (body.kind === 'respond') {
    if (!exactKeys(body, ['kind', 'status', 'headers', 'body'])) return undefined;
    const { status, headers, body: text } = body;
    if (!Number.isSafeInteger(status) || (status as number) < 400 || (status as number) > 599) return undefined;
    if (!isAnswerHeaders(headers) || !str(text, 4_096)) return undefined;
    return { kind: 'respond', status: status as number, headers, body: text };
  }
  if (body.kind !== 'paid' || !exactKeys(body, ['kind', 'headers', 'paid'])) return undefined;
  const { headers, paid: p } = body;
  if (!isAnswerHeaders(headers) || !isObj(p)) return undefined;
  const keys = [...PAID_STRINGS, 'protocol', 'amount', 'chainId', 'meta', 'settled', 'replayed'];
  if (!exactKeys(p, keys, ['txHash'])) return undefined;
  if (!PAID_STRINGS.every((k) => str(p[k], 4_096)) || p.protocol !== 'x402') return undefined;
  if (!isAmount(p.amount) || !Number.isSafeInteger(p.chainId) || (p.chainId as number) <= 0) return undefined;
  if (p.txHash !== undefined && !(typeof p.txHash === 'string' && TX_HASH.test(p.txHash))) return undefined;
  if (!isStringRecord(p.meta, MAX_META_ENTRIES, MAX_META_VALUE) || typeof p.settled !== 'boolean' || typeof p.replayed !== 'boolean') return undefined;
  return {
    kind: 'paid', headers,
    paid: {
      claimKey: p.claimKey as string, protocol: 'x402', payer: p.payer as string, amount: BigInt(p.amount), txHash: p.txHash as string | undefined,
      chainId: p.chainId as number, asset: p.asset as string, nonce: p.nonce as string, method: p.method as string, path: p.path as string,
      meta: { ...p.meta }, settled: p.settled, replayed: p.replayed,
    },
  };
}
