import type { MppChallenge, ProtocolAdapter, Quote, Receipt, Wallet } from '../types.js';

const RECEIPT = 'Payment-Receipt';

const b64urlDecode = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');
const b64urlEncode = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

/** Split a WWW-Authenticate value into the `Payment ...` challenges it contains. */
function paymentSegments(header: string): string[] {
  return header
    .split(/(?:^|,\s*)(?=Payment\s+[a-z]+=)/i)
    .map((s) => s.trim())
    .filter((s) => /^payment\s/i.test(s));
}

function parseParams(segment: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const m of segment.matchAll(/([A-Za-z][\w-]*)="([^"]*)"/g)) {
    if (m[1] && m[2] !== undefined) params[m[1]] = m[2];
  }
  return params;
}

function toChallenge(params: Record<string, string>): MppChallenge | undefined {
  const { id, method, intent, request } = params;
  if (!id || !method || !intent || !request) return undefined;
  try {
    return { params, id, method, intent, request: JSON.parse(b64urlDecode(request)) };
  } catch {
    return undefined;
  }
}

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
      const { amount, currency, recipient } = challenge.request as Record<string, unknown>;
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
    const credential = b64urlEncode(
      JSON.stringify({ challenge: challenge.params, payload, source: wallet.mpp.source }),
    );
    // The server may only pick between the two documented carriers, never an arbitrary header.
    const requested = challenge.params.header;
    const headerName = requested === 'Payment-Authorization' ? requested : 'Authorization';
    return { [headerName]: `Payment ${credential}` };
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
