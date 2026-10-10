import type { Money } from './types.js';

/** All registered assets are treated as USD-pegged. Unknown assets are never paid. */
export interface AssetInfo {
  readonly symbol: string;
  readonly decimals: number;
  /** EIP-712 domain name/version, read on-chain and pinned here. Without it the asset is never signed for. */
  readonly eip712?: { readonly name: string; readonly version: string };
}

export type AssetRegistry = ReadonlyMap<string, AssetInfo>;

const USD_MICRO_DECIMALS = 6;

export const assetKey = (network: string, asset: string): string =>
  `${network}:${asset.toLowerCase()}`;

/**
 * Circle USDC (FiatToken v2.2). Domains read on-chain 2026-10-10 via name()/version(), checked
 * against DOMAIN_SEPARATOR() and the EIP-3009 TRANSFER_WITH_AUTHORIZATION_TYPEHASH.
 */
export const DEFAULT_ASSETS: AssetRegistry = new Map<string, AssetInfo>([
  [assetKey('eip155:8453', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
    { symbol: 'USDC', decimals: 6, eip712: { name: 'USD Coin', version: '2' } }],
  [assetKey('eip155:84532', '0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
    { symbol: 'USDC', decimals: 6, eip712: { name: 'USDC', version: '2' } }],
]);

export function withAssets(base: AssetRegistry, extra: Iterable<[string, AssetInfo]>): AssetRegistry {
  return new Map([...base, ...extra]);
}

/** Convert to micro-USD (1e-6 USD), or undefined if the asset is not registered. */
export function toUsdMicros(money: Money, assets: AssetRegistry): bigint | undefined {
  const info = assets.get(assetKey(money.network, money.asset));
  if (!info) return undefined;
  const shift = info.decimals - USD_MICRO_DECIMALS;
  if (shift < 0) return money.atomic * 10n ** BigInt(-shift);
  const divisor = 10n ** BigInt(shift);
  return (money.atomic + divisor - 1n) / divisor; // round up: dust must still count
}

export const formatUsd = (micros: bigint): string => `$${(Number(micros) / 1e6).toFixed(6)}`;
