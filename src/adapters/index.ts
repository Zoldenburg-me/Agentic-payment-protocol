import type { ProtocolAdapter } from '../types.js';
import { mppAdapter } from './mpp.js';
import { x402Adapter } from './x402.js';

export { mppAdapter, x402Adapter };

export const DEFAULT_ADAPTERS: readonly ProtocolAdapter[] = [x402Adapter, mppAdapter];

/**
 * Protocols that are NOT HTTP-402 paywalls and so have no adapter yet. They are
 * checkout/authorization layers that need merchant or credential-provider onboarding.
 */
export const UNSUPPORTED_PROTOCOLS = [
  { id: 'acp', name: 'Agentic Commerce Protocol (OpenAI + Stripe)', why: 'merchant checkout API; needs a Shared Payment Token from a Stripe account' },
  { id: 'ap2', name: 'Agent Payments Protocol (Google)', why: 'signed-mandate authorization layer; needs a credentials provider' },
  { id: 'ucp', name: 'Universal Commerce Protocol (Google + Shopify)', why: 'shopping-journey protocol; payments delegated to AP2' },
  { id: 'visa-tap', name: 'Visa Trusted Agent Protocol', why: 'needs agent registration in the Visa directory' },
  { id: 'mastercard-agent-pay', name: 'Mastercard Agent Pay', why: 'needs Agentic Token enrolment with a card issuer' },
] as const;
