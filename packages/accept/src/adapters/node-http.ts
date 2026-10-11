import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { PaidContext, PaymentHandler, ReqLike } from '../accept.js';
import { AcceptError, AcceptErrorCode as E } from '../errors.js';

export interface NodeHandlerOptions {
  /**
   * How many proxies you run in front of this server. The client is then the X-Forwarded-For
   * entry that many hops from the right (entries further left are client-controlled).
   * Default 0: the socket address. With hops > 0 the origin must accept connections only from your
   * proxies, or a client can write its own X-Forwarded-For entry and pick its rate-limit bucket.
   */
  readonly trustedProxyHops?: number;
}

export type OnPaid = (req: IncomingMessage, res: ServerResponse, paid: PaidContext) => void | Promise<void>;

function clientIp(headers: Readonly<Record<string, string>>, socketAddress: string | undefined, hops: number): string {
  const socket = socketAddress || 'unknown';
  if (!Number.isSafeInteger(hops) || hops <= 0) return socket;
  const chain = (headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const candidate = chain[chain.length - hops];
  return candidate !== undefined && isIP(candidate) !== 0 ? candidate : socket;
}

/**
 * Lower-cases header names and joins repeats, so a duplicated payment header fails strict parsing.
 * `url` defaults to req.url; a router that rewrites req.url passes the original one.
 */
export function toReqLike(req: IncomingMessage, options: NodeHandlerOptions = {}, url: string = req.url ?? '/'): ReqLike {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  const q = url.indexOf('?');
  return {
    method: (req.method ?? 'GET').toUpperCase(),
    path: q === -1 ? url : url.slice(0, q),
    query: q === -1 ? '' : url.slice(q + 1),
    headers,
    clientIp: clientIp(headers, req.socket.remoteAddress, options.trustedProxyHops ?? 0),
  };
}

/** A bare 500 the payer can retry; never a settlement receipt, never the seller's error. */
export function internalError(res: ServerResponse): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  // A failed delivery must not carry a settlement receipt that reads as success.
  res.removeHeader('PAYMENT-RESPONSE');
  res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'INTERNAL' }));
}

async function serve(acceptor: PaymentHandler, onPaid: OnPaid, options: NodeHandlerOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const result = await acceptor.handle(toReqLike(req, options));
  if (result.kind === 'respond') {
    res.writeHead(result.status, result.headers).end(result.body);
    return;
  }
  for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
  try {
    await onPaid(req, res, result.paid);
  } catch (error) {
    // The payment is accepted; the delivery failed. The seller hears why; the payer gets a bare 500 and may retry.
    acceptor.reportError(new AcceptError(E.DELIVERY_FAILED, `payment ${result.paid.claimKey} was accepted but its delivery failed`, { cause: error }));
    internalError(res);
  }
}

/** A `node:http` request listener: answers 402s and refusals itself, calls `onPaid` once a payment is accepted. */
export function nodeHandler(acceptor: PaymentHandler, onPaid: OnPaid, options: NodeHandlerOptions = {}) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    serve(acceptor, onPaid, options, req, res).catch((error: unknown) => {
      acceptor.reportError(error);
      try {
        internalError(res);
      } catch {
        res.destroy();
      }
    });
  };
}
