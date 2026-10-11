import { type AssetRegistry, DEFAULT_ASSETS, assetKey } from 'agentpay-hub';
import type { Eip712Domain } from 'agentpay-hub/protocol';
import { AcceptError, AcceptErrorCode as E } from './errors.js';

/** What `price` may see: method, path and headers. Never the body, so pricing cannot be made to read it. */
export interface PriceRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface Price {
  /** Atomic units of the asset (USDC: 6 decimals). */
  readonly amount: bigint;
  /**
   * Stored with the payment for as long as the ledger keeps it, e.g. {size, ttl, filename} for an
   * upload. Keep it minimal and free of personal data where you can.
   */
  readonly meta?: Readonly<Record<string, string>>;
  /** If set, the paid request's Content-Length must equal it (the priced upload is the one delivered). */
  readonly contentLength?: number;
}

/** Synchronous and header-only. Throw on bad request headers (400); return garbage and it is a 500. */
export type PriceFn = (req: PriceRequest) => Price;

export interface AcceptOptions {
  readonly sellerAccountId: string;
  readonly payTo: string;
  readonly chainId: number;
  readonly asset: string;
  readonly price: PriceFn;
  /** `https://host[:port]`, used for the offer's resource URL. */
  readonly publicOrigin?: string;
  /** Default 2. */
  readonly minConfirmations?: number;
  /** Offered validity, default 120 s, max 240 so buyer clock skew stays under the 300 s verify cap. */
  readonly maxTimeoutSeconds?: number;
  /** How long a request waits for settlement. Default 60 000 ms. */
  readonly settlementTimeoutMs?: number;
  /** Default 1 000 ms. */
  readonly pollIntervalMs?: number;
  /** Deliver before confirmation: only GET/HEAD, only up to $0.50. */
  readonly optimistic?: { readonly maxUsd: string; readonly readOnly: true };
  readonly rateLimit?: { readonly perIpPerMinute?: number; readonly perPayerPerMinute?: number };
  /** Settlements in flight at once (each polls the chain); beyond it requests get 503 BUSY. Default 32. */
  readonly maxInFlight?: number;
  /** Must pin the asset's EIP-712 domain. Defaults to the router's registry (USDC on Base, Base Sepolia). */
  readonly assets?: AssetRegistry;
}

export interface AcceptConfig {
  readonly sellerAccountId: string;
  readonly payTo: string;
  readonly chainId: number;
  readonly asset: string;
  readonly network: string;
  readonly domain: Eip712Domain;
  readonly price: PriceFn;
  readonly publicOrigin?: string;
  readonly minConfirmations: number;
  readonly maxTimeoutSeconds: number;
  readonly settlementTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly optimisticMaxUsdMicros?: bigint;
  readonly rateLimit: { readonly perIpPerMinute: number; readonly perPayerPerMinute: number };
  readonly maxInFlight: number;
  readonly assets: AssetRegistry;
}

const KNOWN = new Set([
  'sellerAccountId', 'payTo', 'chainId', 'asset', 'price', 'publicOrigin', 'minConfirmations', 'maxTimeoutSeconds',
  'settlementTimeoutMs', 'pollIntervalMs', 'optimistic', 'rateLimit', 'maxInFlight', 'assets',
]);
const SELLER_ID = /^[A-Za-z0-9._:@-]{1,128}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/;
const USD = /^\d+(\.\d{1,6})?$/;
const MAX_OPTIMISTIC_MICROS = 500_000n;

const fail = (what: string): never => {
  throw new AcceptError(E.CONFIG_INVALID, `accept option ${what} is invalid`);
};

function intIn(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max ? (value as number) : fail(name);
}

function parseOrigin(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    return fail('publicOrigin');
  }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username) fail('publicOrigin');
  return url.origin;
}

function parseOptimistic(value: AcceptOptions['optimistic']): bigint | undefined {
  if (value === undefined) return undefined;
  const keys = Object.keys(value);
  if (value.readOnly !== true || !USD.test(String(value.maxUsd)) || keys.some((k) => k !== 'maxUsd' && k !== 'readOnly')) {
    return fail('optimistic');
  }
  const [whole = '0', frac = ''] = value.maxUsd.split('.');
  const micros = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
  return micros > 0n && micros <= MAX_OPTIMISTIC_MICROS ? micros : fail('optimistic.maxUsd');
}

function parseRateLimit(value: AcceptOptions['rateLimit']): AcceptConfig['rateLimit'] {
  if (value !== undefined && Object.keys(value).some((k) => k !== 'perIpPerMinute' && k !== 'perPayerPerMinute')) fail('rateLimit');
  return {
    perIpPerMinute: intIn(value?.perIpPerMinute, 120, 1, 1_000_000, 'rateLimit.perIpPerMinute'),
    perPayerPerMinute: intIn(value?.perPayerPerMinute, 60, 1, 1_000_000, 'rateLimit.perPayerPerMinute'),
  };
}

function pinnedDomain(chainId: number, asset: string, assets: AssetRegistry): { network: string; domain: Eip712Domain } {
  const network = `eip155:${chainId}`;
  const pinned = assets.get(assetKey(network, asset))?.eip712;
  if (!pinned) return fail('asset (no pinned EIP-712 domain for this chain)');
  return { network, domain: { name: pinned.name, version: pinned.version, chainId, verifyingContract: asset } };
}

/** Strict: unknown keys, out-of-range numbers and unpinned assets are errors, never defaults. */
export function parseAcceptOptions(options: AcceptOptions): AcceptConfig {
  if (Object.keys(options).some((k) => !KNOWN.has(k))) fail('(unknown key)');
  const { sellerAccountId, payTo, chainId, asset, price } = options;
  if (typeof sellerAccountId !== 'string' || !SELLER_ID.test(sellerAccountId)) fail('sellerAccountId');
  if (typeof payTo !== 'string' || !ADDRESS.test(payTo) || ZERO_ADDRESS.test(payTo)) fail('payTo');
  if (!Number.isSafeInteger(chainId) || chainId <= 0) fail('chainId');
  if (typeof asset !== 'string' || !ADDRESS.test(asset)) fail('asset');
  if (typeof price !== 'function') fail('price');
  const assets = options.assets ?? DEFAULT_ASSETS;
  const pollIntervalMs = intIn(options.pollIntervalMs, 1_000, 1, 60_000, 'pollIntervalMs');
  const settlementTimeoutMs = intIn(options.settlementTimeoutMs, 60_000, 1, 600_000, 'settlementTimeoutMs');
  if (settlementTimeoutMs < pollIntervalMs) fail('settlementTimeoutMs (shorter than one poll)');
  const optimisticMaxUsdMicros = parseOptimistic(options.optimistic);
  const publicOrigin = parseOrigin(options.publicOrigin);
  return {
    sellerAccountId, payTo, chainId, asset, price, assets, pollIntervalMs, settlementTimeoutMs,
    ...pinnedDomain(chainId, asset, assets),
    minConfirmations: intIn(options.minConfirmations, 2, 1, 64, 'minConfirmations'),
    maxTimeoutSeconds: intIn(options.maxTimeoutSeconds, 120, 60, 240, 'maxTimeoutSeconds'),
    rateLimit: parseRateLimit(options.rateLimit),
    maxInFlight: intIn(options.maxInFlight, 32, 1, 10_000, 'maxInFlight'),
    ...(publicOrigin !== undefined ? { publicOrigin } : {}),
    ...(optimisticMaxUsdMicros !== undefined ? { optimisticMaxUsdMicros } : {}),
  };
}
