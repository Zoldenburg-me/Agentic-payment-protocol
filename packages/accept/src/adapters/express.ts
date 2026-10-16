import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PaidContext, PaymentHandler } from '../accept.js';
import { AcceptError, AcceptErrorCode as E } from '../errors.js';
import { type NodeHandlerOptions, confirmDelivered, defers, internalError, toReqLike } from './node-http.js';

/** The parts of an Express request and response the adapter uses (Express 4 and 5). */
export interface ExpressRequest extends IncomingMessage {
  originalUrl?: string;
}
export interface ExpressResponse extends ServerResponse {
  locals: Record<string, unknown>;
}
type Next = (error?: unknown) => void;

const LOCALS_KEY = 'zoldPayment';

/** The accepted payment for this request, set by `expressPayment` before your route runs. */
export const paymentOf = (res: ExpressResponse): PaidContext | undefined => res.locals[LOCALS_KEY] as PaidContext | undefined;

/**
 * Express middleware: answers 402s and refusals itself, and calls `next()` once a payment is accepted,
 * with the payment on `paymentOf(res)`. Prices the original URL, so mounting under a prefix cannot
 * change what a route costs. The client IP comes from `trustedProxyHops`, never from Express's
 * `trust proxy`, so both adapters see the same client. With `deferDelivery`, the payment is marked
 * delivered when the response finishes with a status below 400.
 */
export function expressPayment(acceptor: PaymentHandler, options: NodeHandlerOptions = {}) {
  const defer = defers(acceptor, options);
  return (req: ExpressRequest, res: ExpressResponse, next: Next): void => {
    Promise.resolve()
      .then(() => acceptor.handle(toReqLike(req, options, req.originalUrl ?? req.url ?? '/'), { deferDelivery: defer }))
      .then((result) => {
        if (result.kind === 'respond') {
          res.writeHead(result.status, result.headers).end(result.body);
          return;
        }
        for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
        res.locals[LOCALS_KEY] = result.paid;
        // Delivered only once the route answered with a success: an error or an aborted response stays owed.
        if (defer) {
          res.once('finish', () => {
            if (res.statusCode < 400) void confirmDelivered(acceptor, result.paid.claimKey);
          });
        }
        next();
      })
      .catch((error: unknown) => {
        // Our failure, not the route's: answer it here, so no Express error page shows internals.
        acceptor.reportError(error);
        internalError(res);
      });
  };
}

/**
 * Express error middleware, registered after your routes: a paid request whose route failed is reported
 * as DELIVERY_FAILED and loses its receipt header; the error then goes on to your own error handling.
 */
export function expressDeliveryErrors(acceptor: PaymentHandler) {
  return (error: unknown, _req: ExpressRequest, res: ExpressResponse, next: Next): void => {
    const paid = paymentOf(res);
    if (paid !== undefined) {
      acceptor.reportError(new AcceptError(E.DELIVERY_FAILED, `payment ${paid.claimKey} was accepted but its delivery failed`, { cause: error }));
      if (!res.headersSent) res.removeHeader('PAYMENT-RESPONSE');
    }
    next(error);
  };
}
