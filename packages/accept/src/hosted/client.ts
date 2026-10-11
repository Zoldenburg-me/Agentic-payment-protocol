import type { AcceptResult, PaymentHandler, ReqLike } from '../accept.js';
import type { Price, PriceFn } from '../config.js';
import { AcceptError, AcceptErrorCode as E } from '../errors.js';
import { answersFor, decodeResult, forwardedHeaders, parseForwardedRequest, parseWirePrice } from './wire.js';

export interface ZoldSellerOptions {
  /** The Zold API origin, e.g. https://zoldhq.com. Plain http only to localhost. */
  readonly apiUrl: string;
  /** The seller key from enabling agent payments in Zold (`zsk_...`). Keep it in env, never in code. */
  readonly apiKey: string;
  /** Header-only and deterministic, as for `accept`: Zold settles at exactly this price. */
  readonly price: PriceFn;
  /** Required: an unreachable Zold or an unusable answer lands here (the payer got a 503 and may retry). */
  readonly onError: (error: unknown) => void;
  /** Per settle call, default 75 000 ms: longer than Zold's own wait for confirmations. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

const KNOWN = new Set(['apiUrl', 'apiKey', 'price', 'onError', 'timeoutMs', 'fetch']);
const KEY = /^zsk_[A-Za-z0-9_-]{20,200}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** A settle answer is a few KB; anything bigger is not one. */
const MAX_ANSWER_BYTES = 64 * 1024;

const fail = (what: string): never => {
  throw new AcceptError(E.CONFIG_INVALID, `zoldSeller option ${what} is invalid`);
};

function parseApiUrl(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    return fail('apiUrl');
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
  if (!secure || url.pathname !== '/' || url.search || url.hash || url.username || url.password) fail('apiUrl');
  return url.origin;
}

class TooLarge extends Error {}

/** The body as text, refusing more than MAX_ANSWER_BYTES. */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new TooLarge('answer too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const local = (status: number, code: string, extra: Record<string, string> = {}): AcceptResult => ({
  kind: 'respond', status, body: JSON.stringify({ error: code }),
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
});

/**
 * The seller side of hosted agent payments: prices locally, and lets Zold verify, settle (to the
 * seller's own Zold Safe) and keep the ledger. Use it wherever an Acceptor goes (`nodeHandler`,
 * `expressPayment`). It fails closed: if Zold cannot answer, nothing is delivered and the payer retries.
 */
export function zoldSeller(options: ZoldSellerOptions): PaymentHandler {
  if (typeof options !== 'object' || options === null || Object.keys(options).some((k) => !KNOWN.has(k))) fail('(unknown key)');
  const apiUrl = parseApiUrl(options.apiUrl);
  if (typeof options.apiKey !== 'string' || !KEY.test(options.apiKey)) fail('apiKey');
  if (typeof options.price !== 'function') fail('price');
  if (typeof options.onError !== 'function') fail('onError');
  const timeoutMs = options.timeoutMs ?? 75_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) fail('timeoutMs');
  if (options.fetch !== undefined && typeof options.fetch !== 'function') fail('fetch');
  const doFetch = options.fetch ?? fetch;

  const report = (error: unknown): void => {
    try {
      const result: unknown = options.onError(error);
      if (typeof (result as PromiseLike<unknown> | undefined)?.then === 'function') (result as PromiseLike<unknown>).then(undefined, () => undefined);
    } catch {
      // a failing reporter must not take the payment path down
    }
  };
  const unavailable = (why: string, cause?: unknown): AcceptResult => {
    report(new AcceptError(E.UPSTREAM_UNAVAILABLE, `Zold settlement unavailable: ${why}`, cause === undefined ? undefined : { cause }));
    return local(503, E.UPSTREAM_UNAVAILABLE, { 'retry-after': '1' });
  };

  async function settle(req: ReqLike, price: Price, body: string): Promise<AcceptResult> {
    let res: Response;
    try {
      res = await doFetch(`${apiUrl}/api/agent-payments/settle`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body,
      });
    } catch (error) {
      return unavailable('no answer', error);
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      return unavailable(`Zold answered ${res.status}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(await readCapped(res));
    } catch (error) {
      return unavailable(error instanceof TooLarge ? 'the answer is too large' : 'the answer is not JSON', error);
    }
    const result = decodeResult(json);
    if (result === undefined) return unavailable('the answer is not a settle response');
    return answersFor(result, req, price) ? result : unavailable('the paid answer does not match the request');
  }

  return {
    reportError: report,
    async handle(req: ReqLike): Promise<AcceptResult> {
      let price: Price;
      try {
        price = options.price({ method: req.method, path: req.path, headers: req.headers });
      } catch {
        return local(400, E.PRICE_INVALID);
      }
      if (typeof price?.amount !== 'bigint' || price.amount <= 0n) return local(500, E.PRICE_ERROR);
      // Check here what Zold would refuse: a bad request is the payer's 400, a bad price the seller's 500.
      const forwarded = parseForwardedRequest({
        method: req.method, path: req.path, query: req.query, headers: forwardedHeaders(req.headers), clientIp: req.clientIp,
      });
      if (forwarded === undefined) return local(400, E.MALFORMED);
      const wirePrice = {
        amount: price.amount.toString(),
        ...(price.meta !== undefined ? { meta: price.meta } : {}),
        ...(price.contentLength !== undefined ? { contentLength: price.contentLength } : {}),
      };
      const sent = parseWirePrice(wirePrice);
      if (sent === undefined) return local(500, E.PRICE_ERROR);
      return settle(forwarded, sent, JSON.stringify({ request: forwarded, price: wirePrice }));
    },
  };
}
