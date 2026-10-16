import { createServer } from 'node:http';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { viemChain, viemSubmitter } from '@zold/accept';
import { openSqlite } from '@zold/accept/sqlite';
import { parseEnv } from './env.js';
import { errorLine } from './log.js';
import { MerchantStore } from './merchants.js';
import { waitForIdleRelay } from './relay.js';
import { SETTLE_ROUTE, hostedService } from './service.js';

/** Circle USDC on Base Sepolia (EIP-712 name "USDC", version "2"). Base Sepolia only: no real funds. */
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const MAX_GAS = 150_000n;
/** 1 gwei: Base Sepolia usually asks about a thousandth of that. */
const MAX_FEE_PER_GAS = 1_000_000_000n;
const RECONCILE_EVERY_MS = 60_000;
/** Base Sepolia mines every 2 s: transactions at market price clear well within this. */
const RELAY_IDLE_TIMEOUT_MS = 120_000;

process.umask(0o077); // the database file holds payers' addresses: not world-readable
const env = parseEnv(process.env);
const log = (error: unknown): void => console.error(errorLine(error));
const db = openSqlite(env.dbPath);
const merchants = new MerchantStore(db);
const transport = http(env.rpcUrl);
const client = createPublicClient({ chain: baseSepolia, transport });
const relay = privateKeyToAccount(env.relayKey);
const wallet = createWalletClient({ account: relay, chain: baseSepolia, transport });
const service = hostedService({
  db, merchants, chainId: baseSepolia.id, asset: USDC, limits: env.limits, trustedProxyHops: env.trustedProxyHops, onError: log,
  chain: viemChain({ client, chainId: baseSepolia.id }),
  submitter: viemSubmitter({
    wallet, client, chainId: baseSepolia.id, asset: USDC, payTo: (to) => merchants.isPayee(to), maxGas: MAX_GAS, maxFeePerGas: MAX_FEE_PER_GAS,
  }),
});

try {
  await waitForIdleRelay(client, relay.address, { timeoutMs: RELAY_IDLE_TIMEOUT_MS, pollMs: 2_000 });
} catch (error) {
  log(error);
  process.exit(1);
}
const server = createServer(service.listener);
server.listen(env.port, env.host, () => {
  console.log(JSON.stringify({ level: 'info', message: `POST ${SETTLE_ROUTE} on ${env.host}:${env.port}, Base Sepolia` }));
});

let reconciling = false;
const timer = setInterval(() => {
  if (reconciling) return; // a slow tick never stacks
  reconciling = true;
  service.reconcile().catch(log).finally(() => { reconciling = false; });
}, RECONCILE_EVERY_MS);

process.on('SIGTERM', () => {
  clearInterval(timer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
