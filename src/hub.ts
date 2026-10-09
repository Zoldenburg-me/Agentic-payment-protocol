import { type AssetRegistry, DEFAULT_ASSETS } from './assets.js';
import { DEFAULT_ADAPTERS } from './adapters/index.js';
import { Ledger } from './ledger.js';
import { DEFAULT_POLICY, type Policy, type Verdict, evaluate } from './policy.js';
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
  | { readonly status: 'unsupported'; readonly response: Response }
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

    // A malformed offer from one protocol must not break the others.
    const quotes = (
      await Promise.all(this.adapters.map((a) => a.parseQuotes(first, url).catch(() => [] as const)))
    ).flat();
    if (quotes.length === 0) return { status: 'unsupported', response: first };

    const spent = this.ledger.spentToday();
    const reports = quotes.map<QuoteReport>((quote) => ({
      quote,
      verdict: evaluate(quote, this.policy, this.assets, spent),
      canPay: this.adapterFor(quote).canPay(this.wallet),
    }));
    if (mode === 'quote') return { status: 'quoted', quotes: reports };

    const choice = this.choose(reports);
    if (!choice || !choice.verdict.ok) return { status: 'blocked', quotes: reports };

    // Reserve synchronously with the policy check so concurrent calls cannot overspend.
    const entryId = this.ledger.reserve(url, choice.quote.protocol, choice.verdict.usdMicros);
    const adapter = this.adapterFor(choice.quote);

    let payHeaders: Readonly<Record<string, string>>;
    try {
      payHeaders = await adapter.authorize(choice.quote, this.wallet);
    } catch (error) {
      // Nothing was signed or sent, so nothing can be spent.
      this.ledger.settle(entryId, 'released');
      throw error;
    }

    try {
      const second = await this.send(url, { ...init, headers: mergeHeaders(init.headers, payHeaders) });
      const receipt = adapter.parseReceipt(second);
      // Even a 402 reply keeps the amount counted: the server holds a valid signed
      // authorization and could still settle it, so only the day rollover frees it.
      this.ledger.settle(entryId, second.ok ? 'paid' : 'unconfirmed', receipt?.reference);
      if (second.status === 402) return { status: 'rejected', response: second, quote: choice.quote };
      return {
        status: 'paid', response: second, quote: choice.quote,
        usdMicros: choice.verdict.usdMicros, ...(receipt ? { receipt } : {}),
      };
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
