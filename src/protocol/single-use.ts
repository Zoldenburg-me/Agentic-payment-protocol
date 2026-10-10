import { randomUUID } from 'node:crypto';
import { ProtocolError, ProtocolErrorCode as E, type Refusal, refuse } from './errors.js';

/** Claims outlive `validBefore` by this much, so clock skew cannot reopen a nonce. */
export const CLAIM_MARGIN_S = 600;

export interface SingleUseKeyParts {
  readonly sellerAccountId: string;
  readonly chainId: number;
  readonly asset: string;
  readonly from: string;
  readonly nonce: string;
}

const SELLER_ID = /^[A-Za-z0-9._:@-]{1,128}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/** `sellerAccountId|chainId|asset|from|nonce`, with hex lower-cased so re-casing cannot dodge a replay. */
export function singleUseKey(p: SingleUseKeyParts): string {
  const valid =
    SELLER_ID.test(p.sellerAccountId) && Number.isSafeInteger(p.chainId) && p.chainId > 0 &&
    ADDRESS.test(p.asset) && ADDRESS.test(p.from) && BYTES32.test(p.nonce);
  if (!valid) throw new ProtocolError(E.MALFORMED, 'single-use key parts are invalid');
  return [p.sellerAccountId, p.chainId, p.asset.toLowerCase(), p.from.toLowerCase(), p.nonce.toLowerCase()].join('|');
}

export function claimExpiry(validBefore: bigint, marginS: number = CLAIM_MARGIN_S): number {
  if (!Number.isSafeInteger(marginS) || marginS < 0) throw new ProtocolError(E.MALFORMED, 'claim margin must be whole seconds');
  if (validBefore < 0n || validBefore > BigInt(Number.MAX_SAFE_INTEGER - marginS)) {
    throw new ProtocolError(E.MALFORMED, 'validBefore is out of range');
  }
  return Number(validBefore) + marginS;
}

export type ClaimResult = { readonly ok: true; readonly token: string } | Refusal;

/**
 * At most one claim per key until it expires. `claim` must be atomic in every
 * implementation (a DB unique constraint, or SET NX); `release` needs the winner's token,
 * so a stale holder can never free a newer claim.
 *
 * Release only when the authorization provably did not settle (`authorizationState` is
 * false and no submission can still be mined); releasing after an ambiguous submit lets
 * one payment be delivered twice. Release at once when the pre-submit simulation fails
 * (unfunded payer), and rate-limit before claiming: a valid signature costs an attacker
 * nothing, so unfunded claims could otherwise fill the store. Call `prune` on a timer.
 */
export interface SingleUseStore {
  claim(key: string, expiresAtSec: number): Promise<ClaimResult>;
  release(key: string, token: string): Promise<boolean>;
  prune(nowSec: number): Promise<number>;
}

interface Claim {
  readonly token: string;
  readonly expiresAtSec: number;
}

export const DEFAULT_MAX_CLAIMS = 100_000;

/**
 * Single-process store for tests and one-instance sellers. An expired claim still blocks
 * until pruned, and a full store refuses new claims (fail closed) rather than growing.
 */
export class MemorySingleUseStore implements SingleUseStore {
  private readonly claims = new Map<string, Claim>();
  private readonly maxEntries: number;

  constructor(options: { readonly maxEntries?: number } = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_CLAIMS;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new ProtocolError(E.CONFIG_INVALID, 'maxEntries must be a positive integer');
    this.maxEntries = maxEntries;
  }

  async claim(key: string, expiresAtSec: number): Promise<ClaimResult> {
    if (!Number.isInteger(expiresAtSec)) throw new ProtocolError(E.MALFORMED, 'claim expiry must be an integer');
    // No await between the checks and the set: this is the atomic step.
    if (this.claims.has(key)) return refuse(E.NONCE_REPLAY);
    if (this.claims.size >= this.maxEntries) return refuse(E.STORE_FULL);
    const claim: Claim = { token: randomUUID(), expiresAtSec };
    this.claims.set(key, claim);
    return { ok: true, token: claim.token };
  }

  async release(key: string, token: string): Promise<boolean> {
    if (this.claims.get(key)?.token !== token) return false;
    return this.claims.delete(key);
  }

  async prune(nowSec: number): Promise<number> {
    const expired = [...this.claims].filter(([, c]) => c.expiresAtSec <= nowSec).map(([k]) => k);
    for (const key of expired) this.claims.delete(key);
    return expired.length;
  }
}

export interface AuthorizationKeyParts {
  readonly chainId: number;
  readonly asset: string;
  readonly from: string;
  readonly nonce: string;
}

/** `#` is outside the seller-id alphabet, so no seller key can equal an authorization key. */
const AUTH_KEY_PREFIX = '#auth';

/**
 * Chain-wide key: on-chain an EIP-3009 authorization is unique per (asset, from, nonce),
 * so it may be accepted by at most one seller account, whatever their payTo.
 */
export function authorizationKey(p: AuthorizationKeyParts): string {
  const valid = Number.isSafeInteger(p.chainId) && p.chainId > 0 &&
    ADDRESS.test(p.asset) && ADDRESS.test(p.from) && BYTES32.test(p.nonce);
  if (!valid) throw new ProtocolError(E.MALFORMED, 'authorization key parts are invalid');
  return [AUTH_KEY_PREFIX, p.chainId, p.asset.toLowerCase(), p.from.toLowerCase(), p.nonce.toLowerCase()].join('|');
}

export interface PaymentClaim {
  readonly authKey: string;
  readonly authToken: string;
  readonly sellerKey: string;
  readonly sellerToken: string;
}

export type PaymentClaimResult = { readonly ok: true; readonly claim: PaymentClaim } | Refusal;

/**
 * Claims the chain-wide authorization key first, then the seller key. If the seller claim
 * is refused, the chain-wide claim is released again (with its own token), so a refusal
 * never leaves a half-claimed payment behind.
 */
export async function claimPayment(
  store: SingleUseStore, parts: SingleUseKeyParts, expiresAtSec: number,
): Promise<PaymentClaimResult> {
  const authKey = authorizationKey(parts);
  const sellerKey = singleUseKey(parts);
  const auth = await store.claim(authKey, expiresAtSec);
  if (!auth.ok) return auth;
  const seller = await store.claim(sellerKey, expiresAtSec);
  if (!seller.ok) {
    await store.release(authKey, auth.token);
    return seller;
  }
  return { ok: true, claim: { authKey, authToken: auth.token, sellerKey, sellerToken: seller.token } };
}

/**
 * Releases the seller key, then the chain-wide key, under the same rules as `release`.
 * The order fails safe: a bad auth token leaves the authorization blocked everywhere, never
 * free at another seller. Returns whether the chain-wide key was released, since that key
 * decides whether the authorization can be accepted again.
 */
export async function releasePayment(store: SingleUseStore, claim: PaymentClaim): Promise<boolean> {
  await store.release(claim.sellerKey, claim.sellerToken);
  return store.release(claim.authKey, claim.authToken);
}
