import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { type AssetRegistry, DEFAULT_ASSETS, assetKey } from '../assets.js';
import { TRANSFER_WITH_AUTHORIZATION_TYPES } from '../protocol/eip3009-types.js';
import { ProtocolError, ProtocolErrorCode as E } from '../protocol/errors.js';
import type { X402Requirements, X402Signer } from '../types.js';

export { TRANSFER_WITH_AUTHORIZATION_TYPES };

const CLOCK_SKEW_SECONDS = 600;
const MAX_VALIDITY_SECONDS = 300;

/** Defence in depth: never sign an authorization that outlives a few minutes. */
function clampTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('x402 maxTimeoutSeconds must be a positive integer');
  }
  return Math.min(value, MAX_VALIDITY_SECONDS);
}

/**
 * The EIP-712 domain comes from the pinned asset registry, never from the seller's `extra`:
 * a seller who could choose the domain could make the agent sign for another token or chain.
 */
export function eip3009Domain(req: X402Requirements, assets: AssetRegistry = DEFAULT_ASSETS) {
  const chainId = Number(req.network.split(':')[1]);
  const pinned = assets.get(assetKey(req.network, req.asset))?.eip712;
  if (!pinned || !Number.isInteger(chainId)) {
    throw new ProtocolError(E.ASSET_DOMAIN_UNPINNED, `no pinned EIP-712 domain for ${req.asset} on ${req.network}`);
  }
  return { name: pinned.name, version: pinned.version, chainId, verifyingContract: req.asset as `0x${string}` };
}

/**
 * Signs x402 `exact` payments on EVM chains as an EIP-3009 TransferWithAuthorization.
 * Funds only move when the seller submits this authorization on-chain.
 */
export function evmX402Signer(
  privateKey: `0x${string}`,
  now: () => number = () => Date.now(),
  assets: AssetRegistry = DEFAULT_ASSETS,
): X402Signer {
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
        domain: eip3009Domain(req, assets),
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
