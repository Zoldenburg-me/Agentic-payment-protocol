import { ProtocolErrorCode } from 'agentpay-hub/protocol';

/** Every response the middleware refuses with carries exactly one of these codes. */
export const AcceptErrorCode = {
  ...ProtocolErrorCode,
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',
  BOTH_HEADERS: 'BOTH_HEADERS',
  RATE_LIMITED: 'RATE_LIMITED',
  PRICE_INVALID: 'PRICE_INVALID',
  PRICE_ERROR: 'PRICE_ERROR',
  PRICE_MISMATCH: 'PRICE_MISMATCH',
  IN_PROGRESS: 'IN_PROGRESS',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  SIMULATION_FAILED: 'SIMULATION_FAILED',
  AUTHORIZATION_USED: 'AUTHORIZATION_USED',
  SUBMIT_FAILED: 'SUBMIT_FAILED',
  TRANSFER_MISMATCH: 'TRANSFER_MISMATCH',
  SETTLEMENT_TIMEOUT: 'SETTLEMENT_TIMEOUT',
  LEDGER_TRANSITION: 'LEDGER_TRANSITION',
  INTERNAL: 'INTERNAL',
  BUSY: 'BUSY',
  SETTLEMENT_UNKNOWN: 'SETTLEMENT_UNKNOWN',
  /** Reported only (never a response code): the payment was accepted, then the seller's delivery threw. */
  DELIVERY_FAILED: 'DELIVERY_FAILED',
} as const;

export type AcceptErrorCode = (typeof AcceptErrorCode)[keyof typeof AcceptErrorCode];

/** Thrown for bad config or broken invariants. Messages never contain option values or secrets. */
export class AcceptError extends Error {
  readonly code: AcceptErrorCode;

  constructor(code: AcceptErrorCode, message: string = code, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'AcceptError';
    this.code = code;
  }
}

const E = AcceptErrorCode;
const STATUS: Readonly<Partial<Record<AcceptErrorCode, number>>> = {
  [E.MALFORMED]: 400, [E.X402_MALFORMED]: 400, [E.X402_V1_UNSUPPORTED]: 400, [E.MPP_MALFORMED]: 400,
  [E.BOTH_HEADERS]: 400, [E.PRICE_INVALID]: 400, [E.PRICE_MISMATCH]: 400,
  [E.NONCE_REPLAY]: 409, [E.IN_PROGRESS]: 409,
  [E.RATE_LIMITED]: 429,
  [E.PRICE_ERROR]: 500, [E.CONFIG_INVALID]: 500, [E.LEDGER_TRANSITION]: 500, [E.INTERNAL]: 500, [E.DELIVERY_FAILED]: 500,
  [E.ASSET_DOMAIN_UNPINNED]: 500, [E.DOMAIN_MISMATCH]: 500,
  [E.SUBMIT_FAILED]: 502, [E.TRANSFER_MISMATCH]: 502,
  [E.RPC_UNAVAILABLE]: 503, [E.SETTLEMENT_TIMEOUT]: 503, [E.STORE_FULL]: 503, [E.BUSY]: 503, [E.SETTLEMENT_UNKNOWN]: 503,
};

/** The HTTP status for a refusal. Anything not listed is a payment the seller did not accept: 402. */
export const statusFor = (code: AcceptErrorCode): number => STATUS[code] ?? 402;
