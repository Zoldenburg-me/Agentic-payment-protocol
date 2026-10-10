import {
  BaseError, ExecutionRevertedError, type Hex, decodeFunctionResult, domainSeparator, encodeFunctionData, getAddress, hashTypedData,
  parseAbi, recoverAddress,
} from 'viem';
import { TRANSFER_WITH_AUTHORIZATION_TYPES } from './eip3009-types.js';
import { ProtocolError, ProtocolErrorCode as E, type Refusal, refuse } from './errors.js';
import { MAX_TIMEOUT_SECONDS } from './x402-codec.js';

export interface Eip712Domain {
  readonly name: string;
  readonly version: string;
  readonly chainId: number;
  readonly verifyingContract: string;
}

/** What the seller expects, from its own config. Nothing here comes from the payer. */
export interface PinnedOffer {
  readonly chainId: number;
  readonly asset: string;
  readonly domain: Eip712Domain;
  readonly payTo: string;
  readonly amount: bigint;
  readonly maxWindowS: number;
  /** Least validity left at verify time, so settlement can land before validBefore. Default 30 s. */
  readonly minRemainingS?: number;
  /** For MPP: `challengeNonce(challengeId)`. Binds the authorization to one challenge. */
  readonly expectedNonce?: string;
}

/**
 * Thrown by an `Eip3009Rpc.call` when the call executed and reverted. Every other error is
 * treated as the RPC being unavailable (retryable); a revert is an answer (not retryable).
 */
export class RpcRevertError extends Error {
  constructor(options?: { readonly cause?: unknown }) {
    super('eth_call reverted', options);
    this.name = 'RpcRevertError';
  }
}

/** The two RPC reads the verifier needs. Errors must throw; the verifier then fails closed. */
export interface Eip3009Rpc {
  getCode(address: string): Promise<Hex>;
  /** `from` sets msg.sender, so a contract payer sees the same caller as at settlement. */
  call(req: { readonly to: string; readonly data: Hex; readonly gas?: bigint; readonly from?: string }): Promise<Hex>;
}

/**
 * A valid verdict proves only that the signature authorizes exactly this transfer.
 * It does NOT prove the payer is funded, unblacklisted, or that the nonce is unused or
 * uncancelled. Never deliver on it alone: claim, simulate, submit, and deliver only once
 * the Transfer log for `value` to `payTo` is confirmed.
 */
export type VerifyResult =
  | {
      readonly ok: true;
      readonly payer: string;
      readonly nonce: string;
      readonly value: bigint;
      readonly validAfter: bigint;
      readonly validBefore: bigint;
    }
  | Refusal;

export const ERC1271_MAGIC = '0x1626ba7e';
/** Enough for a Safe with a WebAuthn signer on a chain with the P-256 precompile. */
export const ERC1271_GAS_CAP = 300_000n;
export const DEFAULT_MIN_REMAINING_S = 30;
const MAX_UINT256 = 2n ** 256n - 1n;
/** EIP-7702 delegation designator. FiatToken would route such a payer through ERC-1271. */
const DELEGATION_PREFIX = '0xef0100';
const CODE = /^0x(?:[0-9a-fA-F]{2})*$/;
const DOMAIN_READ_GAS = 100_000n;
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^\d{1,78}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})+$/;

const ABI = parseAbi([
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
  'function eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])',
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
]);

interface Authorization {
  readonly from: string;
  readonly to: string;
  readonly value: bigint;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly nonce: Hex;
}

interface ParsedClaim {
  readonly chainId: number;
  readonly asset: string;
  readonly signature: Hex;
  readonly authorization: Authorization;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function assertPinned(p: PinnedOffer, nowSec: number): void {
  if (!Number.isSafeInteger(nowSec) || nowSec < 0) throw new ProtocolError(E.CONFIG_INVALID, 'nowSec must be whole unix seconds');
  // The default is checked too: a maxWindowS at or below it would refuse every payment.
  const minRemainingS = p.minRemainingS ?? DEFAULT_MIN_REMAINING_S;
  const valid =
    Number.isInteger(p.chainId) && p.chainId > 0 &&
    ADDRESS.test(p.asset) && ADDRESS.test(p.payTo) && p.amount > 0n &&
    Number.isInteger(p.maxWindowS) && p.maxWindowS >= 1 && p.maxWindowS <= MAX_TIMEOUT_SECONDS &&
    p.domain.chainId === p.chainId && sameAddress(p.domain.verifyingContract, p.asset) &&
    Number.isInteger(minRemainingS) && minRemainingS >= 0 && minRemainingS < p.maxWindowS &&
    (p.expectedNonce === undefined || BYTES32.test(p.expectedNonce));
  if (!valid) throw new ProtocolError(E.CONFIG_INVALID, 'pinned EIP-3009 offer is invalid');
}

function parseClaim(claim: unknown): ParsedClaim | undefined {
  if (!isObject(claim) || !isObject(claim.authorization)) return undefined;
  const a = claim.authorization;
  const shapeOk =
    Number.isSafeInteger(claim.chainId) && (claim.chainId as number) > 0 && typeof claim.asset === 'string' && ADDRESS.test(claim.asset) &&
    typeof claim.signature === 'string' && HEX_BYTES.test(claim.signature) &&
    typeof a.from === 'string' && ADDRESS.test(a.from) && typeof a.to === 'string' && ADDRESS.test(a.to) &&
    typeof a.value === 'string' && UINT.test(a.value) &&
    typeof a.validAfter === 'string' && UINT.test(a.validAfter) &&
    typeof a.validBefore === 'string' && UINT.test(a.validBefore) &&
    typeof a.nonce === 'string' && BYTES32.test(a.nonce);
  if (!shapeOk) return undefined;
  const uints = [a.value, a.validAfter, a.validBefore].map((v) => BigInt(v as string));
  if (uints.some((v) => v > MAX_UINT256)) return undefined;
  return {
    chainId: claim.chainId as number,
    asset: claim.asset as string,
    signature: claim.signature as Hex,
    authorization: {
      from: a.from as string, to: a.to as string, value: BigInt(a.value as string),
      validAfter: BigInt(a.validAfter as string), validBefore: BigInt(a.validBefore as string),
      nonce: (a.nonce as string).toLowerCase() as Hex,
    },
  };
}

/** Offer binding and validity window: everything that needs no cryptography or RPC. */
function checkTerms(c: ParsedClaim, p: PinnedOffer, nowSec: number): Refusal | undefined {
  const a = c.authorization;
  const now = BigInt(nowSec);
  if (c.chainId !== p.chainId) return refuse(E.CHAIN_MISMATCH);
  if (!sameAddress(c.asset, p.asset)) return refuse(E.ASSET_MISMATCH);
  if (!sameAddress(a.to, p.payTo)) return refuse(E.PAYTO_MISMATCH);
  if (a.value < p.amount) return refuse(E.UNDERPAID);
  if (a.value !== p.amount) return refuse(E.AMOUNT_MISMATCH);
  // FiatToken requires now > validAfter and now < validBefore at settlement.
  if (a.validAfter >= now) return refuse(E.NOT_YET_VALID);
  if (a.validBefore <= now) return refuse(E.EXPIRED);
  if (a.validBefore - now < BigInt(p.minRemainingS ?? DEFAULT_MIN_REMAINING_S)) return refuse(E.EXPIRES_TOO_SOON);
  if (a.validBefore - now > BigInt(p.maxWindowS)) return refuse(E.WINDOW_TOO_LONG);
  if (p.expectedNonce !== undefined && a.nonce !== p.expectedNonce.toLowerCase()) return refuse(E.NONCE_MISMATCH);
  return undefined;
}

function digest(a: Authorization, domain: Eip712Domain): Hex {
  return hashTypedData({
    domain: { ...domain, verifyingContract: domain.verifyingContract as Hex },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: { ...a, from: a.from as Hex, to: a.to as Hex },
  });
}

const ECDSA_HEX_LENGTH = 2 + 65 * 2;

/**
 * Mirrors FiatToken's ECRecover: 65 bytes, v ∈ {27, 28}, s in the lower half order.
 * A longer, contract-style signature from an address with no code (e.g. an undeployed
 * Safe) is PAYER_NO_CODE; any other length is MALFORMED.
 */
async function checkEcdsa(hash: Hex, signature: Hex, from: string): Promise<Refusal | undefined> {
  if (signature.length > ECDSA_HEX_LENGTH) return refuse(E.PAYER_NO_CODE);
  if (signature.length !== ECDSA_HEX_LENGTH) return refuse(E.MALFORMED);
  const v = Number.parseInt(signature.slice(130, 132), 16);
  if (v !== 27 && v !== 28) return refuse(E.MALFORMED);
  if (BigInt(`0x${signature.slice(66, 130)}`) > SECP256K1_HALF_N) return refuse(E.HIGH_S);
  try {
    const signer = await recoverAddress({ hash, signature });
    return sameAddress(signer, from) ? undefined : refuse(E.BAD_SIGNATURE);
  } catch {
    return refuse(E.BAD_SIGNATURE);
  }
}

async function checkErc1271(
  hash: Hex, signature: Hex, from: string, asset: string, rpc: Eip3009Rpc,
): Promise<Refusal | undefined> {
  const data = encodeFunctionData({ abi: ABI, functionName: 'isValidSignature', args: [hash, signature] });
  let result: Hex;
  try {
    result = await rpc.call({ to: from, data, gas: ERC1271_GAS_CAP, from: asset });
  } catch (error) {
    // A contract wallet rejects a bad signature by reverting: that is an answer, not an outage.
    return refuse(error instanceof RpcRevertError ? E.BAD_SIGNATURE : E.RPC_UNAVAILABLE);
  }
  return result.toLowerCase() === `${ERC1271_MAGIC}${'0'.repeat(56)}` ? undefined : refuse(E.BAD_SIGNATURE);
}

/**
 * Verify an EIP-3009 TransferWithAuthorization against the seller's pinned offer.
 * Like FiatToken v2.2, a payer with code is checked only via ERC-1271 (gas-capped, called
 * as the token), and a payer without code only via ECDSA. EIP-7702-delegated payers are
 * refused: their code can change between verification and settlement. Any RPC error fails
 * closed. Callers should rate-limit before calling: `from` is attacker-chosen and costs RPC.
 */
export async function verifyEip3009(
  claim: unknown, pinned: PinnedOffer, nowSec: number, rpc: Eip3009Rpc,
): Promise<VerifyResult> {
  assertPinned(pinned, nowSec);
  const c = parseClaim(claim);
  if (!c) return refuse(E.MALFORMED);
  const termsRefusal = checkTerms(c, pinned, nowSec);
  if (termsRefusal) return termsRefusal;

  const a = c.authorization;
  let code: Hex;
  try {
    code = await rpc.getCode(a.from);
  } catch {
    return refuse(E.RPC_UNAVAILABLE);
  }
  if (!CODE.test(code)) return refuse(E.RPC_UNAVAILABLE);
  if (code.toLowerCase().startsWith(DELEGATION_PREFIX)) return refuse(E.PAYER_DELEGATED);
  const hash = digest(a, pinned.domain);
  const sigRefusal = code === '0x'
    ? await checkEcdsa(hash, c.signature, a.from)
    : await checkErc1271(hash, c.signature, a.from, pinned.asset, rpc);
  if (sigRefusal) return sigRefusal;
  return {
    ok: true, payer: getAddress(a.from), nonce: a.nonce,
    value: a.value, validAfter: a.validAfter, validBefore: a.validBefore,
  };
}

type Eip5267Domain = readonly [Hex, string, string, bigint, string, Hex, readonly bigint[]];

/** undefined = the token does not implement EIP-5267 (reverted or undecodable); throws if the RPC failed. */
async function readEip5267(asset: string, rpc: Eip3009Rpc): Promise<Eip5267Domain | undefined> {
  let raw: Hex;
  try {
    raw = await rpc.call({ to: asset, data: encodeFunctionData({ abi: ABI, functionName: 'eip712Domain' }), gas: DOMAIN_READ_GAS });
  } catch (error) {
    if (error instanceof RpcRevertError) return undefined;
    throw new ProtocolError(E.RPC_UNAVAILABLE, 'could not read eip712Domain()');
  }
  try {
    return decodeFunctionResult({ abi: ABI, functionName: 'eip712Domain', data: raw });
  } catch {
    return undefined;
  }
}

type LegacyGetter = 'name' | 'version' | 'DOMAIN_SEPARATOR';

/** A revert or an undecodable answer means the token lacks the getter (DOMAIN_MISMATCH); anything else is the RPC. */
async function readLegacy(asset: string, fn: LegacyGetter, rpc: Eip3009Rpc): Promise<string> {
  let raw: Hex;
  try {
    raw = await rpc.call({ to: asset, data: encodeFunctionData({ abi: ABI, functionName: fn }), gas: DOMAIN_READ_GAS });
  } catch (error) {
    if (error instanceof RpcRevertError) throw new ProtocolError(E.DOMAIN_MISMATCH, `token has no ${fn}()`);
    throw new ProtocolError(E.RPC_UNAVAILABLE, `could not read ${fn}()`);
  }
  try {
    return decodeFunctionResult({ abi: ABI, functionName: fn, data: raw });
  } catch {
    throw new ProtocolError(E.DOMAIN_MISMATCH, `token returned an undecodable ${fn}()`);
  }
}

/** FiatToken has no EIP-5267: read name()/version() and prove them against DOMAIN_SEPARATOR(). */
async function readLegacyDomain(chainId: number, asset: string, rpc: Eip3009Rpc): Promise<Eip712Domain> {
  const [name, version, onChain] = await Promise.all([
    readLegacy(asset, 'name', rpc), readLegacy(asset, 'version', rpc), readLegacy(asset, 'DOMAIN_SEPARATOR', rpc),
  ]);
  const domain: Eip712Domain = { name, version, chainId, verifyingContract: asset };
  const computed = domainSeparator({ domain: { ...domain, verifyingContract: asset as Hex } });
  if (computed !== onChain) throw new ProtocolError(E.DOMAIN_MISMATCH, 'DOMAIN_SEPARATOR does not match name()/version()');
  return domain;
}

/**
 * The EIP-712 domain for an asset: from config when pinned, else from the chain. Never from
 * the payer. Falls back to the FiatToken getters only when EIP-5267 is absent, never on an
 * RPC failure. Only a domain without salt or extensions (fields 0x0f) is accepted.
 */
export async function resolveDomain(
  input: { readonly chainId: number; readonly asset: string; readonly pinned?: { readonly name: string; readonly version: string } },
  rpc: Eip3009Rpc,
): Promise<Eip712Domain> {
  const { chainId, asset, pinned } = input;
  if (pinned) return { name: pinned.name, version: pinned.version, chainId, verifyingContract: asset };
  const eip5267 = await readEip5267(asset, rpc);
  if (!eip5267) return readLegacyDomain(chainId, asset, rpc);
  const [fields, name, version, onChainId, contract] = eip5267;
  if (fields !== '0x0f' || onChainId !== BigInt(chainId) || !sameAddress(contract, asset)) {
    throw new ProtocolError(E.DOMAIN_MISMATCH, 'eip712Domain() does not match the expected chain and contract');
  }
  return { name, version, chainId, verifyingContract: asset };
}

interface ViemLikeClient {
  getCode(args: { address: Hex }): Promise<Hex | undefined>;
  call(args: { to: Hex; data: Hex; gas?: bigint; account?: Hex }): Promise<{ data?: Hex }>;
}

/** Adapts a viem PublicClient to the verifier's RPC port. */
export function viemRpc(client: ViemLikeClient): Eip3009Rpc {
  return {
    async getCode(address) {
      return (await client.getCode({ address: address as Hex })) ?? '0x';
    },
    async call({ to, data, gas, from }) {
      try {
        const res = await client.call({
          to: to as Hex, data, ...(gas !== undefined ? { gas } : {}), ...(from !== undefined ? { account: from as Hex } : {}),
        });
        return res.data ?? '0x';
      } catch (error) {
        if (error instanceof BaseError && error.walk((e) => e instanceof ExecutionRevertedError)) {
          throw new RpcRevertError({ cause: error });
        }
        throw error;
      }
    },
  };
}
