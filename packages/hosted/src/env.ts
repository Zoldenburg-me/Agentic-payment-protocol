import { AcceptError, AcceptErrorCode as E } from '@zold/accept';
import type { HostedLimits } from './service.js';

export interface HubEnv {
  readonly dbPath: string;
  readonly rpcUrl: string;
  /** The gas-only relay key: it holds Base Sepolia ETH for gas and nothing else. */
  readonly relayKey: `0x${string}`;
  readonly host: string;
  readonly port: number;
  readonly trustedProxyHops: number;
  /** Years payment records are kept after the end of their calendar year: at least the 10 of § 147 AO, since deletion is final. */
  readonly retentionYears: number;
  readonly limits: HostedLimits;
}

const RELAY_KEY = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^\d{1,15}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Names the variable, never its value: values may be secrets. */
const fail = (name: string): never => {
  throw new AcceptError(E.CONFIG_INVALID, `${name} is missing or invalid`);
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  return value === undefined || value.trim() === '' ? fail(name) : value;
}

/** `fallback` undefined: the variable is required. */
function int(env: NodeJS.ProcessEnv, name: string, fallback: number | undefined, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback ?? fail(name);
  const value = UINT.test(raw) ? Number(raw) : NaN;
  return value >= min && value <= max ? value : fail(name);
}

function rpcUrl(env: NodeJS.ProcessEnv): string {
  let url: URL;
  try {
    url = new URL(required(env, 'HUB_RPC_URL'));
  } catch {
    return fail('HUB_RPC_URL');
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
  return secure ? url.href : fail('HUB_RPC_URL');
}

/** Strict, fail closed: a missing or malformed variable stops startup. */
export function parseEnv(env: NodeJS.ProcessEnv): HubEnv {
  const relayKey = required(env, 'HUB_RELAY_KEY');
  if (!RELAY_KEY.test(relayKey)) fail('HUB_RELAY_KEY');
  const minAmount = env.HUB_MIN_AMOUNT ?? '1000'; // $0.001
  if (!UINT.test(minAmount) || BigInt(minAmount) < 1n) fail('HUB_MIN_AMOUNT');
  return {
    dbPath: required(env, 'HUB_DB_PATH'),
    rpcUrl: rpcUrl(env),
    relayKey: relayKey as `0x${string}`,
    host: env.HUB_HOST ?? '127.0.0.1',
    port: int(env, 'HUB_PORT', 8787, 1, 65_535),
    // Required: 0 behind a proxy puts every seller on the proxy's IP, so one bad key locks them all out.
    trustedProxyHops: int(env, 'HUB_TRUSTED_PROXY_HOPS', undefined, 0, 10),
    retentionYears: int(env, 'HUB_RETENTION_YEARS', 10, 10, 100),
    limits: {
      minAmount: BigInt(minAmount),
      perMinute: int(env, 'HUB_PER_MINUTE', 600, 1, 1_000_000),
      paidPerDay: int(env, 'HUB_PAID_PER_DAY', 2_000, 1, 10_000_000),
      paidPerDayTotal: int(env, 'HUB_PAID_PER_DAY_TOTAL', 20_000, 1, 100_000_000),
      failedKeysPerMinute: int(env, 'HUB_FAILED_KEYS_PER_MINUTE', 20, 1, 10_000),
    },
  };
}
