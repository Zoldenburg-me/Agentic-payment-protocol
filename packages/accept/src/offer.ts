import { b64encode } from 'agentpay-hub/protocol';
import type { AcceptConfig } from './config.js';

/** The x402 v2 PAYMENT-REQUIRED header for one priced request. Domain name/version are the pinned ones. */
export function offerHeader(config: AcceptConfig, path: string, amount: bigint): string {
  return b64encode({
    x402Version: 2,
    resource: { url: `${config.publicOrigin ?? ''}${path}` },
    accepts: [{
      scheme: 'exact', network: config.network, amount: amount.toString(), asset: config.asset, payTo: config.payTo,
      maxTimeoutSeconds: config.maxTimeoutSeconds, extra: { name: config.domain.name, version: config.domain.version },
    }],
  });
}

/** The x402 v2 PAYMENT-RESPONSE header: the settlement transaction, for the buyer's records. */
export function paymentResponseHeader(config: AcceptConfig, txHash: string | undefined, payer: string): string {
  return b64encode({ success: true, transaction: txHash, network: config.network, payer });
}
