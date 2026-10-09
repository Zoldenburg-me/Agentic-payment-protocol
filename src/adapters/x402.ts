import type {
  ProtocolAdapter, Quote, Receipt, Wallet, X402Requirements, X402Resource,
} from '../types.js';

const REQUIRED = 'PAYMENT-REQUIRED';
const SIGNATURE = 'PAYMENT-SIGNATURE';
const RESPONSE = 'PAYMENT-RESPONSE';

interface PaymentRequired {
  x402Version: number;
  resource: X402Resource;
  accepts: X402Requirements[];
}

interface X402Raw {
  readonly resource: X402Resource;
  readonly requirements: X402Requirements;
}

/** Longest signature validity we will grant, however long the server asks for. */
export const MAX_TIMEOUT_SECONDS = 300;

function isValidRequirements(r: unknown): r is X402Requirements {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as Record<string, unknown>;
  return (
    o.scheme === 'exact' &&
    // The only signer we ship is EVM (EIP-3009); offers on other chains cannot be paid.
    typeof o.network === 'string' && o.network.startsWith('eip155:') &&
    typeof o.asset === 'string' &&
    typeof o.payTo === 'string' &&
    typeof o.amount === 'string' && /^\d+$/.test(o.amount) &&
    Number.isInteger(o.maxTimeoutSeconds) &&
    (o.maxTimeoutSeconds as number) >= 1 && (o.maxTimeoutSeconds as number) <= MAX_TIMEOUT_SECONDS
  );
}

const b64encode =(v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64');
const b64decode = <T>(s: string): T => JSON.parse(Buffer.from(s, 'base64').toString('utf8')) as T;

/** x402 v2 over HTTP (Coinbase / x402 Foundation). Only the `exact` scheme is supported. */
export const x402Adapter: ProtocolAdapter = {
  id: 'x402',

  async parseQuotes(res, url) {
    const header = res.headers.get(REQUIRED);
    if (!header) return [];
    let required: PaymentRequired;
    try {
      required = b64decode<PaymentRequired>(header);
    } catch {
      return [];
    }
    if (required.x402Version !== 2 || !Array.isArray(required.accepts)) return [];
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
    return { [SIGNATURE]: b64encode({ x402Version: 2, resource, accepted: requirements, payload }) };
  },

  parseReceipt(res): Receipt | undefined {
    const header = res.headers.get(RESPONSE);
    if (!header) return undefined;
    try {
      const raw = b64decode<{ transaction?: string }>(header);
      return { protocol: 'x402', ...(raw.transaction ? { reference: raw.transaction } : {}), raw };
    } catch {
      return { protocol: 'x402', raw: header };
    }
  },
};
