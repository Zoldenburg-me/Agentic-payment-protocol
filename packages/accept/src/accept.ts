import { createHash } from 'node:crypto';
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
  /** Serve from this (as priced and paid), not from anything the request can still change. */
  readonly meta: Readonly<Record<string, string>>;
  /** False only for optimistic delivery: the transfer was sent but not yet confirmed. */
  readonly settled: boolean;
  /** True when this is a retry of a payment that was already delivered. */
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
   * Required: internal failures, ledger errors and optimistic deliveries that did not settle
   * (an AcceptError with the code) all land here, since no request is left to answer them.
   */
  readonly onError: (error: unknown) => void;
  readonly rateLimiter?: RateLimiter;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface Acceptor {
  handle(req: ReqLike): Promise<AcceptResult>;
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
}

const READ_ONLY = new Set(['GET', 'HEAD']);
const MAX_UINT256 = 2n ** 256n - 1n;
const NETWORK = /^eip155:([1-9]\d{0,15})$/;
const RETRY_AFTER: Partial<Record<AcceptErrorCode, string>> = { [E.RATE_LIMITED]: '60', [E.IN_PROGRESS]: '1', [E.BUSY]: '1' };
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

function report(ctx: Ctx, error: unknown): void {
  try {
    ctx.deps.onError(error);
  } catch {
    // A failing error reporter must never take the payment path (or the process) down with it.
  }
}

function respond(ctx: Ctx, code: AcceptErrorCode, req: ReqLike, price?: Price, status = statusFor(code)): AcceptResult {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // Every 402 carries a fresh offer, so the buyer can pay (again) without another round trip.
  if (status === 402 && price) headers['PAYMENT-REQUIRED'] = offerHeader(ctx.config, req.path, price.amount);
  const retryAfter = RETRY_AFTER[code];
  if (retryAfter) headers['retry-after'] = retryAfter;
  return { kind: 'respond', status, headers, body: JSON.stringify({ error: code }) };
}

/** Origin-form only, no dot segments, no empty segments, no encoded dots or separators. */
function canonicalPath(path: string): boolean {
  return /^\/[^\s?#\\]*$/.test(path) && !path.includes('//') && !/(^|\/)\.{1,2}(\/|$)/.test(path) && !/%(2e|2f|5c)/i.test(path);
}

const isStringRecord = (v: unknown): v is Record<string, string> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');

function priceOf(config: AcceptConfig, req: ReqLike): Price | AcceptErrorCode {
  let p: Price;
  try {
    p = config.price({ method: req.method, path: req.path, headers: req.headers });
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

const sameMeta = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** A replay must be the same payment for the same thing: header, method, path, query, price and meta. */
const sameRequest = (row: SellerPayment, digest: string, req: ReqLike, price: Price): boolean =>
  row.headerDigest === digest && row.method === req.method && row.path === req.path && row.queryDigest === sha256(req.query) &&
  row.amount === price.amount.toString() && sameMeta(row.meta, price.meta ?? {});

function paidResult(ctx: Ctx, row: SellerPayment, settled: boolean, replayed: boolean): AcceptResult {
  return {
    kind: 'paid',
    headers: { 'PAYMENT-RESPONSE': paymentResponseHeader(ctx.config, row.txHash, row.payer) },
    paid: {
      claimKey: row.claimKey, protocol: 'x402', payer: row.payer, amount: BigInt(row.amount), txHash: row.txHash,
      chainId: row.chainId, asset: row.asset, nonce: row.nonce, meta: row.meta, settled, replayed,
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

async function refuseRow(ctx: Ctx, claimKey: string, code: AcceptErrorCode): Promise<void> {
  if (!isOpen(await ctx.deps.ledger.get(claimKey))) return;
  try {
    await ctx.deps.ledger.recordRefused(claimKey, code);
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

const expectedOfRow = (ctx: Ctx, row: SellerPayment): Expected =>
  ({ asset: row.asset, from: row.payer, to: ctx.config.payTo, value: BigInt(row.amount), nonce: row.nonce as Hex });

/** Our transaction if we sent one (confirm follows a front-runner from it), else whichever used the authorization. */
async function txFor(ctx: Ctx, row: SellerPayment, e: Expected): Promise<Hex | undefined> {
  return (row.txHash as Hex | undefined) ?? ctx.deps.chain.findAuthorizationUse(e.asset, e.from, e.nonce);
}

const needsReconciliation = (claimKey: string): AcceptError =>
  new AcceptError(E.SETTLEMENT_UNKNOWN, `payment ${claimKey} is used on chain but its transaction cannot be found: reconcile`);

/** A row with no known transaction: expire it if it can never settle, report it if it is used but untraceable. */
async function withoutTransaction(ctx: Ctx, row: SellerPayment, e: Expected, req: ReqLike, price: Price): Promise<AcceptResult> {
  const used = await ctx.deps.chain.authorizationState(e.asset, e.from, e.nonce);
  if (!used && expired(ctx, row)) {
    await refuseRow(ctx, row.claimKey, E.EXPIRED); // never sent, and now it never can be
    return respond(ctx, E.EXPIRED, req, price);
  }
  if (used) report(ctx, needsReconciliation(row.claimKey)); // a lagging or limited log index; reconcileOwed resolves it
  return respond(ctx, E.IN_PROGRESS, req);
}

/**
 * An owed or submitted row whose outcome was unknown, or whose own transaction reverted while the
 * authorization stayed valid: look at the chain again. It becomes final only once validBefore has passed.
 */
async function resume(ctx: Ctx, row: SellerPayment, req: ReqLike, price: Price): Promise<AcceptResult> {
  const e = expectedOfRow(ctx, row);
  ctx.active.add(row.claimKey);
  try {
    let txHash: Hex | undefined;
    try {
      txHash = await txFor(ctx, row, e);
      if (!txHash) return await withoutTransaction(ctx, row, e, req, price);
    } catch (error) {
      report(ctx, error); // an RPC or ledger failure: the row stays open, but nobody should have to guess why
      return respond(ctx, E.IN_PROGRESS, req);
    }
    const done = await confirm(ctx.env, e, txHash);
    if (done.ok) {
      await settleRow(ctx, row.claimKey, done.txHash);
      return await deliverSettled(ctx, row.claimKey, req, price);
    }
    if (done.code === E.SETTLEMENT_TIMEOUT && expired(ctx, row)) {
      // Our transaction never mined and nobody else used the authorization: past the deadline it never can be.
      const expiredUnused = await ctx.deps.chain.authorizationState(e.asset, e.from, e.nonce).then((used) => !used, () => false);
      if (expiredUnused) {
        await refuseRow(ctx, row.claimKey, E.EXPIRED);
        return respond(ctx, E.EXPIRED, req, price);
      }
    }
    if (done.code === E.SETTLEMENT_UNKNOWN) report(ctx, needsReconciliation(row.claimKey));
    // A revert is final only past the deadline, and only if the authorization is still unused right now.
    const revertedForGood = done.code === E.SUBMIT_FAILED && expired(ctx, row) &&
      await ctx.deps.chain.authorizationState(e.asset, e.from, e.nonce).then((used) => !used, () => false);
    if (done.final || revertedForGood) {
      await refuseRow(ctx, row.claimKey, done.code);
      return respond(ctx, done.code, req, price, done.status);
    }
    return done.code === E.SUBMIT_FAILED ? respond(ctx, done.code, req, price, done.status) : respond(ctx, E.IN_PROGRESS, req);
  } finally {
    ctx.active.delete(row.claimKey);
  }
}

/** A payment this seller has seen before: repeat the refusal, replay a delivery, or resume an unknown outcome. */
async function fromExisting(ctx: Ctx, row: SellerPayment, digest: string, req: ReqLike, price: Price): Promise<AcceptResult> {
  if (!sameRequest(row, digest, req, price)) return respond(ctx, E.NONCE_REPLAY, req);
  if (row.status === 'refused') return respond(ctx, row.refusal ?? E.INTERNAL, req, price);
  if (row.status === 'settled') return deliver(ctx, row.claimKey, true);
  // Not settled (including an optimistic delivery still unconfirmed): never replay it, re-check the chain.
  if (ctx.active.has(row.claimKey)) return respond(ctx, E.IN_PROGRESS, req);
  if (ctx.active.size >= ctx.config.maxInFlight) return respond(ctx, E.BUSY, req);
  // Resuming polls the chain: it spends the (verified, stored) payer's bucket, not just the IP's.
  if (!take(ctx, `payer:${row.payer.toLowerCase()}`, ctx.config.rateLimit.perPayerPerMinute)) return respond(ctx, E.RATE_LIMITED, req);
  return resume(ctx, row, req, price);
}

function optimistic(ctx: Ctx, req: ReqLike, amount: bigint): boolean {
  const max = ctx.config.optimisticMaxUsdMicros;
  if (max === undefined || !READ_ONLY.has(req.method.toUpperCase())) return false;
  const usd = toUsdMicros({ atomic: amount, asset: ctx.config.asset, network: ctx.config.network }, ctx.config.assets);
  return usd !== undefined && usd <= max;
}

interface Settling {
  readonly req: ReqLike;
  readonly price: Price;
  readonly e: Expected;
  readonly claimKey: string;
  readonly claim: PaymentClaim;
}

async function refuse(ctx: Ctx, s: Settling, f: SettleFailure): Promise<AcceptResult> {
  if (f.code === E.SETTLEMENT_UNKNOWN) report(ctx, needsReconciliation(s.claimKey));
  if (f.code === E.AUTHORIZATION_USED) {
    // Used or cancelled with no transaction found: if it was used, the seller may have been paid.
    report(ctx, new AcceptError(E.AUTHORIZATION_USED, `payment ${s.claimKey} is used or cancelled on chain with no transaction found: check`));
  }
  if (f.final) await refuseRow(ctx, s.claimKey, f.code);
  if (f.release) await releasePayment(ctx.deps.claims, s.claim);
  return respond(ctx, f.code, s.req, s.price, f.status);
}

async function finishInBackground(ctx: Ctx, s: Settling, txHash: Hex): Promise<void> {
  try {
    const done = await confirm(ctx.env, s.e, txHash);
    if (done.ok) return await settleRow(ctx, s.claimKey, done.txHash);
    if (done.final) await refuseRow(ctx, s.claimKey, done.code);
    if (done.release) await releasePayment(ctx.deps.claims, s.claim);
    report(ctx, new AcceptError(done.code, 'an optimistically delivered payment did not settle'));
  } finally {
    ctx.active.delete(s.claimKey);
  }
}

/** Steps 8–9: confirm (or hand off to the background when optimistic), then deliver once. */
async function confirmAndDeliver(ctx: Ctx, s: Settling, txHash: Hex, ours: boolean): Promise<{ result: AcceptResult; handedOff: boolean }> {
  if (ours && optimistic(ctx, s.req, s.price.amount)) {
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
async function settleNew(ctx: Ctx, s: Settling, call: TransferCall, row: NewSellerPayment): Promise<{ result: AcceptResult; handedOff: boolean }> {
  const pre = await precheck(ctx.env, call);
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
    ctx.active.delete(s.claimKey);
    return { result: await fromExisting(ctx, recorded.row, row.headerDigest, s.req, s.price), handedOff: false };
  }
  if (pre.existing) return confirmAndDeliver(ctx, s, pre.existing, false); // front-run: settle from theirs
  const sent = await submit(ctx.env, call);
  if (!sent.ok) return { result: await refuse(ctx, s, sent), handedOff: false };
  if (sent.ours) await ctx.deps.ledger.recordSubmitted(s.claimKey, sent.txHash);
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
    return row ? fromExisting(ctx, row, digest, req, price) : respond(ctx, claimed.code, req, price);
  }
  const call: TransferCall = {
    asset: config.asset, signature: sig.payload.signature as Hex,
    authorization: { from: v.payer as Hex, to: config.payTo as Hex, value: v.value, validAfter: v.validAfter, validBefore: v.validBefore, nonce: v.nonce as Hex },
  };
  const row: NewSellerPayment = {
    claimKey, sellerAccountId: config.sellerAccountId, protocol: 'x402', chainId: config.chainId, asset: config.asset,
    payer: v.payer, nonce: v.nonce, amount: price.amount.toString(), validBefore: v.validBefore.toString(),
    method: req.method, path: req.path, queryDigest: sha256(req.query), headerDigest: digest, meta: price.meta ?? {},
  };
  let handedOff = false;
  try {
    const out = await settleNew(ctx, { req, price, e: expectedOf(call), claimKey, claim: claimed.claim }, call, row);
    handedOff = out.handedOff;
    return out.result;
  } finally {
    if (!handedOff) ctx.active.delete(claimKey);
  }
}

/** Steps 1–3: canonical path, price (headers only), strict parsing, IP rate limit; then an earlier payment or a new one. */
async function handlePayment(ctx: Ctx, req: ReqLike): Promise<AcceptResult> {
  if (!canonicalPath(req.path)) return respond(ctx, E.MALFORMED, req);
  const price = priceOf(ctx.config, req);
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
  if (!take(ctx, `ip:${req.clientIp}`, ctx.config.rateLimit.perIpPerMinute)) return respond(ctx, E.RATE_LIMITED, req);

  const digest = sha256(header);
  const key = claimedKey(ctx.config, sig);
  const prior = key === undefined ? undefined : await ctx.deps.ledger.get(key);
  if (prior) return fromExisting(ctx, prior, digest, req, price);
  return verifyAndClaim(ctx, req, price, sig, digest);
}

/** The framework-neutral core. Wrap `handle` with an adapter (e.g. `nodeHandler`). */
export function accept(options: AcceptOptions, deps: AcceptDeps): Acceptor {
  const config = parseAcceptOptions(options);
  if (typeof deps.onError !== 'function') throw new AcceptError(E.CONFIG_INVALID, 'accept dependency onError is required');
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const resolved: Required<AcceptDeps> = {
    ...deps, sleep, rateLimiter: deps.rateLimiter ?? new MemoryRateLimiter(), now: deps.now ?? Date.now,
  };
  const ctx: Ctx = {
    config, deps: resolved, background: new Set(), active: new Set(),
    env: { config, chain: deps.chain, submitter: deps.submitter, sleep },
  };
  return {
    async handle(req) {
      try {
        return await handlePayment(ctx, req);
      } catch (error) {
        report(ctx, error);
        return respond(ctx, E.INTERNAL, req);
      }
    },
    async idle() {
      while (ctx.background.size > 0) await Promise.all([...ctx.background]);
    },
  };
}
