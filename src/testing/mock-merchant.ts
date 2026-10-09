import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { recoverTypedDataAddress } from 'viem';
import { TRANSFER_WITH_AUTHORIZATION_TYPES, eip3009Domain } from '../wallets/evm.js';
import type { X402Requirements } from '../types.js';

/** USDC on Base Sepolia (a testnet token) and a fake MPP currency used only in tests. */
export const MOCK_X402 = {
  network: 'eip155:84532',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: '0x000000000000000000000000000000000000dEaD',
} as const;
export const MOCK_MPP_CURRENCY = '0x20c0000000000000000000000000000000000001';
export const MOCK_MPP_NETWORK = 'mpp:tempo';

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64');
const b64url = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');

interface Prices {
  readonly x402?: string;
  readonly mpp?: string;
}

const ROUTES: Readonly<Record<string, Prices>> = {
  '/x402/weather': { x402: '10000' },
  '/mpp/search': { mpp: '10000' },
  '/both/data': { x402: '20000', mpp: '10000' },
  '/expensive': { x402: '5000000' },
};

export interface MockMerchant {
  readonly url: string;
  readonly host: string;
  readonly settled: readonly string[];
  close(): Promise<void>;
}

/**
 * A pretend paywalled server. It verifies x402 signatures (real EIP-712 recovery) and
 * MPP credentials (challenge id echo) but settles nothing on-chain.
 */
export async function startMockMerchant(): Promise<MockMerchant> {
  const issuedMppIds = new Set<string>();
  const settled: string[] = [];
  let base = '';

  const x402Requirements = (amount: string): X402Requirements => ({
    scheme: 'exact', ...MOCK_X402, amount, maxTimeoutSeconds: 60,
    extra: { name: 'USDC', version: '2' },
  });

  const challengeHeader = (amount: string): string => {
    const id = randomBytes(12).toString('base64url');
    issuedMppIds.add(id);
    const request = b64url({ amount, currency: MOCK_MPP_CURRENCY, recipient: MOCK_X402.payTo });
    return `Payment id="${id}", realm="mock", method="tempo", intent="charge", request="${request}", header="Payment-Authorization"`;
  };

  async function verifyX402(header: string, prices: Prices): Promise<string | undefined> {
    const payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
      accepted: X402Requirements;
      payload: { signature: `0x${string}`; authorization: Record<string, string> };
    };
    const want = x402Requirements(prices.x402 ?? '');
    const a = payload.payload.authorization;
    if (payload.accepted.amount !== want.amount || a.to?.toLowerCase() !== want.payTo.toLowerCase()) return undefined;
    if (a.value !== want.amount) return undefined;
    const signer = await recoverTypedDataAddress({
      domain: eip3009Domain(want),
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: a.from as `0x${string}`, to: a.to as `0x${string}`, value: BigInt(a.value ?? '0'),
        validAfter: BigInt(a.validAfter ?? '0'), validBefore: BigInt(a.validBefore ?? '0'),
        nonce: a.nonce as `0x${string}`,
      },
      signature: payload.payload.signature,
    });
    return signer.toLowerCase() === a.from?.toLowerCase() ? a.from : undefined;
  }

  function verifyMpp(header: string): string | undefined {
    const m = /^Payment\s+(\S+)$/.exec(header);
    if (!m?.[1]) return undefined;
    const cred = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) as {
      challenge: { id: string }; payload: { hash: string };
    };
    return issuedMppIds.delete(cred.challenge.id) ? cred.payload.hash : undefined;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', base).pathname;
    if (path === '/free') return void res.writeHead(200).end('free content');
    const prices = ROUTES[path];
    if (!prices) return void res.writeHead(404).end('not found');

    const x402Sig = req.headers['payment-signature'];
    if (typeof x402Sig === 'string' && prices.x402) {
      const payer = await verifyX402(x402Sig, prices).catch(() => undefined);
      if (payer) {
        settled.push(`x402:${payer}`);
        const receipt = b64({ success: true, transaction: '0xmocktx', network: MOCK_X402.network, payer });
        return void res.writeHead(200, { 'PAYMENT-RESPONSE': receipt }).end(`paid content via x402 (${path})`);
      }
    }
    const mppAuth = req.headers['payment-authorization'];
    if (typeof mppAuth === 'string' && prices.mpp) {
      const hash = verifyMpp(mppAuth);
      if (hash) {
        settled.push(`mpp:${hash}`);
        const receipt = b64url({ status: 'success', reference: hash });
        return void res.writeHead(200, { 'Payment-Receipt': receipt }).end(`paid content via mpp (${path})`);
      }
    }

    const headers: Record<string, string> = {};
    if (prices.x402) {
      headers['PAYMENT-REQUIRED'] = b64({
        x402Version: 2,
        resource: { url: `${base}${path}`, description: `mock resource ${path}` },
        accepts: [x402Requirements(prices.x402)],
      });
    }
    if (prices.mpp) headers['WWW-Authenticate'] = challengeHeader(prices.mpp);
    res.writeHead(402, headers).end('payment required');
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => res.writeHead(500).end('error'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;

  return {
    url: base,
    host: `127.0.0.1:${port}`,
    settled,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
