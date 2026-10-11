import type { Acceptor } from '../accept.js';
import { AcceptError, AcceptErrorCode as E } from '../errors.js';
import { encodeResult, parseSettleRequest } from './wire.js';

export interface HostedSettleOptions {
  /**
   * The acceptor for a seller key, configured with that seller's payee and ledger; undefined for an
   * unknown or revoked key. Look the key up by its id and compare the secret in constant time, and
   * return the same cached acceptor for a seller so its rate limits hold across requests.
   */
  readonly acceptorFor: (sellerKey: string) => Acceptor | undefined | Promise<Acceptor | undefined>;
  /** Required: a failing lookup or acceptor lands here (the seller got a 503 or 500 and its payer retries). */
  readonly onError: (error: unknown) => void;
}

export interface HostedSettleResult {
  readonly status: number;
  readonly body: unknown;
}

const KNOWN = new Set(['acceptorFor', 'onError']);
const BEARER = /^Bearer (zsk_[A-Za-z0-9_-]{20,200})$/;

const fail = (what: string): never => {
  throw new AcceptError(E.CONFIG_INVALID, `hostedSettle option ${what} is invalid`);
};

/**
 * The Zold side of hosted settlement, framework-neutral: wrap it in the route for
 * POST /api/agent-payments/settle. The key is checked before the body is used; the route must cap
 * the raw body size before parsing JSON and rate-limit failed keys.
 */
export function hostedSettle(options: HostedSettleOptions) {
  if (typeof options !== 'object' || options === null || Object.keys(options).some((k) => !KNOWN.has(k))) fail('(unknown key)');
  if (typeof options.acceptorFor !== 'function') fail('acceptorFor');
  if (typeof options.onError !== 'function') fail('onError');
  const report = (error: unknown): void => {
    try {
      const result: unknown = options.onError(error);
      if (typeof (result as PromiseLike<unknown> | undefined)?.then === 'function') (result as PromiseLike<unknown>).then(undefined, () => undefined);
    } catch {
      // a failing reporter must not change the answer
    }
  };

  return async (input: { readonly authorization: string | undefined; readonly body: unknown }): Promise<HostedSettleResult> => {
    const key = BEARER.exec(input.authorization ?? '')?.[1];
    if (key === undefined) return { status: 401, body: { error: 'UNAUTHORIZED' } };
    let acceptor: Acceptor | undefined;
    try {
      acceptor = await options.acceptorFor(key);
    } catch (error) {
      report(new AcceptError(E.UPSTREAM_UNAVAILABLE, 'seller key lookup failed', { cause: error }));
      return { status: 503, body: { error: 'UNAVAILABLE' } };
    }
    if (acceptor === undefined) return { status: 401, body: { error: 'UNAUTHORIZED' } };
    const parsed = parseSettleRequest(input.body);
    if (parsed === undefined) return { status: 400, body: { error: 'MALFORMED' } };
    try {
      return { status: 200, body: encodeResult(await acceptor.handle(parsed.req, { price: parsed.price })) };
    } catch (error) {
      report(new AcceptError(E.INTERNAL, 'the seller acceptor threw', { cause: error }));
      return { status: 500, body: { error: 'INTERNAL' } };
    }
  };
}
