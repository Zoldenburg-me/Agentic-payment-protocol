import type {
  ProtocolAdapter, Quote, Receipt, Wallet, X402Requirements, X402Resource,
} from '../types.js';
import {
  X402_HEADERS, b64decode, decodePaymentRequired, encodePaymentSignature, isValidRequirements,
  type PaymentRequired,
} from '../protocol/x402-codec.js';

export { MAX_TIMEOUT_SECONDS } from '../protocol/x402-codec.js';

/** A receipt reference is a transaction hash or similar id; anything longer is not one. */
const MAX_REFERENCE_CHARS = 256;
const MAX_RESPONSE_HEADER_BYTES = 16 * 1024;

interface X402Raw {
  readonly resource: X402Resource;
  readonly requirements: X402Requirements;
}

/** x402 v2 over HTTP (Coinbase / x402 Foundation). Only the `exact` scheme is supported; v1 is refused. */
export const x402Adapter: ProtocolAdapter = {
  id: 'x402',

  async parseQuotes(res, url) {
    const header = res.headers.get(X402_HEADERS.required);
    if (!header) return [];
    let required: PaymentRequired;
    try {
      required = decodePaymentRequired(header);
    } catch {
      return [];
    }
    const resource = required.resource ?? { url };
    return required.accepts
      .filter(isValidRequirements)
      .map<Quote>((requirements) => ({
        protocol: 'x402',
        url,
        payee: requirements.payTo,
        amount: { atomic: BigInt(requirements.amount), asset: requirements.asset, network: requirements.network },
        ...(resource.description ? { description: resource.description } : {}),
        raw: { resource, requirements } satisfies X402Raw,
      }));
  },

  canPay: (wallet: Wallet) => wallet.x402 !== undefined,

  async authorize(quote, wallet) {
    if (!wallet.x402) throw new Error('wallet has no x402 signer');
    const { resource, requirements } = quote.raw as X402Raw;
    const { payload } = await wallet.x402.signX402(requirements, resource);
    return { [X402_HEADERS.signature]: encodePaymentSignature({ x402Version: 2, resource, accepted: requirements, payload }) };
  },

  parseReceipt(res): Receipt | undefined {
    const header = res.headers.get(X402_HEADERS.response);
    if (!header) return undefined;
    if (Buffer.byteLength(header) > MAX_RESPONSE_HEADER_BYTES) return { protocol: 'x402', raw: '[oversized]' };
    try {
      const raw = b64decode<unknown>(header);
      const tx = typeof raw === 'object' && raw !== null ? (raw as { transaction?: unknown }).transaction : undefined;
      const reference = typeof tx === 'string' && tx.length > 0 && tx.length <= MAX_REFERENCE_CHARS ? tx : undefined;
      return { protocol: 'x402', ...(reference ? { reference } : {}), raw };
    } catch {
      return { protocol: 'x402', raw: header };
    }
  },
};
