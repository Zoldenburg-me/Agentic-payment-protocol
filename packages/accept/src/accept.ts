import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { Hex } from 'viem';
import { toUsdMicros } from 'agentpay-hub';
import {
  MAX_TIMEOUT_SECONDS, type PaymentClaim, type PaymentSignature, ProtocolError, type SingleUseStore, claimExpiry,
  claimPayment, decodePaymentSignature, releasePayment, singleUseKey, verifyEip3009,
} from 'agentpay-hub/protocol';
import { type AcceptConfig, type AcceptOptions, type Price, parseAcceptOptions } from './config.js';
import { AcceptError, AcceptErrorCode as E, type AcceptErrorCode, statusFor } from './errors.js';
import { MemoryRateLimiter } from './memory/rate-limit.js';
import { offerHeader, paymentResponseHeader } from './offer.js';
import type { ChainPort, NewSellerPayment, RateLimiter, SellerLedgerPort, SellerPayment, Submitter, TransferCall } from './ports.js';
import { type Expected, type SettleEnv, type SettleFailure, confirm, expectedOf, precheck, submit } from './settle.js';

/** A framework-neutral request: header names lower-cased, path and query split. */
export interface ReqLike {
  readonly method: string;
  readonly path: string;
  /** The raw query string without `?` ('' if none). A payment is bound to it. */
  readonly query: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly clientIp: string;
}

export interface PaidContext {
  /** Stable across retries of the same payment: map it to the resource you deliver. */
  readonly claimKey: string;
  readonly protocol: 'x402';
  readonly payer: string;
  readonly amount: bigint;
  readonly txHash: string | undefined;
  readonly chainId: number;
  readonly asset: string;
  readonly nonce: string;
  /** The method and path that were priced: serve exactly these. */
  readonly method: string;
  readonly path: string;
  /** Serve from this (as priced and paid), not from anything the request can still change. */
  readonly meta: Readonly<Record<string, string>>;
  /** False only for optimistic delivery: the transfer was sent but not yet confirmed. */
  readonly settled: boolean;
  /**
   * True when this payment was handed out for delivery before (a retry, perhaps after a failed
   * delivery): serve the same resource again, keyed by claimKey, and repeat no side effects.
   */
  readonly replayed: boolean;
}

export type AcceptResult =
  | { readonly kind: 'respond'; readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string }
  | { readonly kind: 'paid'; readonly paid: PaidContext; readonly headers: Readonly<Record<string, string>> };

export interface AcceptDeps {
  readonly ledger: SellerLedgerPort;
  readonly claims: SingleUseStore;
  readonly chain: ChainPort;
  readonly submitter: Submitter;
  /**
   * Required: internal failures, ledger errors, ambiguous settlements and optimistic deliveries that
   * did not settle (an AcceptError with the code) all land here, since no request is left to answer
   * them. RPC errors arrive as the `cause` and may contain your RPC URL: redact before logging.
   */
  readonly onError: (error: unknown) => void;
  readonly rateLimiter?: RateLimiter;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface HandleOptions {
  /** Price this request with this instead of the configured price function (a host settling for many sellers). */
  readonly price?: Price;
}

export interface Acceptor {
  handle(req: ReqLike, options?: HandleOptions): Promise<AcceptResult>;
  /** Hands an error to `onError` (adapters use it for delivery failures). Never throws. */
  reportError(error: unknown): void;
  /**
   * Settles, expires or reports open payments without a request: those whose request timed out, or
   * whose payer never came back. Run it on a timer (e.g. every minute) in one process. Rows still
   * valid but never sent stay open, since the ledger holds no signature; they expire later.
   */
  reconcileOwed(): Promise<ReconcileReport>;
  /** Resolves once optimistic background settlements have finished. */
  idle(): Promise<void>;
}

interface Ctx {
  readonly config: AcceptConfig;
  readonly deps: Required<AcceptDeps>;
  readonly env: SettleEnv;
  readonly background: Set<Promise<void>>;
  /** Claim keys this process is settling right now (bounded by maxInFlight). */
  readonly active: Set<string>;
  /** Per payer (lower-case): the value of its payments this process is still settling. */
  readonly unsettled: Map<string, bigint>;
}

const READ_ONLY = new Set(['GET', 'HEAD']);
const MAX_UINT256 = 2n ** 256n - 1n;
const NETWORK = /^eip155:([1-9]\d{0,14})$/; // at most 15 digits: always a safe integer
const RETRY_AFTER: Partial<Record<AcceptErrorCode, string>> = { [E.RATE_LIMITED]: '60', [E.IN_PROGRESS]: '1', [E.BUSY]: '1' };
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** A failing error reporter must never take the payment path (or the process) down: warn, without its details. */
const reporterFailed = (): void =>
  process.emitWarning('@zold/accept: onError failed, so an error went unreported', { code: 'ZOLD_ACCEPT_ONERROR' });

function report(ctx: Ctx, error: unknown): void {
  try {
    const result: unknown = ctx.deps.onError(error);
    if (typeof (result as PromiseLike<unknown> | undefined)?.then === 'function') {
      (result as PromiseLike<unknown>).then(undefined, reporterFailed);
    }
  } catch {
    reporterFailed();
  }
}

/** Payment responses are per request and per payer: no shared cache may keep them. */
const NO_STORE = { 'cache-control': 'no-store' } as const;

function respond(ctx: Ctx, code: AcceptErrorCode, req: ReqLike, price?: Price, status = statusFor(code)): AcceptResult {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...NO_STORE };
  // Every 402 carries a fresh offer, so the buyer can pay (again) without another round trip.
  if (status === 402 && price) headers['PAYMENT-REQUIRED'] = offerHeader(ctx.config, req.path, price.amount);
  const retryAfter = RETRY_AFTER[code];
  if (retryAfter) headers['retry-after'] = retryAfter;
  return { kind: 'respond', status, headers, body: JSON.stringify({ error: code }) };
}

const PATH_CHARS = /^\/(?:[A-Za-z0-9\-._~!$&'()*+,=:@/]|%[0-9A-F]{2})*$/;
/** Characters a router may decode to and match on: these must appear as themselves, never percent-encoded. */
const PLAIN = /[A-Za-z0-9\-._~/\\]/;

/**
 * One spelling per path, so the path priced is the path the router serves: origin-form, RFC 3986
 * characters without `;`, upper-case escapes only, none of unreserved characters or separators, no
 * empty or dot segments. Case and trailing slashes still differ: price and route them the same way.
 */
function canonicalPath(path: string): boolean {
  if (!PATH_CHARS.test(path) || path.includes('//') || /(^|\/)\.{1,2}(\/|$)/.test(path)) return false;
  return !(path.match(/%[0-9A-F]{2}/g) ?? []).some((e) => PLAIN.test(String.fromCharCode(parseInt(e.slice(1), 16))));
}

/** The rate-limit bucket for a client address: IPv6 per /64 (one subscriber), IPv4-mapped as IPv4. */
export function ipBucket(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1] !== undefined) return mapped[1];
  if (isIP(ip) !== 6) return ip;
  const groups = (s: string): string[] => (s === '' ? [] : s.split(':'));
  const width = (gs: string[]): number => gs.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0);
  const [head = '', tail] = (ip.split('%')[0] ?? '').split('::');
  const before = groups(head);
  const after = tail === undefined ? [] : groups(tail);
  const all = [...before, ...Array<string>(tail === undefined ? 0 : 8 - width(before) - width(after)).fill('0'), ...after];
  return `${all.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

const isStringRecord = (v: unknown): v is Record<string, string> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');

function priceOf(config: AcceptConfig, req: ReqLike, given: Price | undefined): Price | AcceptErrorCode {
  let p: Price;
  try {
    p = given ?? config.price({ method: req.method, path: req.path, headers: req.headers });
  } catch {
    return E.PRICE_INVALID;
  }
  try {
    const valid = typeof p === 'object' && p !== null && typeof p.amount === 'bigint' && p.amount > 0n && p.amount <= MAX_UINT256 &&
      (p.contentLength === undefined || (Number.isSafeInteger(p.contentLength) && p.contentLength >= 0)) &&
      (p.meta === undefined || isStringRecord(p.meta));
    return valid ? { amount: p.amount, meta: { ...p.meta }, ...(p.contentLength !== undefined ? { contentLength: p.contentLength } : {}) } : E.PRICE_ERROR;
  } catch {
    return E.PRICE_ERROR; // a hostile or broken price object (e.g. throwing getters)
  }
}

function hasMppCredential(req: ReqLike): boolean {
  const auth = req.headers.authorization;
  return (auth !== undefined && /^payment\s/i.test(auth)) || req.headers['payment-authorization'] !== undefined;
}

const take = (ctx: Ctx, key: string, limit: number): boolean => ctx.deps.rateLimiter.take(key, limit, ctx.deps.now());

/** The ledger key for the payment the header claims to be (unverified: used only to find an earlier row). */
function claimedKey(config: AcceptConfig, sig: PaymentSignature): string | undefined {
  const a = sig.payload.authorization as Record<string, unknown> | undefined;
  try {
    return singleUseKey({ sellerAccountId: config.sellerAccountId, chainId: config.chainId, asset: config.asset, from: String(a?.from), nonce: String(a?.nonce) });
  } catch {
    return undefined;
  }
}

const byKey = (m: Readonly<Record<string, string>>): [string, string][] =>
  Object.entries(m).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
const sameMeta = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean =>
  JSON.stringify(byKey(a)) === JSON.stringify(byKey(b));

/** A replay must be the same payment for the same thing: header, method, path, query, price and meta. */
const sameRequest = (row: SellerPayment, digest: string, req: ReqLike, price: Price): boolean =>
  row.headerDigest === digest && row.method === req.method && row.path === req.path && row.queryDigest === sha256(req.query) &&
  row.amount === price.amount.toString() && sameMeta(row.meta, price.meta ?? {});

function paidResult(ctx: Ctx, row: SellerPayment, settled: boolean, replayed: boolean): AcceptResult {
  // The settlement receipt only once there is a settlement: an optimistic delivery has none yet.
  const receipt: Record<string, string> = settled ? { 'PAYMENT-RESPONSE': paymentResponseHeader(ctx.config, row.txHash, row.payer) } : {};
  return {
    kind: 'paid',
    headers: { ...NO_STORE, ...receipt },
    paid: {
      claimKey: row.claimKey, protocol: 'x402', payer: row.payer, amount: BigInt(row.amount), txHash: row.txHash,
      chainId: row.chainId, asset: row.asset, nonce: row.nonce, method: row.method, path: row.path, meta: row.meta,
      settled, replayed,
    },
  };
}

async function deliver(ctx: Ctx, claimKey: string, settled: boolean): Promise<AcceptResult> {
  const { first, row } = await ctx.deps.ledger.markDelivered(claimKey);
  return paidResult(ctx, row, settled, !first);
}

/** Ledger moves re-read the row first, so a payment settled or refused meanwhile (another process) is not moved twice. */
const isOpen = (row: SellerPayment | undefined): boolean => row?.status === 'owed' || row?.status === 'submitted';

async function settleRow(ctx: Ctx, claimKey: string, txHash: string): Promise<void> {
  if (!isOpen(await ctx.deps.ledger.get(claimKey))) return;
  try {
    await ctx.deps.ledger.recordSettled(claimKey, txHash);
  } catch (error) {
    // Lost a race with another process: its final state (settled, or refused) stands; the caller reads it.
    if (isOpen(await ctx.deps.ledger.get(claimKey))) throw error;
  }
}

async function refuseRow(ctx: Ctx, claimKey: string, code: AcceptErrorCode, txHash?: string): Promise<void> {
  if (!isOpen(await ctx.deps.ledger.get(claimKey))) return;
  try {
    await ctx.deps.ledger.recordRefused(claimKey, code, txHash);
  } catch (error) {
    if (isOpen(await ctx.deps.ledger.get(claimKey))) throw error;
  }
}

/** Delivers only a settled payment; a row another process refused meanwhile gets its refusal instead. */
async function deliverSettled(ctx: Ctx, claimKey: string, req: ReqLike, price: Price): Promise<AcceptResult> {
  const row = await ctx.deps.ledger.get(claimKey);
  if (row?.status !== 'settled') return respond(ctx, row?.refusal ?? E.INTERNAL, req, price);
  return deliver(ctx, claimKey, true);
}

/**
 * How long past validBefore (by our clock) before an unsettled payment is final. Our clock may run
 * ahead of block timestamps, and a pending transaction can be mined until validBefore in chain time.
 */
export const EXPIRY_GRACE_S = 120;

const expired = (ctx: Ctx, row: SellerPayment): boolean =>
  BigInt(Math.floor(ctx.deps.now() / 1000)) >= BigInt(row.validBefore) + BigInt(EXPIRY_GRACE_S);

const expectedOfRow = (row: SellerPayment): Expected =>
  ({ asset: row.asset, from: row.payer, to: row.payTo, value: BigInt(row.amount), nonce: row.nonce as Hex });

/** Our transaction if we sent one (confirm follows a front-runner from it), else whichever used the authorization. */
async function txFor(ctx: Ctx, row: SellerPayment, e: Expected): Promise<Hex | undefined> {
  return (row.txHash as Hex | undefined) ?? ctx.deps.chain.findAuthorizationUse(e.asset, e.from, e.nonce);
}

const needsReconciliation = (claimKey: string): AcceptError =>
  new AcceptError(E.SETTLEMENT_UNKNOWN, `payment ${claimKey} is used on chain but its transaction cannot be found: reconcile`);

/** What onError should hear about a settlement failure; undefined for an ordinary, self-explaining one. */
function failureReport(claimKey: string, f: SettleFailure): AcceptError | undefined {
  if (f.code === E.SETTLEMENT_UNKNOWN) return needsReconciliation(claimKey);
  if (f.code === E.AUTHORIZATION_USED) {
    // Used or cancelled with no transaction found: if it was used, the seller may have been paid.
    return new AcceptError(E.AUTHORIZATION_USED, `payment ${claimKey} is used or cancelled on chain with no transaction found: check`);
  }
  if (f.code === E.TRANSFER_MISMATCH) {
    return new AcceptError(E.TRANSFER_MISMATCH, `payment ${claimKey}: transaction ${f.txHash ?? '?'} succeeded without the expected transfer: check`);
  }
  // A call failed (transport, RPC), so whether money moved is unknown until a retry or reconcileOwed looks again.
  return f.cause === undefined ? undefined : new AcceptError(f.code, `payment ${claimKey}: ${f.code}`, { cause: f.cause });
}

function reportFailure(ctx: Ctx, claimKey: string, f: SettleFailure): void {
  const error = failureReport(claimKey, f);
  if (error) report(ctx, error);
}

/** Holds the payer's value while its payment settles, so the next one is checked against what is left. */
interface Hold {
  /** What the payer already had unsettled here before this payment. */
  readonly prior: bigint;
  readonly release: () => void;
}

function hold(ctx: Ctx, payer: string, value: bigint): Hold {
  const key = payer.toLowerCase();
  const prior = ctx.unsettled.get(key) ?? 0n;
  ctx.unsettled.set(key, prior + value);
  let held = true;
  return {
    prior,
    release: () => {
      if (!held) return;
      held = false;
      const left = (ctx.unsettled.get(key) ?? 0n) - value;
      if (left > 0n) ctx.unsettled.set(key, left);
      else ctx.unsettled.delete(key);
    },
  };
}

/** After a broadcast the money may move: a failed ledger write must not stop us confirming it. */
async function recordSubmitted(ctx: Ctx, claimKey: string, txHash: Hex): Promise<void> {
  try {
    await ctx.deps.ledger.recordSubmitted(claimKey, txHash);
  } catch (error) {
    report(ctx, new AcceptError(E.INTERNAL, `payment ${claimKey} was broadcast as ${txHash} but recording it failed`, { cause: error }));
  }
}

/** Where an existing row stands after a look at the chain (the ledger already moved accordingly). */
type Verdict =
  | { readonly kind: 'settled' }
  | { readonly kind: 'refused' | 'open'; readonly code: AcceptErrorCode; readonly status: number };

const verdict = (kind: 'refused' | 'open', code: AcceptErrorCode, status = statusFor(code)): Verdict => ({ kind, code, status });

/** Confirms a known transaction for an existing row. Final only past the deadline, and only if the authorization is unused. */
async function judge(ctx: Ctx, row: SellerPayment, e: Expected, txHash: Hex): Promise<Verdict> {
  const done = await confirm(ctx.env, e, txHash);
  if (done.ok) {
    await settleRow(ctx, row.claimKey, done.txHash);
    return { kind: 'settled' };
  }
  reportFailure(ctx, row.claimKey, done);
  const unusedNow = (): Promise<boolean> =>
    ctx.deps.chain.authorizationState(e.asset, e.from, e.nonce).then((used) => !used, () => false);
  if ((done.code === E.SETTLEMENT_TIMEOUT || done.code === E.SUBMIT_FAILED) && expired(ctx, row) && await unusedNow()) {
    // Never mined, or reverted, and nobody used the authorization: past the deadline it never can be.
    const code = done.code === E.SETTLEMENT_TIMEOUT ? E.EXPIRED : done.code;
    await refuseRow(ctx, row.claimKey, code);
    return verdict('refused', code);
  }
  if (done.final) {
    await refuseRow(ctx, row.claimKey, done.code, done.txHash);
    return verdict('refused', done.code, done.status);
  }
  return verdict('open', done.code, done.status);
}

/** A row with no known transaction: expire it if it can never settle, report it if used but untraceable. */
async function untraced(ctx: Ctx, row: SellerPayment, e: Expected): Promise<Verdict | 'unsent'> {
  const used = await ctx.deps.chain.authorizationState(e.asset, e.from, e.nonce);
  if (!used && expired(ctx, row)) {
    await refuseRow(ctx, row.claimKey, E.EXPIRED); // never sent, and now it never can be
    return verdict('refused', E.EXPIRED);
  }
  if (!used) return 'unsent'; // still valid: only a request carrying the signature can send it
  report(ctx, needsReconciliation(row.claimKey)); // a lagging or limited log index; reconcileOwed looks again
  return verdict('open', E.IN_PROGRESS);
}

async function settleKnown(ctx: Ctx, row: SellerPayment, e: Expected, txHash: Hex, req: ReqLike, price: Price): Promise<AcceptResult> {
  const v = await judge(ctx, row, e, txHash);
  if (v.kind === 'settled') return deliverSettled(ctx, row.claimKey, req, price);
  if (v.kind === 'refused' || v.code === E.SUBMIT_FAILED) return respond(ctx, v.code, req, price, v.status);
  return respond(ctx, E.IN_PROGRESS, req);
}

/** A row that was never (knowingly) broadcast, its authorization still valid: send it now. The row stays open on any failure. */
async function resubmit(ctx: Ctx, row: SellerPayment, e: Expected, call: TransferCall, req: ReqLike, price: Price): Promise<AcceptResult> {
  const held = hold(ctx, row.payer, e.value);
  try {
    const pre = await precheck(ctx.env, call, held.prior);
    if (!pre.ok) {
      reportFailure(ctx, row.claimKey, pre);
      return respond(ctx, pre.code, req, price, pre.status); // never released or refused: the payer may still fund it
    }
    let txHash = pre.existing;
    if (txHash === undefined) {
      const sent = await submit(ctx.env, call);
      if (!sent.ok) {
        reportFailure(ctx, row.claimKey, sent);
        return respond(ctx, sent.code, req, price, sent.status);
      }
      txHash = sent.txHash;
      if (sent.ours) await recordSubmitted(ctx, row.claimKey, txHash);
    }
    return await settleKnown(ctx, row, e, txHash, req, price);
  } finally {
    held.release();
  }
}

/** A row with no known transaction, on a retry: as `untraced`, but a still-valid unsent row is sent now. */
async function withoutTransaction(ctx: Ctx, row: SellerPayment, e: Expected, call: TransferCall, req: ReqLike, price: Price): Promise<AcceptResult> {
  const v = await untraced(ctx, row, e);
  if (v === 'unsent') return resubmit(ctx, row, e, call, req, price);
  return v.kind === 'refused' ? respond(ctx, v.code, req, price) : respond(ctx, E.IN_PROGRESS, req);
}

export interface ReconcileReport {
  /** Open rows looked at (rows settled or refused meanwhile are skipped). */
  readonly checked: number;
  readonly settled: number;
  readonly refused: number;
  /** Still open: in progress here, unsent but valid, untraceable (reported), or the RPC failed (reported). */
  readonly open: number;
}

async function reconcileRow(ctx: Ctx, row: SellerPayment): Promise<'settled' | 'refused' | 'open'> {
  const e = expectedOfRow(row);
  try {
    const txHash = await txFor(ctx, row, e);
    const v = txHash ? await judge(ctx, row, e, txHash) : await untraced(ctx, row, e);
    return v === 'unsent' ? 'open' : v.kind;
  } catch (error) {
    report(ctx, error);
    return 'open';
  }
}

/** Settles, expires or reports every open row without waiting for its payer to retry. */
async function reconcileOwed(ctx: Ctx): Promise<ReconcileReport> {
  const counts = { checked: 0, settled: 0, refused: 0, open: 0 };
  for (const listed of await ctx.deps.ledger.list()) {
    if (!isOpen(listed)) continue;
    const row = await ctx.deps.ledger.get(listed.claimKey); // re-read: another process may have moved it
    if (!row || !isOpen(row)) continue;
    counts.checked += 1;
    if (ctx.active.has(row.claimKey)) {
      counts.open += 1; // a request here is settling it right now
      continue;
    }
    ctx.active.add(row.claimKey);
    try {
      counts[await reconcileRow(ctx, row)] += 1;
    } finally {
      ctx.active.delete(row.claimKey);
    }
  }
  return counts;
}

/**
 * An owed or submitted row whose outcome was unknown, or whose own transaction reverted while the
 * authorization stayed valid: look at the chain again. `call` is rebuilt from the retry's header,
 * which is byte-identical to the one verified (its digest matched), so a stranded row can be sent.
 */
async function resume(ctx: Ctx, row: SellerPayment, call: TransferCall, req: ReqLike, price: Price): Promise<AcceptResult> {
  const e = expectedOfRow(row);
  ctx.active.add(row.claimKey);
  try {
    let txHash: Hex | undefined;
    try {
      txHash = await txFor(ctx, row, e);
      if (!txHash) return await withoutTransaction(ctx, row, e, call, req, price);
    } catch (error) {
      report(ctx, error); // an RPC or ledger failure: the row stays open, but nobody should have to guess why
      return respond(ctx, E.IN_PROGRESS, req);
    }
    return await settleKnown(ctx, row, e, txHash, req, price);
  } finally {
    ctx.active.delete(row.claimKey);
  }
}

/** The transfer a header authorizes, against a stored row (the header was verified when the row was written). */
function callOf(row: SellerPayment, sig: PaymentSignature): TransferCall {
  const a = sig.payload.authorization as Record<string, unknown>;
  return {
    asset: row.asset, signature: sig.payload.signature as Hex,
    authorization: {
      from: row.payer as Hex, to: row.payTo as Hex, value: BigInt(row.amount), validAfter: BigInt(String(a.validAfter)),
      validBefore: BigInt(row.validBefore), nonce: row.nonce as Hex,
    },
  };
}

/** A payment this seller has seen before: repeat the refusal, replay a delivery, or resume an unknown outcome. */
async function fromExisting(ctx: Ctx, row: SellerPayment, sig: PaymentSignature, digest: string, req: ReqLike, price: Price): Promise<AcceptResult> {
  if (!sameRequest(row, digest, req, price)) return respond(ctx, E.NONCE_REPLAY, req);
  if (row.status === 'refused') return respond(ctx, row.refusal ?? E.INTERNAL, req, price);
  if (row.status === 'settled') return deliver(ctx, row.claimKey, true);
  // Not settled (including an optimistic delivery still unconfirmed): never replay it, re-check the chain.
  if (ctx.active.has(row.claimKey)) return respond(ctx, E.IN_PROGRESS, req);
  if (ctx.active.size >= ctx.config.maxInFlight) return respond(ctx, E.BUSY, req);
  // Resuming polls the chain: it spends the (verified, stored) payer's bucket, not just the IP's.
  if (!take(ctx, `payer:${row.payer.toLowerCase()}`, ctx.config.rateLimit.perPayerPerMinute)) return respond(ctx, E.RATE_LIMITED, req);
  return resume(ctx, row, callOf(row, sig), req, price);
}

function optimistic(ctx: Ctx, s: Settling): boolean {
  const max = ctx.config.optimisticMaxUsdMicros;
  // Never while the payer has anything else unsettled here: the $0.50 cap is per payer, not per payment.
  if (max === undefined || s.held.prior > 0n || !READ_ONLY.has(s.req.method.toUpperCase())) return false;
  const usd = toUsdMicros({ atomic: s.price.amount, asset: ctx.config.asset, network: ctx.config.network }, ctx.config.assets);
  return usd !== undefined && usd <= max;
}

interface Settling {
  readonly req: ReqLike;
  readonly price: Price;
  readonly e: Expected;
  readonly claimKey: string;
  readonly claim: PaymentClaim;
  readonly held: Hold;
}

/** A failure before the row is written may free the claim; after it, only reconciliation or a retry moves the row. */
async function refuse(ctx: Ctx, s: Settling, f: SettleFailure): Promise<AcceptResult> {
  reportFailure(ctx, s.claimKey, f);
  if (f.final) await refuseRow(ctx, s.claimKey, f.code, f.txHash);
  if (f.release) await releasePayment(ctx.deps.claims, s.claim);
  return respond(ctx, f.code, s.req, s.price, f.status);
}

async function finishInBackground(ctx: Ctx, s: Settling, txHash: Hex): Promise<void> {
  try {
    const done = await confirm(ctx.env, s.e, txHash);
    if (done.ok) return await settleRow(ctx, s.claimKey, done.txHash);
    if (done.final) await refuseRow(ctx, s.claimKey, done.code, done.txHash);
    // confirm never frees a claim: the row exists, so the claim stays with it.
    report(ctx, failureReport(s.claimKey, done) ?? new AcceptError(done.code, 'an optimistically delivered payment did not settle'));
  } finally {
    ctx.active.delete(s.claimKey);
    s.held.release();
  }
}

type Outcome = { readonly result: AcceptResult; readonly handedOff: boolean } | { readonly existing: SellerPayment };

/** Steps 8–9: confirm (or hand off to the background when optimistic), then deliver once. */
async function confirmAndDeliver(ctx: Ctx, s: Settling, txHash: Hex, ours: boolean): Promise<Outcome> {
  if (ours && optimistic(ctx, s)) {
    // Deliver first: if that throws, no background task holds the slot behind our back.
    const result = await deliver(ctx, s.claimKey, false);
    const work: Promise<void> = finishInBackground(ctx, s, txHash).catch((error) => report(ctx, error)).finally(() => ctx.background.delete(work));
    ctx.background.add(work);
    return { result, handedOff: true };
  }
  const done = await confirm(ctx.env, s.e, txHash);
  if (!done.ok) return { result: await refuse(ctx, s, done), handedOff: false };
  await settleRow(ctx, s.claimKey, done.txHash);
  return { result: await deliverSettled(ctx, s.claimKey, s.req, s.price), handedOff: false };
}

/** Steps 6–9 for a claimed payment: pre-checks, the `owed` row, broadcast, confirmation, delivery. */
async function settleNew(ctx: Ctx, s: Settling, call: TransferCall, row: NewSellerPayment): Promise<Outcome> {
  const pre = await precheck(ctx.env, call, s.held.prior);
  if (!pre.ok) return { result: await refuse(ctx, s, pre), handedOff: false }; // nothing written, nothing sent
  let recorded;
  try {
    recorded = await ctx.deps.ledger.recordVerified(row);
  } catch (error) {
    await releasePayment(ctx.deps.claims, s.claim);
    throw error;
  }
  if (!recorded.created) {
    await releasePayment(ctx.deps.claims, s.claim);
    return { existing: recorded.row }; // the caller gives up its slot first, then treats it as seen before
  }
  if (pre.existing) return confirmAndDeliver(ctx, s, pre.existing, false); // front-run: settle from theirs
  const sent = await submit(ctx.env, call);
  if (!sent.ok) return { result: await refuse(ctx, s, sent), handedOff: false };
  if (sent.ours) await recordSubmitted(ctx, s.claimKey, sent.txHash);
  return confirmAndDeliver(ctx, s, sent.txHash, sent.ours);
}

/** Steps 4–5: signature, payer rate limit, capacity, then the claim. */
async function verifyAndClaim(ctx: Ctx, req: ReqLike, price: Price, sig: PaymentSignature, digest: string): Promise<AcceptResult> {
  const { config, deps } = ctx;
  const chainId = NETWORK.exec(sig.accepted.network)?.[1];
  if (chainId === undefined) return respond(ctx, E.MALFORMED, req);
  const claim = { chainId: Number(chainId), asset: sig.accepted.asset, signature: sig.payload.signature, authorization: sig.payload.authorization };
  const pinned = { chainId: config.chainId, asset: config.asset, domain: config.domain, payTo: config.payTo, amount: price.amount, maxWindowS: MAX_TIMEOUT_SECONDS };
  const v = await verifyEip3009(claim, pinned, Math.floor(deps.now() / 1000), deps.chain);
  if (!v.ok) return respond(ctx, v.code, req, price);
  // Only a verified payer spends its own bucket, so nobody can exhaust someone else's.
  if (!take(ctx, `payer:${v.payer.toLowerCase()}`, config.rateLimit.perPayerPerMinute)) return respond(ctx, E.RATE_LIMITED, req);

  const parts = { sellerAccountId: config.sellerAccountId, chainId: config.chainId, asset: config.asset, from: v.payer, nonce: v.nonce };
  const claimKey = singleUseKey(parts);
  if (ctx.active.has(claimKey)) return respond(ctx, E.IN_PROGRESS, req);
  if (ctx.active.size >= config.maxInFlight) return respond(ctx, E.BUSY, req);
  ctx.active.add(claimKey); // reserve the slot before awaiting, so concurrent requests cannot overshoot the cap
  let claimed: Awaited<ReturnType<typeof claimPayment>>;
  try {
    claimed = await claimPayment(deps.claims, parts, claimExpiry(v.validBefore));
  } catch (error) {
    ctx.active.delete(claimKey);
    throw error;
  }
  if (!claimed.ok) {
    ctx.active.delete(claimKey);
    const row = claimed.code === E.NONCE_REPLAY ? await deps.ledger.get(claimKey) : undefined;
    return row ? fromExisting(ctx, row, sig, digest, req, price) : respond(ctx, claimed.code, req, price);
  }
  const call: TransferCall = {
    asset: config.asset, signature: sig.payload.signature as Hex,
    authorization: { from: v.payer as Hex, to: config.payTo as Hex, value: v.value, validAfter: v.validAfter, validBefore: v.validBefore, nonce: v.nonce as Hex },
  };
  const row: NewSellerPayment = {
    claimKey, sellerAccountId: config.sellerAccountId, protocol: 'x402', chainId: config.chainId, asset: config.asset,
    payer: v.payer, nonce: v.nonce, amount: price.amount.toString(), payTo: config.payTo, validBefore: v.validBefore.toString(),
    method: req.method, path: req.path, queryDigest: sha256(req.query), headerDigest: digest, meta: price.meta ?? {},
  };
  const held = hold(ctx, v.payer, v.value);
  let out: Outcome | undefined;
  try {
    out = await settleNew(ctx, { req, price, e: expectedOf(call), claimKey, claim: claimed.claim, held }, call, row);
  } finally {
    // This call owns the slot and the hold until it hands them to the background; it releases them exactly once.
    if (out === undefined || !('handedOff' in out) || !out.handedOff) {
      ctx.active.delete(claimKey);
      held.release();
    }
  }
  return 'existing' in out ? fromExisting(ctx, out.existing, sig, digest, req, price) : out.result;
}

/** Steps 1–3: canonical path, price (headers only), strict parsing, IP rate limit; then an earlier payment or a new one. */
async function handlePayment(ctx: Ctx, req: ReqLike, given: Price | undefined): Promise<AcceptResult> {
  if (!canonicalPath(req.path)) return respond(ctx, E.MALFORMED, req);
  const price = priceOf(ctx.config, req, given);
  if (typeof price === 'string') return respond(ctx, price, req);
  const header = req.headers['payment-signature'];
  if (header !== undefined && hasMppCredential(req)) return respond(ctx, E.BOTH_HEADERS, req);
  if (header === undefined) return respond(ctx, E.PAYMENT_REQUIRED, req, price);

  let sig: PaymentSignature;
  try {
    sig = decodePaymentSignature(header);
  } catch (error) {
    return respond(ctx, error instanceof ProtocolError ? error.code : E.X402_MALFORMED, req);
  }
  if (price.contentLength !== undefined && req.headers['content-length'] !== String(price.contentLength)) {
    return respond(ctx, E.PRICE_MISMATCH, req);
  }
  if (!take(ctx, `ip:${ipBucket(req.clientIp)}`, ctx.config.rateLimit.perIpPerMinute)) return respond(ctx, E.RATE_LIMITED, req);

  const digest = sha256(header);
  const key = claimedKey(ctx.config, sig);
  const prior = key === undefined ? undefined : await ctx.deps.ledger.get(key);
  if (prior) return fromExisting(ctx, prior, sig, digest, req, price);
  return verifyAndClaim(ctx, req, price, sig, digest);
}

/** What an adapter needs: answer requests, report delivery failures. Both an Acceptor and `zoldSeller` are one. */
export type PaymentHandler = Pick<Acceptor, 'handle' | 'reportError'>;

/** The framework-neutral core. Wrap `handle` with an adapter (e.g. `nodeHandler`). */
export function accept(options: AcceptOptions, deps: AcceptDeps): Acceptor {
  const config = parseAcceptOptions(options);
  if (typeof deps.onError !== 'function') throw new AcceptError(E.CONFIG_INVALID, 'accept dependency onError is required');
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const resolved: Required<AcceptDeps> = {
    ...deps, sleep, rateLimiter: deps.rateLimiter ?? new MemoryRateLimiter(), now: deps.now ?? Date.now,
  };
  const ctx: Ctx = {
    config, deps: resolved, background: new Set(), active: new Set(), unsettled: new Map(),
    env: { config, chain: deps.chain, submitter: deps.submitter, sleep, now: deps.now ?? Date.now },
  };
  return {
    async handle(req, options) {
      try {
        return await handlePayment(ctx, req, options?.price);
      } catch (error) {
        report(ctx, error);
        return respond(ctx, E.INTERNAL, req);
      }
    },
    reportError(error) {
      report(ctx, error);
    },
    reconcileOwed: () => reconcileOwed(ctx),
    async idle() {
      while (ctx.background.size > 0) await Promise.all([...ctx.background]);
    },
  };
}
