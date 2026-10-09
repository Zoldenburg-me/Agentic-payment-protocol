import { hubFromEnv } from '../src/config.js';
import { formatUsd } from '../src/assets.js';
import { assertPublicHttps, readCapped } from '../src/net-guard.js';

const MAX_PRINT_CHARS = 2_000;
const USAGE = `usage: npm run pay -- <https-url> [--yes]

  Without --yes: asks the server for its price and prints every offer. Nothing is paid.
  With --yes:    pays the cheapest offer your policy allows. Requires AGENTPAY_ALLOWED_HOSTS and
                 AGENTPAY_EVM_PRIVATE_KEY (use a dedicated testnet key first).`;

const [url, flag] = process.argv.slice(2);
if (!url || (flag !== undefined && flag !== '--yes')) {
  console.error(USAGE);
  process.exit(2);
}

try {
  await assertPublicHttps(url);
  const hub = hubFromEnv();

  const quoted = await hub.request(url, {}, 'quote');
  if (quoted.status === 'free') {
    console.log(`No payment needed (HTTP ${quoted.response.status}).`);
    process.exit(0);
  }
  if (quoted.status === 'unsupported') {
    console.error('The server asked for payment, but not over x402 v2 or MPP charge.');
    process.exit(1);
  }
  if (quoted.status !== 'quoted') throw new Error(`unexpected status ${quoted.status}`);

  console.log(`Offers from ${url}:`);
  for (const { quote, verdict, canPay } of quoted.quotes) {
    const price = verdict.ok ? formatUsd(verdict.usdMicros) : `refused (${verdict.reason})`;
    console.log(`  ${quote.protocol.padEnd(5)} ${price}  network=${quote.amount.network}  payTo=${quote.payee}  walletCanPay=${canPay}`);
  }
  console.log(`Wallet can pay with: ${hub.payableProtocols().join(', ') || 'nothing (quote-only)'}`);

  if (flag !== '--yes') {
    console.log('\nDry run only. Re-run with --yes to pay.');
    process.exit(0);
  }
  if (hub.policy.allowedHosts.length === 0) {
    console.error('Refusing to pay: set AGENTPAY_ALLOWED_HOSTS to the host(s) you intend to pay.');
    process.exit(1);
  }

  const result = await hub.request(url, {}, 'pay');
  if (result.status !== 'paid') {
    console.error(`Not paid: ${result.status}`);
    process.exit(1);
  }
  const { text, truncated } = await readCapped(result.response, MAX_PRINT_CHARS);
  console.log(`\nPaid ${formatUsd(result.usdMicros)} via ${result.quote.protocol}. HTTP ${result.response.status}.`);
  console.log(`Receipt: ${result.receipt?.reference ?? '(none returned)'}`);
  console.log(`Spent today: ${formatUsd(hub.ledger.spentToday())}`);
  console.log(`\n${text}${truncated ? '\n[truncated]' : ''}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
