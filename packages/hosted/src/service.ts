import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import {
  type AcceptOptions, type AcceptResult, type Acceptor, AcceptErrorCode as E, type ChainPort, type RateLimiter, type SellerLedgerPort,
  type Submitter, accept, hostedSettle, statusFor, toReqLike,
} from '@zold/accept';
import { SqliteRateLimiter, SqliteSellerLedger, SqliteSingleUseStore } from '@zold/accept/sqlite';
import { decodePaymentSignature, singleUseKey } from 'agentpay-hub/protocol';
import { Counters } from './counters.js';
import type { Merchant, MerchantStore } from './merchants.js';

export const SETTLE_ROUTE = '/api/agent-payments/settle';
/** A settle request is a few KB of payment headers. */
export const MAX_BODY_BYTES = 128 * 1024;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const BEARER = /^Bearer (\S+)$/;
/** A settle request nests three deep (body.request.headers); anything far deeper is not one. */
export const MAX_JSON_DEPTH = 8;

export interface HostedLimits {
  /** The smallest price settled, in atomic USDC: dust costs the relay more gas than it moves. */
  readonly minAmount: bigint;
  /** Settle calls per seller key per minute, offers included. */
  readonly perMinute: number;
  /** Calls carrying a payment per seller key per 24 h: bounds the gas the relay spends for one key. */
  readonly paidPerDay: number;
  /** The same over all keys: bounds the relay's gas however many keys a hostile seller holds. */
  readonly paidPerDayTotal: number;
  /** Failed key lookups per client IP per minute, after which every call from that IP is refused. */
  readonly failedKeysPerMinute: number;
}

export interface HostedServiceOptions {
  readonly db: DatabaseSync;
  readonly merchants: MerchantStore;
  readonly chainId: number;
  readonly asset: string;
  readonly chain: ChainPort;
  /** One relay for every merchant: build it with `payTo: (to) => merchants.isPayee(to)`. */
  readonly submitter: Submitter;
  readonly limits: HostedLimits;
  /** Errors carry RPC errors as their `cause`, which may hold the RPC URL: redact before logging. */
  readonly onError: (error: unknown) => void;
  /** As for `nodeHandler`: the proxies in front of this server. Only for the failed-key limit. */
  readonly trustedProxyHops?: number;
  /** For tests: faster polling, a fixed clock. */
  readonly tuning?: Pick<AcceptOptions, 'pollIntervalMs' | 'settlementTimeoutMs' | 'minConfirmations'>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const refusal = (code: typeof E.PRICE_ERROR | typeof E.RATE_LIMITED): AcceptResult => ({
  kind: 'respond', status: statusFor(code), body: JSON.stringify({ error: code }),
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(code === E.RATE_LIMITED ? { 'retry-after': '60' } : {}) },
});

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body));
}

/** The body as text, or undefined when it is larger than MAX_BODY_BYTES. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_BODY_BYTES) return undefined; // a chunked body that lied: the socket is dropped
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Whether JSON text nests deeper than `max`, counted outside strings, before it is parsed. */
export function nestsDeeper(text: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') {
      depth += 1;
      if (depth > max) return true;
    } else if (c === '}' || c === ']') depth -= 1;
  }
  return false;
}

/** One merchant's view of the shared ledger, so its reconcile only walks its own rows. */
function scopedLedger(ledger: SellerLedgerPort, id: string): SellerLedgerPort {
  return {
    get: (k) => ledger.get(k),
    // shortcut: reads every row per merchant per tick; add listOpen() with a status index (merchant-safes phase 5) before volume grows.
    list: async () => (await ledger.list()).filter((row) => row.sellerAccountId === id),
    recordVerified: (row) => ledger.recordVerified(row),
    recordSubmitted: (k, tx) => ledger.recordSubmitted(k, tx),
    recordSettled: (k, tx) => ledger.recordSettled(k, tx),
    recordRefused: (k, code, tx) => ledger.recordRefused(k, code, tx),
    markDelivered: (k) => ledger.markDelivered(k),
  };
}

/**
 * The hub's hosted settlement: POST /api/agent-payments/settle for `zoldSeller`, plus `reconcile` for a
 * timer. Every merchant gets one cached acceptor paying to its own address through the one relay; all
 * state lives in the SQLite file. Limits are per seller key, since `clientIp` is seller-supplied.
 */
export function hostedService(o: HostedServiceOptions) {
  const ledger = new SqliteSellerLedger(o.db);
  const claims = new SqliteSingleUseStore(o.db);
  const limiter = new SqliteRateLimiter(o.db);
  const counters = new Counters(o.db);
  const now = o.now ?? Date.now;
  const { limits } = o;
  const acceptors = new Map<string, Acceptor>();

  /** Whether the header names a payment this merchant already recorded (unverified: it only skips the quota; accept still verifies). */
  async function recorded(id: string, header: string): Promise<boolean> {
    try {
      const a = decodePaymentSignature(header).payload.authorization as Record<string, unknown> | undefined;
      const key = singleUseKey({ sellerAccountId: id, chainId: o.chainId, asset: o.asset, from: String(a?.from), nonce: String(a?.nonce) });
      return (await ledger.get(key)) !== undefined;
    } catch {
      return false;
    }
  }

  const limited = (id: string, inner: Acceptor): Acceptor => ({
    ...inner,
    async handle(req, options) {
      if ((options?.price?.amount ?? 0n) < limits.minAmount) return refusal(E.PRICE_ERROR);
      if (!counters.take(`minute:${id}`, limits.perMinute, MINUTE_MS, now())) return refusal(E.RATE_LIMITED);
      const header = req.headers['payment-signature'];
      // A retry of a payment already in the ledger was counted once; its buyer must be able to fetch what it paid for.
      const paying = header !== undefined && !(await recorded(id, header));
      if (paying && !counters.take(`day:${id}`, limits.paidPerDay, DAY_MS, now())) return refusal(E.RATE_LIMITED);
      // '*' is no merchant id, so this key is the relay's own
      if (paying && !counters.take('day:*', limits.paidPerDayTotal, DAY_MS, now())) return refusal(E.RATE_LIMITED);
      return inner.handle(req, options);
    },
  });

  function acceptorOf(m: Merchant): Acceptor {
    const cached = acceptors.get(m.id);
    if (cached !== undefined) return cached;
    const rateLimiter: RateLimiter = { take: (key, limit, nowMs) => limiter.take(`${m.id}|${key}`, limit, nowMs) };
    const acceptor = limited(m.id, accept({
      sellerAccountId: m.id, payTo: m.payTo, chainId: o.chainId, asset: o.asset, ...o.tuning,
      price: () => {
        throw new Error('hosted sellers price each request themselves');
      },
    }, {
      ledger: scopedLedger(ledger, m.id), claims, chain: o.chain, submitter: o.submitter, rateLimiter, onError: o.onError,
      ...(o.now !== undefined ? { now: o.now } : {}), ...(o.sleep !== undefined ? { sleep: o.sleep } : {}),
    }));
    acceptors.set(m.id, acceptor);
    return acceptor;
  }

  const settle = hostedSettle({
    acceptorFor: (key) => {
      const merchant = o.merchants.verify(key);
      return merchant === undefined ? undefined : acceptorOf(merchant);
    },
    onError: o.onError,
  });

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || req.url !== SETTLE_ROUTE) return send(res, 404, { error: 'NOT_FOUND' });
    const failedKey = `failed:${toReqLike(req, { trustedProxyHops: o.trustedProxyHops ?? 0 }).clientIp}`;
    if (counters.spent(failedKey, limits.failedKeysPerMinute, now())) return send(res, 429, { error: 'RATE_LIMITED' }, { 'retry-after': '60' });
    const authorization = req.headers.authorization;
    // The key is checked before the body is read; hostedSettle checks it again, which costs one lookup.
    if (o.merchants.verify(BEARER.exec(authorization ?? '')?.[1] ?? '') === undefined) {
      counters.take(failedKey, limits.failedKeysPerMinute, MINUTE_MS, now());
      return send(res, 401, { error: 'UNAUTHORIZED' });
    }
    const text = await readBody(req);
    if (text === undefined) return send(res, 413, { error: 'TOO_LARGE' }, { connection: 'close' });
    if (nestsDeeper(text, MAX_JSON_DEPTH)) return send(res, 400, { error: 'MALFORMED' });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return send(res, 400, { error: 'MALFORMED' });
    }
    const out = await settle({ authorization, body });
    send(res, out.status, out.body);
  }

  return {
    listener(req: IncomingMessage, res: ServerResponse): void {
      serve(req, res).catch((error: unknown) => {
        o.onError(error);
        if (res.headersSent) res.destroy();
        else send(res, 500, { error: 'INTERNAL' });
      });
    },
    /** Run on a timer in one process: settles or expires every merchant's open payments, prunes claims and counters. */
    async reconcile(): Promise<void> {
      for (const merchant of o.merchants.all()) {
        try {
          await acceptorOf(merchant).reconcileOwed();
        } catch (error) {
          o.onError(error);
        }
      }
      counters.sweep(now());
    },
    /**
     * Deletes finished payments once their retention ends: § 147 AO keeps a record to the end of its
     * calendar year plus `years`. A day of margin so a record dated 1 January in Berlin (UTC+1) is
     * never taken for the year before; validBefore is at or after when the record was made.
     */
    async prune(years: number): Promise<number> {
      const startOfYear = Date.UTC(new Date(now()).getUTCFullYear() - years, 0, 1) / 1000;
      // shortcut: a full-table scan on json_extract(validBefore); index a valid_before column before the table reaches millions of rows.
      return ledger.prune(startOfYear - DAY_MS / 1000);
    },
  };
}
