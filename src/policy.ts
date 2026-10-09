import { type AssetRegistry, toUsdMicros } from './assets.js';
import type { ProtocolId, Quote } from './types.js';

export interface Policy {
  readonly maxPerTxUsdMicros: bigint;
  readonly dailyBudgetUsdMicros: bigint;
  /** Empty = any host. */
  readonly allowedHosts: readonly string[];
  /** Empty = any protocol. */
  readonly allowedProtocols: readonly ProtocolId[];
  /** Tie-break order when quotes cost the same. */
  readonly preference: readonly ProtocolId[];
}

export const DEFAULT_POLICY: Policy = {
  maxPerTxUsdMicros: 100_000n, // $0.10
  dailyBudgetUsdMicros: 1_000_000n, // $1.00
  allowedHosts: [],
  allowedProtocols: [],
  preference: ['x402', 'mpp'],
};

export type Verdict =
  | { readonly ok: true; readonly usdMicros: bigint }
  | { readonly ok: false; readonly reason: string };

const deny = (reason: string): Verdict => ({ ok: false, reason });

export function evaluate(
  quote: Quote,
  policy: Policy,
  assets: AssetRegistry,
  spentTodayMicros: bigint,
): Verdict {
  const { host, hostname } = new URL(quote.url);
  if (policy.allowedProtocols.length > 0 && !policy.allowedProtocols.includes(quote.protocol)) {
    return deny(`protocol ${quote.protocol} not allowed`);
  }
  // Case-insensitive; an entry may be a bare hostname or host:port.
  const allowed = policy.allowedHosts.map((h) => h.toLowerCase());
  if (allowed.length > 0 && !allowed.includes(host.toLowerCase()) && !allowed.includes(hostname.toLowerCase())) {
    return deny(`host ${host} not in allowlist`);
  }
  const usdMicros = toUsdMicros(quote.amount, assets);
  if (usdMicros === undefined) {
    return deny(`asset ${quote.amount.asset} on ${quote.amount.network} is not a registered stablecoin`);
  }
  if (usdMicros > policy.maxPerTxUsdMicros) {
    return deny(`price ${usdMicros} µUSD exceeds per-transaction cap ${policy.maxPerTxUsdMicros}`);
  }
  if (spentTodayMicros + usdMicros > policy.dailyBudgetUsdMicros) {
    return deny(`would exceed daily budget (${spentTodayMicros} spent of ${policy.dailyBudgetUsdMicros})`);
  }
  return { ok: true, usdMicros };
}
