import { createHash } from 'node:crypto';
import type { Hex } from 'viem';
import { type PrivateKeyAccount, generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { MemorySingleUseStore, TRANSFER_WITH_AUTHORIZATION_TYPES, encodePaymentSignature } from 'agentpay-hub/protocol';
import {
  type AcceptDeps, type AcceptOptions, type AcceptResult, type ReqLike, FakeFiatToken, MemoryRateLimiter,
  MemorySellerLedger, accept,
} from '../src/index.js';

export const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
export const PAY_TO = '0x000000000000000000000000000000000000dEaD' as const;
export const CHAIN_ID = 84532;
export const DOMAIN = { name: 'USDC', version: '2', chainId: CHAIN_ID, verifyingContract: USDC } as const;
export const NOW_S = 1_800_000_000;
export const PRICE = 10_000n;

export interface AuthOverrides {
  readonly to?: string;
  readonly value?: bigint;
  readonly validAfter?: bigint;
  readonly validBefore?: bigint;
  readonly nonce?: Hex;
  readonly domain?: { name: string; version: string; chainId: number; verifyingContract: string };
  readonly accepted?: Record<string, unknown>;
  readonly x402Version?: number;
}

/** Builds a PAYMENT-SIGNATURE header the way an x402 v2 buyer would. */
export async function payHeader(account: PrivateKeyAccount, over: AuthOverrides = {}): Promise<string> {
  const authorization = {
    from: account.address,
    to: (over.to ?? PAY_TO) as Hex,
    value: over.value ?? PRICE,
    validAfter: over.validAfter ?? BigInt(NOW_S - 600),
    validBefore: over.validBefore ?? BigInt(NOW_S + 120),
    nonce: over.nonce ?? (`0x${'11'.repeat(32)}` as Hex),
  };
  const domain = over.domain ?? DOMAIN;
  const signature = await account.signTypedData({
    domain: { ...domain, verifyingContract: domain.verifyingContract as Hex },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization', message: authorization,
  });
  const accepted = {
    scheme: 'exact', network: `eip155:${CHAIN_ID}`, amount: PRICE.toString(), asset: USDC, payTo: PAY_TO,
    maxTimeoutSeconds: 120, extra: { name: 'USDC', version: '2' }, ...over.accepted,
  };
  const payload = {
    signature,
    authorization: {
      from: authorization.from, to: authorization.to, value: authorization.value.toString(),
      validAfter: authorization.validAfter.toString(), validBefore: authorization.validBefore.toString(),
      nonce: authorization.nonce,
    },
  };
  if (over.x402Version !== undefined) {
    return Buffer.from(JSON.stringify({ x402Version: over.x402Version, accepted, payload })).toString('base64');
  }
  return encodePaymentSignature({ x402Version: 2, accepted: accepted as never, payload });
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Yields a macrotask, so a test can act (mine, reorg) while a request is waiting for confirmations. */
export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function setup(
  over: Partial<AcceptOptions> = {}, chainOver: { autoMine?: boolean } = {}, depsOver: Partial<AcceptDeps> = {},
) {
  let nowMs = NOW_S * 1000;
  const chain = new FakeFiatToken({
    chainId: CHAIN_ID, asset: USDC, domain: DOMAIN, nowSec: () => Math.floor(nowMs / 1000), ...chainOver,
  });
  const ledger = new MemorySellerLedger();
  const claims = new MemorySingleUseStore();
  const buyer = privateKeyToAccount(generatePrivateKey());
  chain.mint(buyer.address, 1_000_000n);
  const options: AcceptOptions = {
    sellerAccountId: 'seller-1', payTo: PAY_TO, chainId: CHAIN_ID, asset: USDC,
    price: () => ({ amount: PRICE }), pollIntervalMs: 1, settlementTimeoutMs: 2000, ...over,
  };
  const errors: unknown[] = [];
  const acceptor = accept(options, {
    ledger, claims, chain, submitter: chain, rateLimiter: new MemoryRateLimiter(),
    now: () => nowMs, sleep: tick, onError: (e) => { errors.push(e); }, ...depsOver,
  });
  const req = (headers: Record<string, string> = {}, more: Partial<ReqLike> = {}): ReqLike => ({
    method: 'GET', path: '/rates', query: '', clientIp: '203.0.113.7', headers, ...more,
  });
  return {
    chain, ledger, claims, buyer, acceptor, req, options, errors,
    advance: (ms: number) => { nowMs += ms; },
  };
}

export const bodyOf = (r: AcceptResult): Record<string, unknown> =>
  (r.kind === 'respond' ? JSON.parse(r.body) : {}) as Record<string, unknown>;

export const codeOf = (r: AcceptResult): unknown => bodyOf(r).error;
