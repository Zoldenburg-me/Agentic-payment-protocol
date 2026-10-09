export type ProtocolId = 'x402' | 'mpp';

export interface Money {
  readonly atomic: bigint;
  readonly asset: string;
  /** CAIP-2 chain id for x402 (eip155:8453), `mpp:<method>` for MPP. */
  readonly network: string;
}

/** A protocol-neutral price quote parsed from a 402 response. */
export interface Quote {
  readonly protocol: ProtocolId;
  readonly url: string;
  readonly payee: string;
  readonly amount: Money;
  readonly description?: string;
  /** Protocol-specific data the adapter needs again in `authorize`. */
  readonly raw: unknown;
}

export interface Receipt {
  readonly protocol: ProtocolId;
  readonly reference?: string;
  readonly raw: unknown;
}

// ---- x402 ----------------------------------------------------------------

export interface X402Requirements {
  readonly scheme: string;
  readonly network: string;
  readonly amount: string;
  readonly asset: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface X402Resource {
  readonly url: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface X402Signer {
  readonly address: string;
  signX402(
    req: X402Requirements,
    resource: X402Resource,
  ): Promise<{ readonly payload: Record<string, unknown> }>;
}

// ---- MPP -----------------------------------------------------------------

export interface MppChallenge {
  /** Auth-params exactly as received (strings), echoed back in the credential. */
  readonly params: Readonly<Record<string, string>>;
  readonly id: string;
  readonly method: string;
  readonly intent: string;
  /** Decoded `request` (base64url JCS JSON). */
  readonly request: Readonly<Record<string, unknown>>;
}

export interface MppSigner {
  /** Payer identity, e.g. `did:pkh:eip155:4217:0x...`. */
  readonly source: string;
  payMpp(challenge: MppChallenge): Promise<{ readonly payload: Record<string, unknown> }>;
}

/** What the agent can pay with. A protocol is only usable if its signer is present. */
export interface Wallet {
  readonly x402?: X402Signer;
  readonly mpp?: MppSigner;
}

// ---- Adapter -------------------------------------------------------------

export interface ProtocolAdapter {
  readonly id: ProtocolId;
  /** Parse a 402 response into zero or more quotes. Must not consume the body. */
  parseQuotes(res: Response, url: string): Promise<readonly Quote[]>;
  canPay(wallet: Wallet): boolean;
  /** Build the request headers that carry payment for the retry. */
  authorize(quote: Quote, wallet: Wallet): Promise<Readonly<Record<string, string>>>;
  parseReceipt(res: Response): Receipt | undefined;
}
