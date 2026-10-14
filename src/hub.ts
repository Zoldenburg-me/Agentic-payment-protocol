import { type AssetRegistry, DEFAULT_ASSETS, assetKey } from './assets.js';
import { DEFAULT_ADAPTERS } from './adapters/index.js';
import { Ledger } from './ledger.js';
import { DEFAULT_POLICY, type Policy, type Verdict, evaluate } from './policy.js';
import { ProtocolError, ProtocolErrorCode } from './protocol/errors.js';
import type { ProtocolAdapter, Quote, Receipt, Wallet } from './types.js';

export interface HubOptions {
  readonly wallet?: Wallet;
  readonly policy?: Partial<Policy>;
  readonly assets?: AssetRegistry;
  readonly adapters?: readonly ProtocolAdapter[];
  readonly ledger?: Ledger;
  readonly fetch?: typeof globalThis.fetch;
}

/** Request shape kept replayable (string body) because it is sent twice on a paywall. */
export interface HubRequest {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface QuoteReport {
  readonly quote: Quote;
  readonly verdict: Verdict;
  readonly canPay: boolean;
}

export type HubResult =
  | { readonly status: 'free'; readonly response: Response }
  | { readonly status: 'quoted'; readonly quotes: readonly QuoteReport[] }
  | { readonly status: 'blocked'; readonly quotes: readonly QuoteReport[] }
  | { readonly status: 'unsupported'; readonly response: Response; readonly reason?: 'cross-origin' }
  | {
      readonly status: 'paid';
      readonly response: Response;
      readonly quote: Quote;
      readonly usdMicros: bigint;
      readonly receipt?: Receipt;
    }
  | { readonly status: 'rejected'; readonly response: Response; readonly quote: Quote };

export type HubMode = 'pay' | 'quote';

const REQUEST_TIMEOUT_MS = 15_000;

/** Frees the connection of a response the caller never sees. */
async function discardBody<T>(res: Response, result: T): Promise<T> {
  await res.body?.cancel().catch(() => undefined);
  return result;
}

/** True if the response did not come from the origin that was asked (a followed redirect). */
function leftOrigin(res: Response, requested: string): boolean {
  if (res.redirected) return true;
  if (!res.url) return false;
  try {
    return new URL(res.url).origin !== new URL(requested).origin;
  } catch {
    return true;
  }
}

/** Agent-supplied headers can never override payment headers, whatever their casing. */
function mergeHeaders(
  agent: Readonly<Record<string, string>> | undefined,
  payment: Readonly<Record<string, string>>,
): Record<string, string> {
  const reserved = new Set(Object.keys(payment).map((k) => k.toLowerCase()));
  reserved.add('payment-signature');
  const kept = Object.entries(agent ?? {}).filter(([k]) => !reserved.has(k.toLowerCase()));
  return { ...Object.fromEntries(kept), ...payment };
}

/**
 * The aggregator. Sends a request; if the server answers 402, asks every adapter what
 * it can read, applies spend policy, picks the cheapest payable quote, pays through
 * the matching adapter and replays the request once.
 */
export class PaymentHub {
  readonly ledger: Ledger;
  readonly policy: Policy;
  private readonly wallet: Wallet;
  private readonly assets: AssetRegistry;
  private readonly adapters: readonly ProtocolAdapter[];
  private readonly doFetch: typeof globalThis.fetch;

  constructor(options: HubOptions = {}) {
    this.wallet = options.wallet ?? {};
    this.policy = { ...DEFAULT_POLICY, ...options.policy };
    this.assets = options.assets ?? DEFAULT_ASSETS;
    this.adapters = options.adapters ?? DEFAULT_ADAPTERS;
    this.ledger = options.ledger ?? new Ledger();
    this.doFetch = options.fetch ?? globalThis.fetch;
  }

  /** Protocols this hub can currently pay with (adapter present AND wallet capable). */
  payableProtocols(): readonly string[] {
    return this.adapters.filter((a) => a.canPay(this.wallet)).map((a) => a.id);
  }

  async request(url: string, init: HubRequest = {}, mode: HubMode = 'pay'): Promise<HubResult> {
    const first = await this.send(url, init);
    if (first.status !== 402) return { status: 'free', response: first };
    // A 402 that came from somewhere else (a fetch that followed a redirect anyway) is not
    // an offer for this URL: paying it would send a signature the asked-for origin never quoted.
    if (leftOrigin(first, url)) return { status: 'unsupported', response: first, reason: 'cross-origin' };

    // A malformed offer from one protocol must not break the others.
    const quotes = (
      await Promise.all(this.adapters.map((a) => a.parseQuotes(first, url).catch(() => [] as const)))
    ).flat();
    if (quotes.length === 0) return { status: 'unsupported', response: first };

    const spent = this.ledger.spentToday();
    const reports = quotes.map<QuoteReport>((quote) => ({
      quote,
      verdict: evaluate(quote, this.policy, this.assets, spent),
      canPay: this.adapterFor(quote).canPay(this.wallet) && this.signable(quote),
    }));
    if (mode === 'quote') return discardBody(first, { status: 'quoted', quotes: reports });

    const choice = this.choose(reports);
    if (!choice || !choice.verdict.ok) return discardBody(first, { status: 'blocked', quotes: reports });
    await discardBody(first, undefined);
    return this.pay(url, init, choice.quote, reports);
  }

  private async pay(
    url: string, init: HubRequest, quote: Quote, reports: readonly QuoteReport[],
  ): Promise<HubResult> {
    // The caller awaited after its policy check, so re-check against the current ledger and
    // reserve in the same synchronous step: concurrent calls cannot both pass and overspend.
    const verdict = evaluate(quote, this.policy, this.assets, this.ledger.spentToday());
    if (!verdict.ok) {
      return { status: 'blocked', quotes: reports.map((r) => (r.quote === quote ? { ...r, verdict } : r)) };
    }
    const { usdMicros } = verdict; // the price just checked, never one computed before the await
    const entryId = this.ledger.reserve(url, quote.protocol, usdMicros);
    const adapter = this.adapterFor(quote);

    let payHeaders: Readonly<Record<string, string>>;
    try {
      payHeaders = await adapter.authorize(quote, this.wallet);
    } catch (error) {
      // An x402 signer only signs: nothing was sent, so nothing can be spent. An MPP signer
      // may already have paid before failing, so its amount stays counted.
      this.ledger.settle(entryId, quote.protocol === 'x402' ? 'released' : 'unconfirmed');
      if (error instanceof ProtocolError && error.code === ProtocolErrorCode.ASSET_DOMAIN_UNPINNED) {
        return { status: 'blocked', quotes: reports }; // the signer's registry lacks this asset
      }
      throw error;
    }

    try {
      const second = await this.send(url, { ...init, headers: mergeHeaders(init.headers, payHeaders) });
      // Anything but a same-origin 2xx keeps the amount counted and is not delivery: the
      // server holds a valid signed authorization and could still settle it, a redirect is
      // never followed, and an error status served nothing.
      const rejected = !second.ok || leftOrigin(second, url);
      // Only a successful reply from the origin that was paid may set the ledger reference.
      const receipt = rejected ? undefined : adapter.parseReceipt(second);
      this.ledger.settle(entryId, rejected ? 'unconfirmed' : 'paid', receipt?.reference);
      if (rejected) return { status: 'rejected', response: second, quote };
      return { status: 'paid', response: second, quote, usdMicros, ...(receipt ? { receipt } : {}) };
    } catch (error) {
      this.ledger.settle(entryId, 'unconfirmed'); // sent but outcome unknown
      throw error;
    }
  }

  /**
   * Redirects are never followed: the policy and the signature are bound to the exact
   * URL the caller asked for, and following one could leak payment headers elsewhere.
   */
  private send(url: string, init: HubRequest): Promise<Response> {
    return this.doFetch(url, {
      method: init.method ?? 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(init.headers ? { headers: { ...init.headers } } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
  }

  /** x402 is EIP-3009: only offers whose EIP-712 domain is pinned in the registry can be signed. */
  private signable(quote: Quote): boolean {
    if (quote.protocol !== 'x402') return true;
    return this.assets.get(assetKey(quote.amount.network, quote.amount.asset))?.eip712 !== undefined;
  }

  private adapterFor(quote: Quote): ProtocolAdapter {
    const adapter = this.adapters.find((a) => a.id === quote.protocol);
    if (!adapter) throw new Error(`no adapter for ${quote.protocol}`);
    return adapter;
  }

  /** Cheapest payable quote; ties broken by policy.preference. */
  private choose(reports: readonly QuoteReport[]): QuoteReport | undefined {
    const rank = (r: QuoteReport): number => {
      const i = this.policy.preference.indexOf(r.quote.protocol);
      return i === -1 ? this.policy.preference.length : i;
    };
    return reports
      .filter((r) => r.canPay && r.verdict.ok)
      .sort((a, b) => {
        const pa = a.verdict.ok ? a.verdict.usdMicros : 0n;
        const pb = b.verdict.ok ? b.verdict.usdMicros : 0n;
        return pa === pb ? rank(a) - rank(b) : pa < pb ? -1 : 1;
      })[0];
  }
}
