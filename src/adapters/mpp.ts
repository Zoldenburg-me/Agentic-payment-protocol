import type { MppChallenge, ProtocolAdapter, Quote, Receipt, Wallet } from '../types.js';
import {
  b64urlDecode, encodeCredential, parseParams, paymentSegments, toChallenge,
} from '../protocol/mpp-codec.js';

const RECEIPT = 'Payment-Receipt';

/**
 * Machine Payments Protocol (Stripe + Tempo) over HTTP. Supports the `charge` intent;
 * `session` and `subscription` need stateful channels and are skipped.
 */
export const mppAdapter: ProtocolAdapter = {
  id: 'mpp',

  async parseQuotes(res, url) {
    const header = res.headers.get('www-authenticate');
    if (!header) return [];
    const quotes: Quote[] = [];
    for (const segment of paymentSegments(header)) {
      const challenge = toChallenge(parseParams(segment));
      if (!challenge || challenge.intent !== 'charge') continue;
      // A non-object request (e.g. `null`) must skip this challenge, not abort the siblings.
      const request: unknown = challenge.request;
      if (typeof request !== 'object' || request === null || Array.isArray(request)) continue;
      const { amount, currency, recipient } = request as Record<string, unknown>;
      if (typeof amount !== 'string' || !/^\d+$/.test(amount)) continue;
      if (typeof currency !== 'string' || typeof recipient !== 'string') continue;
      quotes.push({
        protocol: 'mpp',
        url,
        payee: recipient,
        amount: { atomic: BigInt(amount), asset: currency, network: `mpp:${challenge.method}` },
        ...(challenge.params.description ? { description: challenge.params.description } : {}),
        raw: challenge,
      });
    }
    return quotes;
  },

  canPay: (wallet: Wallet) => wallet.mpp !== undefined,

  async authorize(quote, wallet) {
    if (!wallet.mpp) throw new Error('wallet has no mpp signer');
    const challenge = quote.raw as MppChallenge;
    const { payload } = await wallet.mpp.payMpp(challenge);
    const credential = encodeCredential({ challenge: challenge.params, payload, source: wallet.mpp.source });
    // The server may only pick between the two documented carriers, never an arbitrary header.
    const requested = challenge.params.header;
    const headerName = requested === 'Payment-Authorization' ? requested : 'Authorization';
    return { [headerName]: credential };
  },

  parseReceipt(res): Receipt | undefined {
    const header = res.headers.get(RECEIPT);
    if (!header) return undefined;
    try {
      const raw = JSON.parse(b64urlDecode(header)) as { reference?: string };
      return { protocol: 'mpp', ...(raw.reference ? { reference: raw.reference } : {}), raw };
    } catch {
      return { protocol: 'mpp', raw: header };
    }
  },
};
