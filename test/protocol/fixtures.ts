import { type Hex, parseSignature, serializeSignature } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { TRANSFER_WITH_AUTHORIZATION_TYPES } from '../../src/wallets/evm.js';
import type { Eip3009Rpc, Eip712Domain, PinnedOffer } from '../../src/protocol/verify-eip3009.js';

export const USDC_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
export const PAY_TO = '0x000000000000000000000000000000000000dEaD' as const;
export const NOW = 1_800_000_000;

export const DOMAIN: Eip712Domain = { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC_SEPOLIA };

export const pinned = (over: Partial<PinnedOffer> = {}): PinnedOffer => ({
  chainId: 84532, asset: USDC_SEPOLIA, domain: DOMAIN, payTo: PAY_TO, amount: 10_000n, maxWindowS: 300, ...over,
});

export interface AuthFields {
  readonly from?: string;
  readonly to?: string;
  readonly value?: bigint;
  readonly validAfter?: bigint;
  readonly validBefore?: bigint;
  readonly nonce?: Hex;
}

/** Signs a TransferWithAuthorization with a fresh key and returns a claim as a seller would receive it. */
export async function signedClaim(fields: AuthFields = {}, domain: Eip712Domain = DOMAIN) {
  const account = privateKeyToAccount(generatePrivateKey());
  const message = {
    from: (fields.from ?? account.address) as Hex,
    to: (fields.to ?? PAY_TO) as Hex,
    value: fields.value ?? 10_000n,
    validAfter: fields.validAfter ?? BigInt(NOW - 600),
    validBefore: fields.validBefore ?? BigInt(NOW + 60),
    nonce: fields.nonce ?? (`0x${'11'.repeat(32)}` as Hex),
  };
  const signature = await account.signTypedData({
    domain: { ...domain, verifyingContract: domain.verifyingContract as Hex },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message,
  });
  return {
    account,
    claim: {
      chainId: 84532,
      asset: USDC_SEPOLIA as string,
      signature: signature as string,
      authorization: {
        from: message.from as string, to: message.to as string, value: message.value.toString(),
        validAfter: message.validAfter.toString(), validBefore: message.validBefore.toString(),
        nonce: message.nonce as string,
      },
    },
  };
}

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** The malleable twin of a valid signature: same signer, s' = n - s, flipped parity. */
export function toHighS(signature: Hex): Hex {
  const sig = parseSignature(signature);
  const s = SECP256K1_N - BigInt(sig.s);
  return serializeSignature({
    r: sig.r, s: `0x${s.toString(16).padStart(64, '0')}`, yParity: sig.yParity === 0 ? 1 : 0,
  });
}

export interface FakeRpc extends Eip3009Rpc {
  readonly calls: Array<{ to: string; data: string; gas?: bigint; from?: string }>;
  readonly codeLookups: string[];
}

export function fakeRpc(opts: {
  code?: Record<string, Hex>;
  call?: (req: { to: string; data: string; gas?: bigint; from?: string }) => Promise<Hex>;
  failGetCode?: boolean;
} = {}): FakeRpc {
  const calls: FakeRpc['calls'] = [];
  const codeLookups: string[] = [];
  return {
    calls,
    codeLookups,
    async getCode(address) {
      codeLookups.push(address);
      if (opts.failGetCode) throw new Error('rpc down');
      return opts.code?.[address.toLowerCase()] ?? '0x';
    },
    async call(req) {
      calls.push(req);
      if (!opts.call) throw new Error('unexpected eth_call');
      return opts.call(req);
    },
  };
}
