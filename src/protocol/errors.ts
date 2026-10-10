/** Every refusal in the protocol layer has exactly one of these codes. Tests assert one code each. */
export const ProtocolErrorCode = {
  X402_V1_UNSUPPORTED: 'X402_V1_UNSUPPORTED',
  X402_MALFORMED: 'X402_MALFORMED',
  MPP_MALFORMED: 'MPP_MALFORMED',
  MALFORMED: 'MALFORMED',
  CONFIG_INVALID: 'CONFIG_INVALID',
  CHAIN_MISMATCH: 'CHAIN_MISMATCH',
  ASSET_MISMATCH: 'ASSET_MISMATCH',
  PAYTO_MISMATCH: 'PAYTO_MISMATCH',
  UNDERPAID: 'UNDERPAID',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  NOT_YET_VALID: 'NOT_YET_VALID',
  EXPIRED: 'EXPIRED',
  WINDOW_TOO_LONG: 'WINDOW_TOO_LONG',
  HIGH_S: 'HIGH_S',
  BAD_SIGNATURE: 'BAD_SIGNATURE',
  PAYER_NO_CODE: 'PAYER_NO_CODE',
  RPC_UNAVAILABLE: 'RPC_UNAVAILABLE',
  DOMAIN_MISMATCH: 'DOMAIN_MISMATCH',
  ASSET_DOMAIN_UNPINNED: 'ASSET_DOMAIN_UNPINNED',
  CHALLENGE_MALFORMED: 'CHALLENGE_MALFORMED',
  CHALLENGE_TAMPERED: 'CHALLENGE_TAMPERED',
  CHALLENGE_EXPIRED: 'CHALLENGE_EXPIRED',
  CHALLENGE_UNKNOWN_KEY: 'CHALLENGE_UNKNOWN_KEY',
  NONCE_REPLAY: 'NONCE_REPLAY',
  NONCE_MISMATCH: 'NONCE_MISMATCH',
  EXPIRES_TOO_SOON: 'EXPIRES_TOO_SOON',
  PAYER_DELEGATED: 'PAYER_DELEGATED',
  STORE_FULL: 'STORE_FULL',
} as const;

export type ProtocolErrorCode = (typeof ProtocolErrorCode)[keyof typeof ProtocolErrorCode];

/** Thrown for malformed input or bad config. The message never contains secrets or raw payloads. */
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string = code) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export type Refusal = { readonly ok: false; readonly code: ProtocolErrorCode };
export const refuse = (code: ProtocolErrorCode): Refusal => ({ ok: false, code });
