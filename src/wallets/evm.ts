import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import type { X402Requirements, X402Signer } from '../types.js';

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const CLOCK_SKEW_SECONDS = 600;
const MAX_VALIDITY_SECONDS = 300;

/** Defence in depth: never sign an authorization that outlives a few minutes. */
function clampTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('x402 maxTimeoutSeconds must be a positive integer');
  }
  return Math.min(value, MAX_VALIDITY_SECONDS);
}

export function eip3009Domain(req: X402Requirements) {
  const { name, version } = req.extra ?? {};
  const chainId = Number(req.network.split(':')[1]);
  if (typeof name !== 'string' || typeof version !== 'string' || !Number.isInteger(chainId)) {
    throw new Error('x402 requirements are missing extra.name/extra.version or an eip155 network');
  }
  return { name, version, chainId, verifyingContract: req.asset as `0x${string}` };
}

/**
 * Signs x402 `exact` payments on EVM chains as an EIP-3009 TransferWithAuthorization.
 * Funds only move when the server's facilitator submits this authorization on-chain.
 */
export function evmX402Signer(privateKey: `0x${string}`, now: () => number = () => Date.now()): X402Signer {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    async signX402(req) {
      const nowSec = Math.floor(now() / 1000);
      const authorization = {
        from: account.address,
        to: req.payTo as `0x${string}`,
        value: BigInt(req.amount),
        validAfter: BigInt(nowSec - CLOCK_SKEW_SECONDS),
        validBefore: BigInt(nowSec) + BigInt(clampTimeout(req.maxTimeoutSeconds)),
        nonce: `0x${randomBytes(32).toString('hex')}` as `0x${string}`,
      };
      const signature = await account.signTypedData({
        domain: eip3009Domain(req),
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: authorization,
      });
      return {
        payload: {
          signature,
          authorization: {
            from: authorization.from,
            to: authorization.to,
            value: authorization.value.toString(),
            validAfter: authorization.validAfter.toString(),
            validBefore: authorization.validBefore.toString(),
            nonce: authorization.nonce,
          },
        },
      };
    },
  };
}
