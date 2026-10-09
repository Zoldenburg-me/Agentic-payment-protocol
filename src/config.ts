import { DEFAULT_POLICY, type Policy } from './policy.js';
import { Ledger } from './ledger.js';
import { PaymentHub } from './hub.js';
import { evmX402Signer } from './wallets/evm.js';
import type { ProtocolId, Wallet } from './types.js';

const PROTOCOL_IDS: readonly ProtocolId[] = ['x402', 'mpp'];

const usdToMicros = (name: string, value: string): bigint => {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) throw new Error(`${name} must be a USD amount like 0.25, got "${value}"`);
  const [whole = '0', frac = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
};

const list = (value: string | undefined): string[] =>
  (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Build a hub from environment variables:
 *   AGENTPAY_EVM_PRIVATE_KEY   0x… key for x402 (omit for quote-only mode)
 *   AGENTPAY_MAX_PER_TX_USD    default 0.10
 *   AGENTPAY_DAILY_USD         default 1.00
 *   AGENTPAY_ALLOWED_HOSTS     comma list, e.g. api.example.com,data.example.org:8443
 *   AGENTPAY_ALLOWED_PROTOCOLS comma list of x402,mpp
 *   AGENTPAY_LEDGER            JSONL path so the daily budget survives restarts
 */
export function hubFromEnv(env: NodeJS.ProcessEnv = process.env): PaymentHub {
  const key = env.AGENTPAY_EVM_PRIVATE_KEY;
  if (key !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('AGENTPAY_EVM_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string');
  }
  const wallet: Wallet = key ? { x402: evmX402Signer(key as `0x${string}`) } : {};

  const protocols = list(env.AGENTPAY_ALLOWED_PROTOCOLS);
  const unknown = protocols.filter((p) => !(PROTOCOL_IDS as readonly string[]).includes(p));
  if (unknown.length > 0) throw new Error(`unknown protocol(s) in AGENTPAY_ALLOWED_PROTOCOLS: ${unknown.join(', ')}`);

  const policy: Policy = {
    ...DEFAULT_POLICY,
    maxPerTxUsdMicros: env.AGENTPAY_MAX_PER_TX_USD
      ? usdToMicros('AGENTPAY_MAX_PER_TX_USD', env.AGENTPAY_MAX_PER_TX_USD)
      : DEFAULT_POLICY.maxPerTxUsdMicros,
    dailyBudgetUsdMicros: env.AGENTPAY_DAILY_USD
      ? usdToMicros('AGENTPAY_DAILY_USD', env.AGENTPAY_DAILY_USD)
      : DEFAULT_POLICY.dailyBudgetUsdMicros,
    allowedHosts: list(env.AGENTPAY_ALLOWED_HOSTS),
    allowedProtocols: protocols as ProtocolId[],
  };
  return new PaymentHub({ wallet, policy, ledger: new Ledger(env.AGENTPAY_LEDGER) });
}
