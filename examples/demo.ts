import { generatePrivateKey } from 'viem/accounts';
import {
  DEFAULT_ASSETS, PaymentHub, assetKey, evmX402Signer, formatUsd, mockMppSigner, withAssets,
} from '../src/index.js';
import { MOCK_MPP_CURRENCY, MOCK_MPP_NETWORK, startMockMerchant } from '../src/testing/mock-merchant.js';

const merchant = await startMockMerchant();
const hub = new PaymentHub({
  wallet: { x402: evmX402Signer(generatePrivateKey()), mpp: mockMppSigner() },
  assets: withAssets(DEFAULT_ASSETS, [[assetKey(MOCK_MPP_NETWORK, MOCK_MPP_CURRENCY), { symbol: 'MOCK', decimals: 6 }]]),
});

for (const path of ['/free', '/x402/weather', '/mpp/search', '/both/data', '/expensive']) {
  const result = await hub.request(`${merchant.url}${path}`);
  const detail =
    result.status === 'paid' ? `via ${result.quote.protocol} for ${formatUsd(result.usdMicros)}`
    : result.status === 'blocked' ? result.quotes.map((q) => q.verdict.ok ? 'ok' : q.verdict.reason).join('; ')
    : '';
  console.log(`${path.padEnd(14)} -> ${result.status.padEnd(8)} ${detail}`);
}
console.log(`\nspent today: ${formatUsd(hub.ledger.spentToday())}`);
await merchant.close();
